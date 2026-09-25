import { describe, expect, it } from "vitest";
import { decodeFrame, type AudioFrame } from "@snowspeak/shared";
import { FrameSender, MAX_BUFFERED_BYTES, type FrameSink } from "./frame-sender";

class FakeSink implements FrameSink {
  bufferedAmount = 0;
  isOpen = true;
  readonly frames: AudioFrame[] = [];
  send(data: ArrayBuffer): void {
    const decoded = decodeFrame(new Uint8Array(data));
    if (!decoded.ok) throw new Error(decoded.reason);
    this.frames.push(decoded.frame);
  }
}

const fullFrame = (): ArrayBuffer => new ArrayBuffer(3200);

describe("FrameSender", () => {
  it("numera frameSeq e sampleOffset de forma independente por canal", () => {
    const sink = new FakeSink();
    const sender = new FrameSender(sink);
    sender.push("them", fullFrame());
    sender.push("them", fullFrame());
    sender.push("me", fullFrame());
    expect(sink.frames.map((f) => [f.channel, f.frameSeq, f.sampleOffset])).toEqual([
      ["them", 0, 0],
      ["them", 1, 1600],
      ["me", 0, 0],
    ]);
  });

  it("descarta quando o socket está congestionado, mas avança os contadores", () => {
    const sink = new FakeSink();
    const sender = new FrameSender(sink);
    sink.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    sender.push("them", fullFrame());
    sink.bufferedAmount = MAX_BUFFERED_BYTES;
    sender.push("them", fullFrame());
    expect(sink.frames.map((f) => [f.frameSeq, f.sampleOffset])).toEqual([[1, 1600]]);
    expect(sender.stats().them).toEqual({ sentFrames: 1, droppedFrames: 1 });
  });

  it("descarta quando o socket não está aberto", () => {
    const sink = new FakeSink();
    sink.isOpen = false;
    const sender = new FrameSender(sink);
    sender.push("me", fullFrame());
    expect(sink.frames).toHaveLength(0);
    expect(sender.stats().me).toEqual({ sentFrames: 0, droppedFrames: 1 });
  });

  it("avança sampleOffset pelo tamanho real de um frame curto", () => {
    const sink = new FakeSink();
    const sender = new FrameSender(sink);
    sender.push("them", new ArrayBuffer(800));
    sender.push("them", fullFrame());
    expect(sink.frames[1]?.sampleOffset).toBe(400);
  });
});
