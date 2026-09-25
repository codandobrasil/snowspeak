import { describe, expect, it } from "vitest";
import { ChannelSequencer } from "./channel-sequencer";

describe("ChannelSequencer", () => {
  it("aceita frames contíguos sem lacuna", () => {
    const seq = new ChannelSequencer();
    expect(seq.accept(0, 0, 1600)).toEqual({ accepted: true, gapSamples: 0 });
    expect(seq.accept(1, 1600, 1600)).toEqual({ accepted: true, gapSamples: 0 });
    expect(seq.accept(2, 3200, 400)).toEqual({ accepted: true, gapSamples: 0 });
    expect(seq.accept(3, 3600, 1600)).toEqual({ accepted: true, gapSamples: 0 });
  });

  it("rejeita frameSeq repetido ou antigo", () => {
    const seq = new ChannelSequencer();
    seq.accept(0, 0, 1600);
    seq.accept(1, 1600, 1600);
    expect(seq.accept(1, 1600, 1600)).toEqual({ accepted: false, reason: "duplicate" });
    expect(seq.accept(0, 0, 1600)).toEqual({ accepted: false, reason: "duplicate" });
  });

  it("rejeita sampleOffset que volta sobre áudio já aceito", () => {
    const seq = new ChannelSequencer();
    seq.accept(0, 0, 1600);
    expect(seq.accept(1, 800, 1600)).toEqual({ accepted: false, reason: "overlap" });
  });

  it("mede a lacuna exata quando o cliente descartou áudio", () => {
    const seq = new ChannelSequencer();
    seq.accept(0, 0, 1600);
    expect(seq.accept(3, 4800, 1600)).toEqual({ accepted: true, gapSamples: 3200 });
    expect(seq.accept(4, 6400, 1600)).toEqual({ accepted: true, gapSamples: 0 });
  });

  it("conta como lacuna o áudio anterior ao primeiro frame recebido", () => {
    const seq = new ChannelSequencer();
    expect(seq.accept(2, 3200, 1600)).toEqual({ accepted: true, gapSamples: 3200 });
  });
});
