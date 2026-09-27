import { isFillerOnly, type Channel, type EngineEventBody, type Mode, type ResponseLength, type SuggestionErrorCode, type SuggestionTrigger } from "@snowspeak/shared";
import { SuggesterAuthError, type Suggester } from "./openrouter";
import { buildSuggestionMessages, type TranscriptLine } from "./prompt";
import { TagStreamParser } from "./tag-stream";

export const SUGGESTION_TIMEOUT_MS = 15_000;
export const MANUAL_MIN_INTERVAL_MS = 2_000;
export const MAX_TRANSCRIPT = 40;

export interface SuggestionSettings {
  mode: Mode;
  context: string;
  profile: string;
  job: string;
  responseLength: ResponseLength;
}

export interface SuggestionEngineDeps {
  suggester: Suggester;
  emit: (body: EngineEventBody) => void;
  settings: () => SuggestionSettings;
  now?: () => number;
  timeoutMs?: number;
}

interface Generation {
  requestId: string;
  trigger: SuggestionTrigger;
  controller: AbortController;
  /** Motivo do cancelamento, quando cancelada por nós. */
  reason: "cancelled" | "timeout" | null;
  /** O erro já foi emitido (fim da sessão avisa na hora, antes de session.ended). */
  reported: boolean;
}

export class SuggestionEngine {
  private readonly transcript: Array<TranscriptLine & { utteranceId: string }> = [];
  private readonly seen = new Set<string>();
  private inflight: Generation | null = null;
  private lastManualAt = Number.NEGATIVE_INFINITY;
  private closed = false;
  // Durante o Parar a conversa ainda é registrada, mas nenhuma sugestão nova começa.
  private accepting = true;

  constructor(private readonly deps: SuggestionEngineDeps) {}

  /** Registra a fala na conversa; a sugestão só sai quando o usuário pede (clique, botão ou Alt+S). */
  addUtterance(utterance: { channel: Channel; utteranceId: string; text: string; interrupted: boolean }): void {
    // Interjeições ("hmm", "uh-huh", "claro") não são falas a responder nem contexto útil.
    if (this.closed || !utterance.text.trim() || isFillerOnly(utterance.text)) return;
    this.transcript.push({ channel: utterance.channel, text: utterance.text.trim(), utteranceId: utterance.utteranceId });
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.shift();
  }

  /** Pedido do usuário; com `question`, responde à pergunta escolhida no painel em vez da última. */
  request(requestId: string, question?: { utteranceId: string; text: string }): void {
    if (this.closed || !this.accepting || this.seen.has(requestId)) return;
    if (this.inflight?.trigger === "manual") {
      this.seen.add(requestId);
      this.deps.emit({ type: "suggestion.error", requestId, code: "busy" });
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    if (now - this.lastManualAt < MANUAL_MIN_INTERVAL_MS) {
      this.seen.add(requestId);
      this.deps.emit({ type: "suggestion.error", requestId, code: "rate_limited" });
      return;
    }
    this.lastManualAt = now;
    if (question) {
      this.start(requestId, "manual", question.utteranceId, question);
      return;
    }
    const lastThem = [...this.transcript].reverse().find((line) => line.channel === "them");
    this.start(requestId, "manual", lastThem?.utteranceId ?? null);
  }

  /** O usuário clicou em Parar: nada de sugestão nova (evita chamada paga que seria cancelada em seguida). */
  stopAccepting(): void {
    this.accepting = false;
  }

  close(): void {
    this.closed = true;
    const generation = this.inflight;
    if (!generation) return;
    generation.reason = "cancelled";
    generation.reported = true;
    this.deps.emit({ type: "suggestion.error", requestId: generation.requestId, code: "cancelled" });
    generation.controller.abort(new Error("cancelled"));
  }

  private cancel(reason: "cancelled" | "timeout"): void {
    const generation = this.inflight;
    if (!generation) return;
    generation.reason = reason;
    generation.controller.abort(new Error(reason));
  }

  private start(requestId: string, trigger: SuggestionTrigger, basedOnUtteranceId: string | null, question?: { utteranceId: string; text: string }): void {
    this.cancel("cancelled");
    this.seen.add(requestId);
    const generation: Generation = { requestId, trigger, controller: new AbortController(), reason: null, reported: false };
    this.inflight = generation;
    this.deps.emit({ type: "suggestion.started", requestId, trigger, basedOnUtteranceId });

    // Congela contexto e conversa no instante do pedido.
    // Pergunta escolhida ainda na janela: a conversa vai só até ela; fora da janela, vai a conversa recente.
    const index = question ? this.transcript.findIndex((line) => line.utteranceId === question.utteranceId) : -1;
    const lines = index >= 0 ? this.transcript.slice(0, index + 1) : this.transcript;
    const messages = buildSuggestionMessages({
      ...this.deps.settings(),
      transcript: lines.map(({ channel, text }) => ({ channel, text })),
      question: question?.text,
    });
    const timer = setTimeout(() => {
      if (this.inflight === generation) this.cancel("timeout");
    }, this.deps.timeoutMs ?? SUGGESTION_TIMEOUT_MS);

    void this.run(generation, messages).finally(() => {
      clearTimeout(timer);
      if (this.inflight === generation) this.inflight = null;
    });
  }

  private async run(generation: Generation, messages: ReturnType<typeof buildSuggestionMessages>): Promise<void> {
    const { requestId } = generation;
    const parser = new TagStreamParser();
    const fail = (code: SuggestionErrorCode): void => this.deps.emit({ type: "suggestion.error", requestId, code });
    try {
      for await (const chunk of this.deps.suggester.stream(messages, generation.controller.signal)) {
        if (generation.reason) break;
        for (const delta of parser.push(chunk)) this.deps.emit({ type: "suggestion.delta", requestId, ...delta });
      }
    } catch (error) {
      if (!generation.reason) {
        console.warn(`sugestão falhou: ${error instanceof Error ? error.message : String(error)}`);
        fail(error instanceof SuggesterAuthError ? "unauthorized" : "provider");
        return;
      }
    }
    if (generation.reason) {
      if (!generation.reported) fail(generation.reason);
      return;
    }
    const { en, pt } = parser.result();
    if (!en || !pt) {
      fail("invalid_output");
      return;
    }
    this.deps.emit({ type: "suggestion.done", requestId, en, pt });
  }
}
