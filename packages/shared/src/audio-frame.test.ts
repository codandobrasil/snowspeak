import { describe, expect, it } from "vitest";
import { frameSamples, samplesToMs, type AudioFrame } from "./audio-frame";

describe("audio-frame", () => {
  it("calcula samples e milissegundos, inclusive de um frame final curto", () => {
    const frame: AudioFrame = { channel: "them", frameSeq: 0, sampleOffset: 0, pcm: new Uint8Array(800) };
    expect(frameSamples(frame)).toBe(400);
    expect(samplesToMs(400)).toBe(25);
    expect(samplesToMs(1600)).toBe(100);
  });
});
