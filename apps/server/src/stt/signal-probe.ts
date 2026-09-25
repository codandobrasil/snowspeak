import { SAMPLE_RATE, type Channel } from "@snowspeak/shared";

const SILENCE_RMS = 1e-3; // -60 dBFS

export interface SignalReport {
  dbfs: number | null;
  frequencyHz: number | null;
}

// Mede o áudio recebido sem guardá-lo: nível RMS e frequência dominante por cruzamentos de zero.
// Com um seno conhecido, confirma de ponta a ponta duração, amplitude e taxa de amostragem.
export class SignalProbe {
  private samples = 0;
  private sumSquares = 0;
  private crossings = 0;
  private previousNegative: boolean | null = null;

  add(pcm: Uint8Array): void {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
      const sample = view.getInt16(offset, true) / 32768;
      this.sumSquares += sample * sample;
      const negative = sample < 0;
      if (this.previousNegative !== null && negative !== this.previousNegative) this.crossings += 1;
      this.previousNegative = negative;
      this.samples += 1;
    }
  }

  takeReport(): SignalReport {
    const rms = this.samples > 0 ? Math.sqrt(this.sumSquares / this.samples) : 0;
    const seconds = this.samples / SAMPLE_RATE;
    const report: SignalReport =
      rms < SILENCE_RMS || seconds === 0
        ? { dbfs: null, frequencyHz: null }
        : { dbfs: 20 * Math.log10(rms), frequencyHz: this.crossings / 2 / seconds };
    this.samples = 0;
    this.sumSquares = 0;
    this.crossings = 0;
    return report;
  }
}

export function describeSignal(channel: Channel, totalSeconds: number, report: SignalReport): string {
  const prefix = `[fake-stt ${channel}] ${totalSeconds.toFixed(1)} s`;
  if (report.dbfs === null || report.frequencyHz === null) return `${prefix} · silêncio`;
  return `${prefix} · ${Math.round(report.dbfs)} dBFS · ~${Math.round(report.frequencyHz)} Hz`;
}
