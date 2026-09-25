export const FRAME_SAMPLES = 1_600; // 100 ms a 16 kHz

export function floatTo16BitPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (const s of input) sum += s * s;
  return Math.sqrt(sum / input.length);
}

// Junta os blocos de 128 samples do AudioWorklet em frames de 100 ms.
// Cada frame entregue usa um buffer novo, então pode ser transferido via postMessage.
export class FrameAccumulator {
  private buffer = new Int16Array(FRAME_SAMPLES);
  private filled = 0;

  constructor(private readonly onFrame: (pcm: Int16Array) => void) {}

  push(samples: Int16Array): void {
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(FRAME_SAMPLES - this.filled, samples.length - offset);
      this.buffer.set(samples.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === FRAME_SAMPLES) {
        this.onFrame(this.buffer);
        this.buffer = new Int16Array(FRAME_SAMPLES);
        this.filled = 0;
      }
    }
  }

  flush(): void {
    if (this.filled === 0) return;
    this.onFrame(this.buffer.slice(0, this.filled));
    this.buffer = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }
}
