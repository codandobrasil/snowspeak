import { SAMPLE_RATE } from "@snowspeak/shared";
import { SignalProbe, describeSignal } from "./signal-probe";
import type { SttFactory } from "./types";

// STT falso guiado pelo próprio áudio: prova que os frames chegam e que o PCM está correto,
// sem depender de provedor e sem gravar nada.
export function createFakeSttFactory(options: { reportEveryMs?: number } = {}): SttFactory {
  const reportEverySamples = ((options.reportEveryMs ?? 1_000) * SAMPLE_RATE) / 1_000;

  return (channel, onResult) => {
    const probe = new SignalProbe();
    let samples = 0;
    let lastReported = 0;
    let closed = false;

    return {
      write(pcm) {
        if (closed) return;
        probe.add(pcm);
        samples += pcm.byteLength / 2;
        if (samples - lastReported >= reportEverySamples) {
          lastReported = samples;
          onResult({ kind: "partial", text: describeSignal(channel, samples / SAMPLE_RATE, probe.takeReport()) });
        }
      },
      close() {
        closed = true;
      },
    };
  };
}
