import { SAMPLE_RATE } from "@snowspeak/shared";

// PCM16LE de um seno contínuo entre chamadas (a fase depende de startSample).
export function sinePcm(options: { frequencyHz: number; amplitude: number; startSample: number; samples: number }): Uint8Array {
  const pcm = new Uint8Array(options.samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < options.samples; i++) {
    const t = (options.startSample + i) / SAMPLE_RATE;
    const value = Math.round(options.amplitude * Math.sin(2 * Math.PI * options.frequencyHz * t) * 32767);
    view.setInt16(i * 2, value, true);
  }
  return pcm;
}
