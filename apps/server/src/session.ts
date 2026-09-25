import { randomBytes, randomUUID } from "node:crypto";
import {
  frameSamples,
  samplesToMs,
  type AudioFrame,
  type Channel,
  type Mode,
  type ServerEventBody,
  type ServerMessage,
} from "@snowspeak/shared";
import { ChannelSequencer } from "./channel-sequencer";
import type { SttFactory, SttResult, SttStream } from "./stt/types";

export interface SessionDeps {
  sttFactory: SttFactory;
  send: (message: ServerMessage) => void;
  now?: () => number;
}

export class Session {
  readonly id = randomUUID();
  readonly resumeToken = randomBytes(32).toString("base64url");
  private seq = 0;
  private readonly stt: Record<Channel, SttStream>;
  private readonly sequencers: Record<Channel, ChannelSequencer> = { them: new ChannelSequencer(), me: new ChannelSequencer() };

  constructor(
    private readonly deps: SessionDeps,
    readonly mode: Mode,
    readonly context: string,
  ) {
    this.stt = {
      them: deps.sttFactory("them", (result) => this.onSttResult("them", result)),
      me: deps.sttFactory("me", (result) => this.onSttResult("me", result)),
    };
  }

  /** Retorna false quando o frame é duplicado ou sobrepõe áudio já aceito. */
  acceptFrame(frame: AudioFrame): boolean {
    const result = this.sequencers[frame.channel].accept(frame.frameSeq, frame.sampleOffset, frameSamples(frame));
    if (!result.accepted) return false;
    if (result.gapSamples > 0) {
      this.emit({ type: "audio.gap", channel: frame.channel, durationMs: samplesToMs(result.gapSamples), reason: "client_drop" });
    }
    this.stt[frame.channel].write(frame.pcm);
    return true;
  }

  close(): void {
    this.stt.them.close();
    this.stt.me.close();
  }

  private onSttResult(channel: Channel, result: SttResult): void {
    this.emit({ type: "transcript.partial", channel, utteranceId: `${channel}-1`, text: result.text });
  }

  private emit(body: ServerEventBody): void {
    this.seq += 1;
    this.deps.send({ v: 1, sessionId: this.id, seq: this.seq, ts: (this.deps.now ?? Date.now)(), ...body });
  }
}
