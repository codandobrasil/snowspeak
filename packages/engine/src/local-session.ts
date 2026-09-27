import type { Channel, EngineMessage, ServerEvent, ServerEventBody, SessionEndReason } from "@snowspeak/shared";
import { ChannelPipeline, type ChannelStats } from "./channel-pipeline";
import { LatencyStats, formatLatency } from "./latency";
import type { SttFactory } from "./stt/types";
import type { Suggester } from "./suggest/openrouter";
import { SuggestionEngine, type SuggestionSettings } from "./suggest/suggestion-engine";

export interface LocalSessionDeps {
  sttFactory: SttFactory;
  /** null: sem chave do OpenRouter, a sessão não gera sugestões. */
  suggester: Suggester | null;
  onMessage: (message: EngineMessage) => void;
  now?: () => number;
}

interface FrameCounters {
  frameSeq: number;
  sampleOffset: number;
}

const NO_STATS: ChannelStats = { sentFrames: 0, droppedFrames: 0 };

// A sessão inteira, dentro do offscreen: áudio → Deepgram → falas e frases → sugestões.
export class LocalSession {
  readonly id = crypto.randomUUID();
  private seq = 0;
  private started = false;
  private stopping = false;
  private closed = false;
  private cancelStart: (() => void) | null = null;
  private settings: SuggestionSettings;
  private readonly now: () => number;
  private readonly sttLatency = new LatencyStats();
  private readonly engine: SuggestionEngine | null;
  private readonly pipelines: Partial<Record<Channel, ChannelPipeline>> = {};
  private readonly counters: Record<Channel, FrameCounters> = { them: { frameSeq: 0, sampleOffset: 0 }, me: { frameSeq: 0, sampleOffset: 0 } };

  constructor(
    private readonly deps: LocalSessionDeps,
    settings: SuggestionSettings,
  ) {
    this.now = deps.now ?? Date.now;
    this.settings = { ...settings };
    this.engine = deps.suggester
      ? new SuggestionEngine({
          suggester: deps.suggester,
          emit: (body) => this.emit(body),
          settings: () => ({ ...this.settings }),
          now: this.now,
        })
      : null;
  }

  /**
   * Abre o Deepgram dos participantes e anuncia a sessão; rejeita se essa primeira conexão falhar
   * (chave errada ou rede fora) ou se a sessão for fechada antes. O microfone abre depois e, se falhar,
   * entra em reconexão sem derrubar a sessão.
   */
  async start(): Promise<void> {
    const them = this.createPipeline("them", false);
    this.pipelines.them = them;
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.cancelStart = () => reject(new Error("sessão encerrada antes de começar"));
    });
    try {
      await Promise.race([them.firstOpen, cancelled]);
    } catch (error) {
      this.close("error");
      throw error;
    } finally {
      this.cancelStart = null;
    }
    this.started = true;
    this.deps.onMessage({ v: 1, type: "session.started", sessionId: this.id });
    this.pipelines.me = this.createPipeline("me", true);
  }

  acceptPcm(channel: Channel, pcm: Uint8Array): void {
    const pipeline = this.pipelines[channel];
    if (!this.started || this.stopping || this.closed || !pipeline) return;
    const counters = this.counters[channel];
    pipeline.acceptFrame({ channel, frameSeq: counters.frameSeq, sampleOffset: counters.sampleOffset, pcm });
    counters.frameSeq += 1;
    counters.sampleOffset += pcm.byteLength / 2;
  }

  stats(): Record<Channel, ChannelStats> {
    return { them: this.pipelines.them?.stats() ?? NO_STATS, me: this.pipelines.me?.stats() ?? NO_STATS };
  }

  /** Modo, contexto, currículo e vaga valem para as próximas sugestões. */
  update(changes: Partial<SuggestionSettings>): void {
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    this.settings = { ...this.settings, ...defined };
  }

  requestSuggestion(requestId: string, question?: { utteranceId: string; text: string }): void {
    this.engine?.request(requestId, question);
  }

  /** Início do Parar: a conversa segue sendo registrada, mas sem áudio novo nem sugestões novas. */
  beginStop(): void {
    this.stopping = true;
    this.engine?.stopAccepting();
  }

  async drain(): Promise<void> {
    await Promise.all(Object.values(this.pipelines).map((pipeline) => pipeline.drain()));
  }

  close(reason: SessionEndReason): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelStart?.();
    // A sugestão cancelada é avisada antes do fim da sessão.
    this.engine?.close();
    for (const pipeline of Object.values(this.pipelines)) pipeline.close();
    if (!this.started) return;
    this.deps.onMessage({ v: 1, type: "session.ended", sessionId: this.id, reason });
    console.info(`sessão ${this.id.slice(0, 8)} encerrada · ${formatLatency("latência estimada do STT (segmento final)", this.sttLatency)}`);
  }

  private createPipeline(channel: Channel, retryBeforeFirstOpen: boolean): ChannelPipeline {
    return new ChannelPipeline({
      channel,
      sttFactory: this.deps.sttFactory,
      splitSentences: channel === "them",
      emit: (body) => this.emit(body),
      sttLatency: this.sttLatency,
      now: this.now,
      onUtterance: (utterance) => this.engine?.addUtterance(utterance),
      retryBeforeFirstOpen,
    });
  }

  private emit(body: ServerEventBody): void {
    this.seq += 1;
    this.deps.onMessage({ v: 1, sessionId: this.id, seq: this.seq, ts: this.now(), ...body } as ServerEvent);
  }
}
