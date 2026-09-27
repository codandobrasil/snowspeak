import type { ChannelStats } from "@snowspeak/engine";
import type { Channel, EngineMessage, Mode, ResponseLength, SessionEndReason } from "@snowspeak/shared";
import type { SessionStore } from "./session-store";

export const STATS_INTERVAL_MS = 500;
// O offscreen não exibe pedido de permissão; se o getUserMedia do microfone ficar pendente, segue sem ele.
export const MIC_CAPTURE_TIMEOUT_MS = 3_000;
// Parar espera o Deepgram entregar as últimas falas; depois disso fecha mesmo assim.
export const STOP_TIMEOUT_MS = 3_000;

export const DEEPGRAM_UNAVAILABLE_MESSAGE = "Não foi possível conectar ao Deepgram. Confira a chave em Configurações.";
export const TAB_CAPTURE_ENDED_MESSAGE = "A captura da aba terminou (aba fechada ou compartilhamento encerrado).";

export interface StartParams {
  streamId: string;
  deepgramKey: string;
  /** Vazia: sessão sem sugestões. */
  openRouterKey: string;
  suggestionModel: string;
  responseLength: ResponseLength;
  /** Botão Sugestões: desligado, nenhum pedido vai ao OpenRouter. */
  suggestionsOn: boolean;
  mode: Mode;
  context: string;
  profile: string;
  job: string;
}

/** Pergunta que o usuário escolheu no painel. */
export interface SuggestionQuestion {
  utteranceId: string;
  text: string;
}

/** Campos que podem mudar durante a sessão (valem para as próximas sugestões). */
export type SessionSettingsChanges = Partial<Pick<StartParams, "mode" | "context" | "profile" | "job" | "responseLength">>;

export interface ChannelCapture {
  stop(): void;
}

export interface CaptureCallbacks {
  onFrame(channel: Channel, pcm: ArrayBuffer): void;
  onLevel(channel: Channel, rms: number): void;
  /** A trilha terminou por fora (aba fechada, compartilhamento encerrado, microfone desconectado). */
  onEnded(channel: Channel): void;
}

/** A sessão do motor (LocalSession no offscreen; uma versão falsa nos testes). */
export interface EngineSession {
  /** Resolve quando o Deepgram dos participantes abre; rejeita se ele recusar ou se a sessão fechar antes. */
  start(): Promise<void>;
  acceptPcm(channel: Channel, pcm: Uint8Array): void;
  stats(): Record<Channel, ChannelStats>;
  update(changes: SessionSettingsChanges): void;
  requestSuggestion(requestId: string, question?: SuggestionQuestion): void;
  beginStop(): void;
  drain(): Promise<void>;
  close(reason: SessionEndReason): void;
}

export interface ControllerDeps {
  store: SessionStore;
  captureTab(streamId: string, cb: CaptureCallbacks): Promise<ChannelCapture>;
  captureMic(cb: CaptureCallbacks): Promise<ChannelCapture>;
  /** Cria a sessão com as chaves de `params`; as mensagens dela chegam por `onMessage`. */
  createSession(params: StartParams, onMessage: (message: EngineMessage) => void): EngineSession;
  /** Recebe cada mensagem do motor depois que ela foi aplicada ao store (ex.: fila de tradução). */
  onEngineMessage?: (message: EngineMessage) => void;
  /** Gera o requestId de cada pedido de sugestão (padrão: crypto.randomUUID). */
  newRequestId?: () => string;
}

interface Run {
  params: StartParams;
  tab: ChannelCapture | null;
  mic: ChannelCapture | null;
  session: EngineSession | null;
  /** O Deepgram dos participantes abriu: o áudio e os pedidos podem ir à sessão. */
  live: boolean;
  statsTimer: ReturnType<typeof setInterval> | null;
  stopping: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** Microfone desligado pelo usuário: nada do canal "me" vai ao Deepgram. */
  micMuted: boolean;
  suggestionsOn: boolean;
}

/** Rejeita após `ms`; uma captura que chegue depois do prazo é parada imediatamente. */
function captureWithTimeout(capture: Promise<ChannelCapture>, ms: number): Promise<ChannelCapture> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("tempo esgotado"));
    }, ms);
    capture.then(
      (result) => {
        if (settled) {
          result.stop();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionController {
  private running: Run | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  async start(params: StartParams): Promise<void> {
    if (this.running) return;
    const run: Run = {
      params,
      tab: null,
      mic: null,
      session: null,
      live: false,
      statsTimer: null,
      stopping: false,
      stopTimer: null,
      micMuted: false,
      suggestionsOn: params.suggestionsOn,
    };
    this.running = run;
    this.deps.store.dispatch({ type: "starting", suggestionsEnabled: params.openRouterKey !== "", suggestionsOn: params.suggestionsOn });

    const callbacks: CaptureCallbacks = {
      onFrame: (channel, pcm) => {
        if (channel === "me" && run.micMuted) return;
        if (run.live && !run.stopping) run.session?.acceptPcm(channel, new Uint8Array(pcm));
      },
      onLevel: (channel, rms) => {
        if (channel === "me" && run.micMuted) return;
        if (this.running === run) this.deps.store.dispatch({ type: "level", channel, rms });
      },
      onEnded: (channel) => this.onCaptureEnded(run, channel),
    };

    let tab: ChannelCapture;
    try {
      tab = await this.deps.captureTab(params.streamId, callbacks);
    } catch (error) {
      if (this.running === run) this.fail(run, `Não foi possível capturar o áudio da aba: ${errorText(error)}`);
      return;
    }
    if (this.running !== run) {
      tab.stop();
      return;
    }
    run.tab = tab;

    let mic: ChannelCapture | null = null;
    try {
      mic = await captureWithTimeout(this.deps.captureMic(callbacks), MIC_CAPTURE_TIMEOUT_MS);
    } catch {
      mic = null;
    }
    if (this.running !== run) {
      mic?.stop();
      return;
    }
    run.mic = mic;
    this.deps.store.dispatch({ type: "mic", status: mic ? "active" : "denied" });

    const session = this.deps.createSession(params, (message) => this.onEngineMessage(run, message));
    run.session = session;
    try {
      await session.start();
    } catch (error) {
      // Parar durante a conexão também rejeita o start; aí a execução já foi liberada.
      if (this.running !== run) return;
      console.warn(`Deepgram não abriu: ${errorText(error)}`);
      this.fail(run, DEEPGRAM_UNAVAILABLE_MESSAGE);
      return;
    }
    if (this.running !== run) return;
    run.live = true;
    run.statsTimer = setInterval(() => {
      if (run.session) this.deps.store.dispatch({ type: "stats", stats: run.session.stats() });
    }, STATS_INTERVAL_MS);
  }

  /** Pede uma sugestão de resposta (para a pergunta escolhida, se houver); sem sessão rodando, não faz nada. */
  requestSuggestion(question?: SuggestionQuestion): void {
    const run = this.running;
    if (!run?.live || run.stopping || !run.session || !run.suggestionsOn) return;
    const requestId = (this.deps.newRequestId ?? (() => crypto.randomUUID()))();
    run.session.requestSuggestion(requestId, question);
  }

  /** Liga ou desliga o envio do microfone; o microfone continua aberto para religar na hora. */
  setMicMuted(muted: boolean): void {
    const run = this.running;
    if (!run || run.stopping) return;
    run.micMuted = muted;
    this.deps.store.dispatch({ type: "mic-muted", muted });
  }

  /** Botão Sugestões: desligado, cliques, botão e Alt+S não pedem nada. */
  setSuggestionsOn(on: boolean): void {
    const run = this.running;
    if (!run || run.stopping) return;
    run.suggestionsOn = on;
    this.deps.store.dispatch({ type: "suggestions-on", on });
  }

  /** Mudanças de modo, contexto, currículo, vaga ou tamanho da resposta durante a sessão. */
  update(changes: SessionSettingsChanges): void {
    const run = this.running;
    if (!run?.live || run.stopping || !run.session) return;
    run.session.update(changes);
  }

  stop(): void {
    const run = this.running;
    if (!run || run.stopping) return;
    if (!run.live || !run.session) {
      // Ainda capturando ou conectando ao Deepgram: não há falas a finalizar.
      this.release(run, "stopped");
      this.deps.store.dispatch({ type: "stopped" });
      return;
    }
    // Para de capturar, mas deixa o Deepgram entregar as últimas falas antes de encerrar.
    run.stopping = true;
    const session = run.session;
    this.releaseCaptures(run);
    session.beginStop();
    this.deps.store.dispatch({ type: "stopping" });
    const deadline = new Promise<void>((resolve) => {
      run.stopTimer = setTimeout(resolve, STOP_TIMEOUT_MS);
    });
    void Promise.race([session.drain(), deadline]).then(() => {
      if (this.running !== run) return;
      this.release(run, "stopped");
      this.deps.store.dispatch({ type: "stopped" });
    });
  }

  private onEngineMessage(run: Run, message: EngineMessage): void {
    if (this.running !== run) return;
    this.deps.store.dispatch({ type: "engine", message });
    this.deps.onEngineMessage?.(message);
  }

  private onCaptureEnded(run: Run, channel: Channel): void {
    if (this.running !== run || run.stopping) return;
    if (channel === "them") {
      this.fail(run, TAB_CAPTURE_ENDED_MESSAGE);
      return;
    }
    run.mic?.stop();
    run.mic = null;
    this.deps.store.dispatch({ type: "mic", status: "denied" });
  }

  private fail(run: Run, message: string): void {
    this.release(run, "error");
    this.deps.store.dispatch({ type: "failed", message });
  }

  private releaseCaptures(run: Run): void {
    if (run.statsTimer) clearInterval(run.statsTimer);
    run.statsTimer = null;
    run.tab?.stop();
    run.tab = null;
    run.mic?.stop();
    run.mic = null;
  }

  private release(run: Run, reason: SessionEndReason): void {
    if (run.stopTimer) clearTimeout(run.stopTimer);
    run.stopTimer = null;
    run.live = false;
    this.releaseCaptures(run);
    const session = run.session;
    run.session = null;
    // Com a execução ainda ativa: o fim da sessão (e a sugestão cancelada) chegam ao store.
    session?.close(reason);
    if (this.running === run) this.running = null;
  }
}
