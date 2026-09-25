import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_BYTES,
  MAX_PCM_BYTES,
  decodeFrame,
  encodeFrame,
  frameSamples,
  samplesToMs,
  type AudioFrame,
} from "./audio-frame";

function pcmOf(bytes: number, fill = 7): Uint8Array {
  return new Uint8Array(bytes).fill(fill);
}

describe("encodeFrame/decodeFrame", () => {
  it("faz ida e volta preservando canal, contadores e PCM", () => {
    const frame: AudioFrame = { channel: "me", frameSeq: 42, sampleOffset: 67_200, pcm: pcmOf(MAX_PCM_BYTES) };
    const encoded = encodeFrame(frame);
    expect(encoded.byteLength).toBe(MAX_FRAME_BYTES);

    const decoded = decodeFrame(new Uint8Array(encoded));
    expect(decoded).toEqual({ ok: true, frame });
  });

  it("usa canal 0 para them e 1 para me, com inteiros big-endian", () => {
    const encoded = new Uint8Array(encodeFrame({ channel: "them", frameSeq: 1, sampleOffset: 256, pcm: pcmOf(2) }));
    expect(Array.from(encoded.subarray(0, 9))).toEqual([0, 0, 0, 0, 1, 0, 0, 1, 0]);
  });

  it("decodifica a partir de uma view com byteOffset diferente de zero", () => {
    const encoded = new Uint8Array(encodeFrame({ channel: "them", frameSeq: 3, sampleOffset: 4800, pcm: pcmOf(4) }));
    const pool = new Uint8Array(encoded.byteLength + 5);
    pool.set(encoded, 5);
    const result = decodeFrame(pool.subarray(5));
    expect(result.ok && result.frame.sampleOffset).toBe(4800);
  });

  it("rejeita frames curtos, longos, ímpares e de canal desconhecido", () => {
    expect(decodeFrame(new Uint8Array(10))).toEqual({ ok: false, reason: "too_short" });
    expect(decodeFrame(new Uint8Array(MAX_FRAME_BYTES + 2))).toEqual({ ok: false, reason: "too_long" });
    expect(decodeFrame(new Uint8Array(9 + 3))).toEqual({ ok: false, reason: "odd_payload" });
    const badChannel = new Uint8Array(9 + 2);
    badChannel[0] = 2;
    expect(decodeFrame(badChannel)).toEqual({ ok: false, reason: "bad_channel" });
  });

  it("recusa codificar PCM vazio, ímpar ou maior que 100 ms", () => {
    const base = { channel: "them" as const, frameSeq: 0, sampleOffset: 0 };
    expect(() => encodeFrame({ ...base, pcm: pcmOf(0) })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, pcm: pcmOf(3) })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, pcm: pcmOf(MAX_PCM_BYTES + 2) })).toThrow(RangeError);
  });
});

describe("duração", () => {
  it("calcula samples e milissegundos, inclusive de um frame final curto", () => {
    const frame: AudioFrame = { channel: "them", frameSeq: 0, sampleOffset: 0, pcm: pcmOf(800) };
    expect(frameSamples(frame)).toBe(400);
    expect(samplesToMs(400)).toBe(25);
    expect(samplesToMs(1600)).toBe(100);
  });
});
