import { SAMPLE_RATE } from "@snowspeak/shared";
import { SignalProbe, describeSignal } from "./signal-probe";
import type { SttFactory } from "./types";

// STT falso guiado pelo próprio áudio: usado sem DEEPGRAM_API_KEY e nos testes do marco 1.
export function createFakeSttFactory(options: { reportEveryMs?: number } = {}): SttFactory {
  const reportEverySamples = ((options.reportEveryMs ?? 1_000) * SAMPLE_RATE) / 1_000;

  return (channel, callbacks) => {
    const probe = new SignalProbe();
    let samples = 0;
    let lastReported = 0;
    let closed = false;

    return {
      droppedFrames: 0,
      write(pcm) {
        if (closed) return;
        probe.add(pcm);
        samples += pcm.byteLength / 2;
        if (samples - lastReported >= reportEverySamples) {
          lastReported = samples;
          callbacks.onResult({ kind: "partial", text: describeSignal(channel, samples / SAMPLE_RATE, probe.takeReport()) });
        }
      },
      finalize() {},
      close() {
        closed = true;
      },
    };
  };
}
