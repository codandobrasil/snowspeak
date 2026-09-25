import { randomBytes, randomUUID } from "node:crypto";
import type { AudioFrame, Channel, ServerEventBody, ServerMessage } from "@snowspeak/shared";
import { ChannelPipeline } from "./channel-pipeline";
import { LatencyStats, formatLatency } from "./latency";
import type { SttFactory } from "./stt/types";
import type { Suggester } from "./suggest/openrouter";
import { SuggestionEngine, type SuggestionSettings } from "./suggest/suggestion-engine";

export interface SessionDeps {
  sttFactory: SttFactory;
  suggester: Suggester;
  send: (message: ServerMessage) => void;
  now?: () => number;
}

export class Session {
  readonly id = randomUUID();
  readonly resumeToken = randomBytes(32).toString("base64url");
  private seq = 0;
  private closed = false;
  private readonly sttLatency = new LatencyStats();
  private readonly pipelines: Record<Channel, ChannelPipeline>;
  private readonly engine: SuggestionEngine;
  private settings: SuggestionSettings;

  constructor(
    private readonly deps: SessionDeps,
    settings: SuggestionSettings,
  ) {
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

  acceptFrame(frame: AudioFrame): boolean {
    return this.pipelines[frame.channel].acceptFrame(frame);
  }

  /** Modo, contexto, currículo e vaga valem para as próximas sugestões. */
  update(changes: Partial<SuggestionSettings>): void {
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    this.settings = { ...this.settings, ...defined };
  }

  requestSuggestion(requestId: string): void {
    this.engine.request(requestId);
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
    console.info(`sessão ${this.id.slice(0, 8)} encerrada · ${formatLatency("latência estimada do STT (segmento final)", this.sttLatency)}`);
  }

  private emit(body: ServerEventBody): void {
    this.seq += 1;
    this.deps.send({ v: 1, sessionId: this.id, seq: this.seq, ts: (this.deps.now ?? Date.now)(), ...body });
  }
}
