import { randomBytes, randomUUID } from "node:crypto";
import type { AudioFrame, Channel, ServerEvent, ServerEventBody, ServerMessage } from "@snowspeak/shared";
import { ChannelPipeline } from "./channel-pipeline";
import { EventBuffer } from "./event-buffer";
import { LatencyStats, formatLatency } from "./latency";
import type { SttFactory } from "./stt/types";
import type { Suggester } from "./suggest/openrouter";
import { SuggestionEngine, type SuggestionSettings } from "./suggest/suggestion-engine";

export interface SessionDeps {
  sttFactory: SttFactory;
  suggester: Suggester;
  now?: () => number;
  /** Tamanho do buffer de reposição (padrão: DEFAULT_EVENT_BUFFER_SIZE). */
  eventBufferSize?: number;
}

/** O socket ligado à sessão (no máximo um por vez). */
export interface SessionOwner {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export class Session {
  readonly id = randomUUID();
  readonly resumeToken = randomBytes(32).toString("base64url");
  private seq = 0;
  private closed = false;
  private currentOwner: SessionOwner | null = null;
  private readonly buffer: EventBuffer;
  // Suspensão dos canais depois de uma queda; a retomada só reabre o STT quando ela termina.
  private suspending: Promise<void> = Promise.resolve();
  private readonly sttLatency = new LatencyStats();
  private readonly pipelines: Record<Channel, ChannelPipeline>;
  private readonly engine: SuggestionEngine;
  private settings: SuggestionSettings;

  constructor(
    private readonly deps: SessionDeps,
    settings: SuggestionSettings,
    readonly accessKey: string,
  ) {
    this.buffer = new EventBuffer(deps.eventBufferSize);
    const now = deps.now ?? Date.now;
    this.settings = { ...settings };
    this.engine = new SuggestionEngine({
      suggester: deps.suggester,
      emit: (body) => this.emit(body),
      settings: () => ({ ...this.settings }),
      now,
    });
    const pipeline = (channel: Channel): ChannelPipeline =>
      new ChannelPipeline({
        channel,
        sttFactory: deps.sttFactory,
        splitSentences: channel === "them",
        emit: (body) => this.emit(body),
        sttLatency: this.sttLatency,
        now,
        onUtterance: (utterance) => this.engine.addUtterance(utterance),
      });
    this.pipelines = { them: pipeline("them"), me: pipeline("me") };
  }

  get owner(): SessionOwner | null {
    return this.currentOwner;
  }

  get throughSeq(): number {
    return this.seq;
  }

  /** Dono de uma sessão recém-criada. */
  attach(owner: SessionOwner): void {
    this.currentOwner = owner;
  }

  /** Queda do socket: a sessão continua; os canais entregam o que têm e desligam o STT. */
  detach(): void {
    if (!this.currentOwner) return;
    this.currentOwner = null;
    this.suspending = Promise.all([this.pipelines.them.suspend(), this.pipelines.me.suspend()]).then(() => undefined);
  }

  replayCheck(lastSeq: number): "ok" | "ahead" | "gap" {
    if (lastSeq > this.seq) return "ahead";
    return this.buffer.canReplayFrom(lastSeq) ? "ok" : "gap";
  }

  /** Retomada validada pelo gateway: repõe os eventos perdidos e passa a enviar para o novo dono. */
  resume(owner: SessionOwner, lastSeq: number): void {
    if (this.closed) return;
    owner.send({ v: 1, type: "session.resumed", sessionId: this.id, throughSeq: this.seq });
    for (const event of this.buffer.since(lastSeq)) owner.send(event);
    this.currentOwner = owner;
    void this.suspending.then(() => {
      if (this.closed || this.currentOwner !== owner) return;
      this.pipelines.them.reopenStt();
      this.pipelines.me.reopenStt();
    });
  }

  acceptFrame(frame: AudioFrame): boolean {
    return this.pipelines[frame.channel].acceptFrame(frame);
  }

  /** Modo, contexto, currículo e vaga valem para as próximas sugestões. */
  update(changes: Partial<SuggestionSettings>): void {
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    this.settings = { ...this.settings, ...defined };
  }

  /** Início do Parar: a conversa segue sendo registrada, mas sem novas sugestões. */
  beginStop(): void {
    this.engine.stopAccepting();
  }

  requestSuggestion(requestId: string, question?: { utteranceId: string; text: string }): void {
    this.engine.request(requestId, question);
  }

  async drain(): Promise<void> {
    await Promise.all([this.pipelines.them.drain(), this.pipelines.me.drain()]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.engine.close();
    this.pipelines.them.close();
    this.pipelines.me.close();
    // Só depois de avisar o cancelamento da sugestão ao dono atual.
    this.currentOwner = null;
    console.info(`sessão ${this.id.slice(0, 8)} encerrada · ${formatLatency("latência estimada do STT (segmento final)", this.sttLatency)}`);
  }

  private emit(body: ServerEventBody): void {
    this.seq += 1;
    const event = { v: 1, sessionId: this.id, seq: this.seq, ts: (this.deps.now ?? Date.now)(), ...body } as ServerEvent;
    this.buffer.add(event);
    this.currentOwner?.send(event);
  }
}
