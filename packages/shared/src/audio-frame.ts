export const SAMPLE_RATE = 16_000;

export type Channel = "them" | "me";

export interface AudioFrame {
  channel: Channel;
  frameSeq: number;
  sampleOffset: number;
  pcm: Uint8Array;
}

export function frameSamples(frame: AudioFrame): number {
  return frame.pcm.byteLength / 2;
}

export function samplesToMs(samples: number): number {
  return (samples * 1000) / SAMPLE_RATE;
}
