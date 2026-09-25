import { randomBytes, randomUUID } from "node:crypto";
import type { AudioFrame, Channel, Mode, ServerEventBody, ServerMessage } from "@snowspeak/shared";
import { ChannelPipeline } from "./channel-pipeline";
import { LatencyStats, formatLatency } from "./latency";
import type { SttFactory } from "./stt/types";

export interface SessionDeps {
  sttFactory: SttFactory;
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

  constructor(
    private readonly deps: SessionDeps,
    readonly mode: Mode,
    readonly context: string,
  ) {
    const now = deps.now ?? Date.now;
    const pipeline = (channel: Channel): ChannelPipeline =>
      new ChannelPipeline({
        channel,
        sttFactory: deps.sttFactory,
        splitSentences: channel === "them",
        emit: (body) => this.emit(body),
        sttLatency: this.sttLatency,
        now,
      });
    this.pipelines = { them: pipeline("them"), me: pipeline("me") };
  }

  acceptFrame(frame: AudioFrame): boolean {
    return this.pipelines[frame.channel].acceptFrame(frame);
  }

  async drain(): Promise<void> {
    await Promise.all([this.pipelines.them.drain(), this.pipelines.me.drain()]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pipelines.them.close();
    this.pipelines.me.close();
    console.info(`sessão ${this.id.slice(0, 8)} encerrada · ${formatLatency("latência estimada do STT (segmento final)", this.sttLatency)}`);
  }

  private emit(body: ServerEventBody): void {
    this.seq += 1;
    this.deps.send({ v: 1, sessionId: this.id, seq: this.seq, ts: (this.deps.now ?? Date.now)(), ...body });
  }
}
