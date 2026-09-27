import { SAMPLE_RATE, frameSamples, samplesToMs, type AudioFrame, type Channel, type EngineEventBody } from "@snowspeak/shared";
import { ChannelSequencer } from "./channel-sequencer";
import { ForwardClock } from "./forward-clock";
import type { LatencyStats } from "./latency";
import { SentenceSplitter } from "./sentence-splitter";
import type { SttFactory, SttResult, SttStream } from "./stt/types";
import { UtteranceAssembler, type AssemblerOutput } from "./utterance-assembler";

export const FINALIZE_WAIT_MS = 500;
// Queda do Deepgram no meio da sessão: novas tentativas com espera crescente, por até 60 s contados da queda.
export const STT_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
export const STT_RECONNECT_WINDOW_MS = 60_000;

export interface ChannelStats {
  /** Frames entregues ao STT. */
  sentFrames: number;
  /** Frames descartados (conexão congestionada ou STT fora durante uma queda). */
  droppedFrames: number;
}

export interface ChannelPipelineDeps {
  channel: Channel;
  sttFactory: SttFactory;
  /** Canal them: divide as falas em frases para a tradução. */
  splitSentences: boolean;
  emit: (body: EngineEventBody) => void;
  sttLatency: LatencyStats;
  now: () => number;
  /** Cada fala encerrada, com o texto completo (ex.: para sugestões de resposta). */
  onUtterance?: (utterance: { channel: Channel; utteranceId: string; text: string; interrupted: boolean }) => void;
  /**
   * Falha antes da primeira abertura: false rejeita `firstOpen` e não tenta de novo (quem criou decide);
   * true entra em reconexão como uma queda qualquer.
   */
  retryBeforeFirstOpen: boolean;
}

interface Reconnect {
  since: number;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Áudio recebido sem STT para onde ir; vira audio.gap quando a queda termina. */
  lostSamples: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Um canal de áudio: continuidade dos frames → STT → falas → frases.
export class ChannelPipeline {
  /** Resolve na primeira abertura do STT; rejeita se ela falhar sem retryBeforeFirstOpen. */
  readonly firstOpen: Promise<void>;
  private settleFirstOpen: { resolve(): void; reject(error: Error): void } | null = null;
  private readonly sequencer = new ChannelSequencer();
  private readonly assembler: UtteranceAssembler;
  private readonly splitter: SentenceSplitter | null;
  private clock = new ForwardClock();
  private closed = false;
  private everOpened = false;
  private stt: SttStream | null;
  private reconnect: Reconnect | null = null;
  private audioForwarded = false;
  private sentFrames = 0;
  private droppedFrames = 0;
  private onFinalizeSettled: (() => void) | null = null;
  private readonly utteranceSegments = new Map<string, string[]>();

  constructor(private readonly deps: ChannelPipelineDeps) {
    this.firstOpen = new Promise<void>((resolve, reject) => {
      this.settleFirstOpen = { resolve, reject };
    });
    // Quem não espera a abertura (canal "me") não deve gerar rejeição não tratada.
    this.firstOpen.catch(() => undefined);
    this.assembler = new UtteranceAssembler(deps.channel);
    this.splitter = deps.splitSentences
      ? new SentenceSplitter((sentence) =>
          deps.emit({
            type: "sentence.ready",
            channel: deps.channel,
            utteranceId: sentence.utteranceId,
            sentenceIdx: sentence.sentenceIdx,
            text: sentence.text,
          }),
        )
      : null;
    this.stt = this.openStt();
  }

  private openStt(): SttStream {
    // Só o stream atual fala com o montador: resultados atrasados de um stream já fechado
    // (ex.: Deepgram esvaziando depois de uma queda) têm tempos de outra linha do tempo.
    const stream: SttStream = this.deps.sttFactory(this.deps.channel, {
      onOpen: () => {
        if (this.stt === stream) this.onSttOpen();
      },
      onResult: (result) => {
        if (this.stt === stream) this.onSttResult(result);
      },
      onError: (error) => {
        if (this.stt === stream) this.onSttError(error);
      },
    });
    return stream;
  }

  acceptFrame(frame: AudioFrame): boolean {
    const result = this.sequencer.accept(frame.frameSeq, frame.sampleOffset, frameSamples(frame));
    if (!result.accepted) return false;
    if (result.gapSamples > 0) {
      this.deps.emit({ type: "audio.gap", channel: this.deps.channel, durationMs: samplesToMs(result.gapSamples), reason: "client_drop" });
    }
    if (!this.stt) {
      this.droppedFrames += 1;
      if (this.reconnect) this.reconnect.lostSamples += frameSamples(frame);
      return true;
    }
    const droppedBefore = this.stt.droppedFrames;
    this.stt.write(frame.pcm);
    // Só entra na linha do tempo do STT o que ele de fato recebeu.
    if (this.stt.droppedFrames === droppedBefore) {
      this.sentFrames += 1;
      this.clock.record(frameSamples(frame), this.deps.now());
      this.audioForwarded = true;
    } else {
      this.droppedFrames += 1;
    }
    return true;
  }

  stats(): ChannelStats {
    return { sentFrames: this.sentFrames, droppedFrames: this.droppedFrames };
  }

  /**
   * Parar: se algum áudio foi enviado, pede ao STT o que falta (Finalize) e espera até 500 ms pela
   * resposta; o que continuar aberto fecha como interrompido.
   */
  async drain(): Promise<void> {
    if (this.stt && this.audioForwarded) {
      const settled = new Promise<void>((resolve) => {
        this.onFinalizeSettled = resolve;
      });
      this.stt.finalize();
      await Promise.race([settled, delay(FINALIZE_WAIT_MS)]);
      this.onFinalizeSettled = null;
    }
    this.handleAll(this.assembler.forceClose());
  }

  close(): void {
    this.closed = true;
    if (this.reconnect?.timer) clearTimeout(this.reconnect.timer);
    this.reconnect = null;
    this.splitter?.dispose();
    this.stt?.close();
    this.stt = null;
  }

  private onSttOpen(): void {
    this.everOpened = true;
    this.settleFirstOpen?.resolve();
    this.settleFirstOpen = null;
    const reconnect = this.reconnect;
    if (!reconnect) return;
    this.reconnect = null;
    this.emitLost(reconnect);
    this.deps.emit({ type: "stt.status", channel: this.deps.channel, state: "ok" });
  }

  private onSttResult(result: SttResult): void {
    if (result.kind === "segment" && result.text) {
      const forwardedAt = this.clock.forwardedAt(Math.round(result.end * SAMPLE_RATE));
      if (forwardedAt !== null) this.deps.sttLatency.add(this.deps.now() - forwardedAt);
    }
    this.handleAll(this.assembler.push(result));
    if (result.kind === "segment" && result.fromFinalize) this.onFinalizeSettled?.();
  }

  private onSttError(error: Error): void {
    if (!this.stt) return;
    this.stt.close();
    this.stt = null;
    this.handleAll(this.assembler.forceClose());
    this.onFinalizeSettled?.();
    if (!this.everOpened && !this.deps.retryBeforeFirstOpen) {
      this.settleFirstOpen?.reject(error);
      this.settleFirstOpen = null;
      return;
    }
    console.warn(`STT do canal ${this.deps.channel} caiu: ${error.message}`);
    if (!this.reconnect) {
      this.reconnect = { since: this.deps.now(), attempt: 0, timer: null, lostSamples: 0 };
      this.deps.emit({ type: "stt.status", channel: this.deps.channel, state: "reconnecting" });
    }
    this.scheduleReconnect(this.reconnect);
  }

  private scheduleReconnect(reconnect: Reconnect): void {
    const wait = STT_RECONNECT_DELAYS_MS[Math.min(reconnect.attempt, STT_RECONNECT_DELAYS_MS.length - 1)] ?? STT_RECONNECT_DELAYS_MS[0]!;
    if (this.deps.now() + wait - reconnect.since > STT_RECONNECT_WINDOW_MS) {
      this.giveUp(reconnect);
      return;
    }
    reconnect.attempt += 1;
    reconnect.timer = setTimeout(() => {
      reconnect.timer = null;
      if (this.closed || this.reconnect !== reconnect) return;
      // Stream novo: a linha do tempo do provedor recomeça do zero; falas e frases seguem a numeração.
      this.clock = new ForwardClock();
      this.assembler.resetTimeline();
      this.audioForwarded = false;
      this.stt = this.openStt();
    }, wait);
  }

  private giveUp(reconnect: Reconnect): void {
    this.reconnect = null;
    this.emitLost(reconnect);
    this.deps.emit({
      type: "error",
      scope: "stt",
      code: "stt_connection_lost",
      retryable: false,
      channel: this.deps.channel,
      message: `A transcrição ${this.deps.channel === "them" ? "dos participantes" : "da sua voz"} parou: não foi possível reconectar ao Deepgram.`,
    });
  }

  private emitLost(reconnect: Reconnect): void {
    if (reconnect.lostSamples === 0) return;
    this.deps.emit({ type: "audio.gap", channel: this.deps.channel, durationMs: samplesToMs(reconnect.lostSamples), reason: "stt_unavailable" });
  }

  private handleAll(outputs: AssemblerOutput[]): void {
    for (const output of outputs) this.handle(output);
  }

  private handle(output: AssemblerOutput): void {
    this.deps.emit({ ...output, channel: this.deps.channel });
    if (output.type === "transcript.segment") {
      this.splitter?.addSegment(output.utteranceId, output.text);
      const segments = this.utteranceSegments.get(output.utteranceId) ?? [];
      segments.push(output.text);
      this.utteranceSegments.set(output.utteranceId, segments);
    }
    if (output.type === "utterance.end") {
      this.splitter?.endUtterance(output.utteranceId);
      const text = (this.utteranceSegments.get(output.utteranceId) ?? []).join(" ");
      this.utteranceSegments.delete(output.utteranceId);
      this.deps.onUtterance?.({ channel: this.deps.channel, utteranceId: output.utteranceId, text, interrupted: output.interrupted });
    }
  }
}
