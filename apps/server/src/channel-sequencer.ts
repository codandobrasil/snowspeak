export type SequenceResult =
  | { accepted: true; gapSamples: number }
  | { accepted: false; reason: "duplicate" | "overlap" };

// Continuidade de um canal: frameSeq só avança e sampleOffset nunca volta sobre áudio aceito.
// O primeiro offset esperado é 0 (início da sessão), então áudio anterior ao primeiro frame conta como lacuna.
export class ChannelSequencer {
  private lastFrameSeq = -1;
  private nextOffset = 0;

  accept(frameSeq: number, sampleOffset: number, samples: number): SequenceResult {
    if (frameSeq <= this.lastFrameSeq) return { accepted: false, reason: "duplicate" };
    if (sampleOffset < this.nextOffset) return { accepted: false, reason: "overlap" };
    const gapSamples = sampleOffset - this.nextOffset;
    this.lastFrameSeq = frameSeq;
    this.nextOffset = sampleOffset + samples;
    return { accepted: true, gapSamples };
  }
}
