const DEFAULT_CAPACITY = 600; // ~60 s de frames de 100 ms

interface Mark {
  /** Total de samples encaminhados ao STT até o fim deste frame. */
  samples: number;
  at: number;
}

// Relaciona a linha do tempo do STT (samples que ele de fato recebeu) ao relógio do servidor,
// para estimar a latência mesmo com áudio descartado ou enviado em rajada.
export class ForwardClock {
  private readonly marks: Mark[] = [];
  private total = 0;
  private forgottenUntil = 0;

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  record(samples: number, at: number): void {
    this.total += samples;
    this.marks.push({ samples: this.total, at });
    if (this.marks.length > this.capacity) this.forgottenUntil = this.marks.shift()?.samples ?? this.forgottenUntil;
  }

  /** Horário em que o sample de índice `sample` (1 = primeiro) terminou de ser encaminhado. */
  forwardedAt(sample: number): number | null {
    if (sample <= this.forgottenUntil || sample > this.total) return null;
    let low = 0;
    let high = this.marks.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.marks[mid]?.samples ?? 0) >= sample) high = mid;
      else low = mid + 1;
    }
    return this.marks[low]?.at ?? null;
  }
}
