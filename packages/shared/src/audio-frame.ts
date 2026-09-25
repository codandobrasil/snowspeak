export const SAMPLE_RATE = 16_000;
export const FRAME_HEADER_BYTES = 9;
export const MAX_PCM_BYTES = 3_200; // 100 ms de PCM16 mono a 16 kHz
export const MAX_FRAME_BYTES = FRAME_HEADER_BYTES + MAX_PCM_BYTES;

export type Channel = "them" | "me";

const CHANNEL_CODES: Record<Channel, number> = { them: 0, me: 1 };
const CHANNELS_BY_CODE: readonly Channel[] = ["them", "me"];

export interface AudioFrame {
  channel: Channel;
  frameSeq: number;
  sampleOffset: number;
  pcm: Uint8Array;
}

export type FrameDecodeError = "too_short" | "too_long" | "odd_payload" | "bad_channel";

export type FrameDecodeResult =
  | { ok: true; frame: AudioFrame }
  | { ok: false; reason: FrameDecodeError };

export function encodeFrame(frame: AudioFrame): ArrayBuffer {
  const pcmBytes = frame.pcm.byteLength;
  if (pcmBytes < 2 || pcmBytes > MAX_PCM_BYTES || pcmBytes % 2 !== 0) {
    throw new RangeError(`PCM inválido: ${pcmBytes} bytes`);
  }
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + pcmBytes);
  const view = new DataView(buffer);
  view.setUint8(0, CHANNEL_CODES[frame.channel]);
  view.setUint32(1, frame.frameSeq);
  view.setUint32(5, frame.sampleOffset);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(frame.pcm);
  return buffer;
}

export function decodeFrame(data: Uint8Array): FrameDecodeResult {
  if (data.byteLength < FRAME_HEADER_BYTES + 2) return { ok: false, reason: "too_short" };
  if (data.byteLength > MAX_FRAME_BYTES) return { ok: false, reason: "too_long" };
  if ((data.byteLength - FRAME_HEADER_BYTES) % 2 !== 0) return { ok: false, reason: "odd_payload" };

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const channel = CHANNELS_BY_CODE[view.getUint8(0)];
  if (!channel) return { ok: false, reason: "bad_channel" };

  return {
    ok: true,
    frame: {
      channel,
      frameSeq: view.getUint32(1),
      sampleOffset: view.getUint32(5),
      pcm: data.subarray(FRAME_HEADER_BYTES),
    },
  };
}

export function frameSamples(frame: AudioFrame): number {
  return frame.pcm.byteLength / 2;
}

export function samplesToMs(samples: number): number {
  return (samples * 1000) / SAMPLE_RATE;
}
