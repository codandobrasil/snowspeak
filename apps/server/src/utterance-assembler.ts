import type { Channel } from "@snowspeak/shared";
import type { SttResult } from "./stt/types";

export type AssemblerOutput =
  | { type: "transcript.partial"; utteranceId: string; text: string }
  | { type: "transcript.segment"; utteranceId: string; segmentIdx: number; text: string }
  | { type: "utterance.end"; utteranceId: string; interrupted: boolean };

interface OpenUtterance {
  id: string;
  firstWordStart: number | null;
  lastSegmentEnd: number | null;
  segments: number;
}

// Uma fala por vez por canal. Parcial nunca vira segmento; o fim é emitido uma única vez.
export class UtteranceAssembler {
  private count = 0;
  private current: OpenUtterance | null = null;
  // Fim do último segmento de uma fala já encerrada: UtteranceEnd até esse ponto é atrasado.
  private lastClosedEnd = Number.NEGATIVE_INFINITY;

  constructor(private readonly channel: Channel) {}

  get hasOpenUtterance(): boolean {
    return this.current !== null;
  }

  push(result: SttResult): AssemblerOutput[] {
    switch (result.kind) {
      case "partial":
        return [{ type: "transcript.partial", utteranceId: this.open().id, text: result.text }];
      case "segment": {
        const outputs: AssemblerOutput[] = [];
        if (result.text) {
          const utterance = this.open();
          utterance.firstWordStart ??= result.start;
          utterance.lastSegmentEnd = result.end;
          outputs.push({ type: "transcript.segment", utteranceId: utterance.id, segmentIdx: utterance.segments, text: result.text });
          utterance.segments += 1;
        }
        if ((result.speechFinal || result.fromFinalize) && this.current) outputs.push(this.close(false));
        return outputs;
      }
      case "utteranceEnd": {
        const utterance = this.current;
        if (!utterance) return [];
        // UtteranceEnd atrasado de uma fala já encerrada: nunca fecha a fala nova,
        // nem quando ela ainda só tem texto parcial.
        if (result.lastWordEnd <= this.lastClosedEnd) return [];
        if (utterance.firstWordStart !== null && result.lastWordEnd < utterance.firstWordStart) return [];
        return [this.close(false)];
      }
    }
  }

  forceClose(): AssemblerOutput[] {
    return this.current ? [this.close(true)] : [];
  }

  private open(): OpenUtterance {
    if (!this.current) {
      this.count += 1;
      this.current = { id: `${this.channel}-${this.count}`, firstWordStart: null, lastSegmentEnd: null, segments: 0 };
    }
    return this.current;
  }

  /** Só é chamado com uma fala aberta. */
  private close(interrupted: boolean): AssemblerOutput {
    const utterance = this.current;
    this.current = null;
    if (utterance?.lastSegmentEnd != null) this.lastClosedEnd = Math.max(this.lastClosedEnd, utterance.lastSegmentEnd);
    return { type: "utterance.end", utteranceId: utterance?.id ?? "", interrupted };
  }
}
