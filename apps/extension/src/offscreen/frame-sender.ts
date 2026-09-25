import { encodeFrame, type Channel } from "@snowspeak/shared";

// ~0,5 s de áudio dos dois canais; acima disso o frame é descartado em vez de enfileirado.
export const MAX_BUFFERED_BYTES = 32 * 1024;

export interface FrameSink {
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
  send(data: ArrayBuffer): void;
}

export interface ChannelStats {
  sentFrames: number;
  droppedFrames: number;
}

interface ChannelCounters extends ChannelStats {
  frameSeq: number;
  sampleOffset: number;
}

function freshCounters(): ChannelCounters {
  return { frameSeq: 0, sampleOffset: 0, sentFrames: 0, droppedFrames: 0 };
}

export class FrameSender {
  private readonly counters: Record<Channel, ChannelCounters> = { them: freshCounters(), me: freshCounters() };

  constructor(private readonly sink: FrameSink) {}

  push(channel: Channel, pcm: ArrayBuffer): void {
    const counters = this.counters[channel];
    if (this.sink.isOpen && this.sink.bufferedAmount <= MAX_BUFFERED_BYTES) {
      this.sink.send(
        encodeFrame({ channel, frameSeq: counters.frameSeq, sampleOffset: counters.sampleOffset, pcm: new Uint8Array(pcm) }),
      );
      counters.sentFrames += 1;
    } else {
      counters.droppedFrames += 1;
    }
    // Os contadores avançam mesmo no descarte: o servidor mede a lacuna pelo sampleOffset.
    counters.frameSeq += 1;
    counters.sampleOffset += pcm.byteLength / 2;
  }

  stats(): Record<Channel, ChannelStats> {
    const pick = ({ sentFrames, droppedFrames }: ChannelCounters): ChannelStats => ({ sentFrames, droppedFrames });
    return { them: pick(this.counters.them), me: pick(this.counters.me) };
  }
}
