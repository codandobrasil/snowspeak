import { FrameAccumulator, floatTo16BitPcm, rms } from "./pcm";

const LEVEL_BLOCKS = 25; // 25 blocos × 128 samples ≈ 200 ms a 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  private peakLevel = 0;
  private blocks = 0;
  private readonly accumulator = new FrameAccumulator((pcm) => {
    const buffer = pcm.buffer as ArrayBuffer;
    this.port.postMessage({ type: "frame", pcm: buffer }, [buffer]);
  });

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === "flush") this.accumulator.flush();
    };
  }

  override process(inputs: Float32Array[][]): boolean {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    this.accumulator.push(floatTo16BitPcm(samples));
    this.peakLevel = Math.max(this.peakLevel, rms(samples));
    this.blocks += 1;
    if (this.blocks >= LEVEL_BLOCKS) {
      this.port.postMessage({ type: "level", rms: this.peakLevel });
      this.peakLevel = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor("snowspeak-capture", CaptureProcessor);
