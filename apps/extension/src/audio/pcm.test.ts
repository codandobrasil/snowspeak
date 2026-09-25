import { describe, expect, it } from "vitest";
import { FRAME_SAMPLES, FrameAccumulator, floatTo16BitPcm, rms } from "./pcm";

describe("floatTo16BitPcm", () => {
  it("converte e limita ao intervalo de 16 bits", () => {
    const out = floatTo16BitPcm(new Float32Array([0, 1, -1, 1.5, -2, 0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });
});

describe("rms", () => {
  it("calcula a raiz média quadrática e trata bloco vazio", () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe("FrameAccumulator", () => {
  it("junta blocos de 128 samples em frames de 1600", () => {
    const frames: Int16Array[] = [];
    const acc = new FrameAccumulator((pcm) => frames.push(pcm));
    for (let i = 0; i < 25; i++) acc.push(new Int16Array(128).fill(i)); // 3200 samples
    expect(frames.map((f) => f.length)).toEqual([FRAME_SAMPLES, FRAME_SAMPLES]);
    expect(frames[0]?.[0]).toBe(0);
    expect(frames[1]?.[0]).toBe(12); // o bloco 12 começa no sample 1536; o sample 1600 pertence a ele
  });

  it("entrega arrays novos a cada frame", () => {
    const frames: Int16Array[] = [];
    const acc = new FrameAccumulator((pcm) => frames.push(pcm));
    acc.push(new Int16Array(FRAME_SAMPLES * 2));
    expect(frames[0]).not.toBe(frames[1]);
    expect(frames[0]?.buffer).not.toBe(frames[1]?.buffer);
  });

  it("flush entrega o restante e não entrega nada quando vazio", () => {
    const frames: Int16Array[] = [];
    const acc = new FrameAccumulator((pcm) => frames.push(pcm));
    acc.push(new Int16Array(400));
    acc.flush();
    acc.flush();
    expect(frames.map((f) => f.length)).toEqual([400]);
    expect(frames[0]?.buffer.byteLength).toBe(800);
  });
});
