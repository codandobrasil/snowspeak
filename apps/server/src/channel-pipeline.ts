import { SAMPLE_RATE, frameSamples, samplesToMs, type AudioFrame, type Channel, type ServerEventBody } from "@snowspeak/shared";
import { ChannelSequencer } from "./channel-sequencer";
import { ForwardClock } from "./forward-clock";
import type { LatencyStats } from "./latency";
import { SentenceSplitter } from "./sentence-splitter";
import type { SttFactory, SttResult, SttStream } from "./stt/types";
import { UtteranceAssembler, type AssemblerOutput } from "./utterance-assembler";

export const FINALIZE_WAIT_MS = 500;

export interface ChannelPipelineDeps {
  channel: Channel;
  sttFactory: SttFactory;
  /** Canal them: divide as falas em frases para o cliente traduzir. */
  splitSentences: boolean;
  emit: (body: ServerEventBody) => void;
  sttLatency: LatencyStats;
  now: () => number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Um canal de áudio: continuidade dos frames → STT → falas → frases.
export class ChannelPipeline {
  private readonly sequencer = new ChannelSequencer();
  private readonly assembler: UtteranceAssembler;
  private readonly splitter: SentenceSplitter | null;
  private readonly clock = new ForwardClock();
  private stt: SttStream | null;
  private audioForwarded = false;
  private onFinalizeSettled: (() => void) | null = null;

  constructor(private readonly deps: ChannelPipelineDeps) {
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
    this.stt = deps.sttFactory(deps.channel, {
      onResult: (result) => this.onSttResult(result),
      onError: (error) => this.onSttError(error),
    });
  }

  acceptFrame(frame: AudioFrame): boolean {
    const result = this.sequencer.accept(frame.frameSeq, frame.sampleOffset, frameSamples(frame));
    if (!result.accepted) return false;
    if (result.gapSamples > 0) {
      this.deps.emit({ type: "audio.gap", channel: this.deps.channel, durationMs: samplesToMs(result.gapSamples), reason: "client_drop" });
    }
    if (this.stt) {
      const droppedBefore = this.stt.droppedFrames;
      this.stt.write(frame.pcm);
      // Só entra na linha do tempo do STT o que ele de fato recebeu.
      if (this.stt.droppedFrames === droppedBefore) {
        this.clock.record(frameSamples(frame), this.deps.now());
        this.audioForwarded = true;
      }
    }
    return true;
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
    this.splitter?.dispose();
    this.stt?.close();
    this.stt = null;
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
    console.warn(`STT do canal ${this.deps.channel} parou: ${error.message}`);
    this.handleAll(this.assembler.forceClose());
    this.onFinalizeSettled?.();
    this.deps.emit({
      type: "error",
      scope: "stt",
      code: "stt_connection_lost",
      retryable: false,
      channel: this.deps.channel,
      message: `A transcrição ${this.deps.channel === "them" ? "dos participantes" : "da sua voz"} parou: a conexão com o provedor caiu.`,
    });
  }

  private handleAll(outputs: AssemblerOutput[]): void {
    for (const output of outputs) this.handle(output);
  }

  private handle(output: AssemblerOutput): void {
    this.deps.emit({ ...output, channel: this.deps.channel });
    if (output.type === "transcript.segment") this.splitter?.addSegment(output.utteranceId, output.text);
    if (output.type === "utterance.end") this.splitter?.endUtterance(output.utteranceId);
  }
}
