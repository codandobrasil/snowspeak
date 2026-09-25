import { describe, expect, it } from "vitest";
import type { SttResult } from "./stt/types";
import { UtteranceAssembler } from "./utterance-assembler";

const partial = (text: string): SttResult => ({ kind: "partial", text });
const segment = (text: string, start: number, end: number, flags: { speechFinal?: boolean; fromFinalize?: boolean } = {}): SttResult => ({
  kind: "segment",
  text,
  start,
  end,
  speechFinal: flags.speechFinal ?? false,
  fromFinalize: flags.fromFinalize ?? false,
});
const utteranceEnd = (lastWordEnd: number): SttResult => ({ kind: "utteranceEnd", lastWordEnd });

describe("UtteranceAssembler", () => {
  it("parciais abrem a fala e mantêm o mesmo id", () => {
    const a = new UtteranceAssembler("them");
    expect(a.push(partial("hel"))).toEqual([{ type: "transcript.partial", utteranceId: "them-1", text: "hel" }]);
    expect(a.push(partial("hello"))).toEqual([{ type: "transcript.partial", utteranceId: "them-1", text: "hello" }]);
    expect(a.hasOpenUtterance).toBe(true);
  });

  it("numera os segmentos estáveis e fecha no speech_final", () => {
    const a = new UtteranceAssembler("them");
    expect(a.push(segment("Hello", 0.1, 0.5))).toEqual([{ type: "transcript.segment", utteranceId: "them-1", segmentIdx: 0, text: "Hello" }]);
    expect(a.push(segment("there.", 0.6, 0.9, { speechFinal: true }))).toEqual([
      { type: "transcript.segment", utteranceId: "them-1", segmentIdx: 1, text: "there." },
      { type: "utterance.end", utteranceId: "them-1", interrupted: false },
    ]);
    expect(a.hasOpenUtterance).toBe(false);
  });

  it("a fala seguinte recebe um novo id", () => {
    const a = new UtteranceAssembler("me");
    a.push(segment("Oi.", 0, 0.4, { speechFinal: true }));
    expect(a.push(partial("tudo"))).toEqual([{ type: "transcript.partial", utteranceId: "me-2", text: "tudo" }]);
  });

  it("UtteranceEnd fecha a fala quando o speech_final não veio", () => {
    const a = new UtteranceAssembler("them");
    a.push(segment("So basically", 1, 1.8));
    expect(a.push(utteranceEnd(1.8))).toEqual([{ type: "utterance.end", utteranceId: "them-1", interrupted: false }]);
  });

  it("speech_final e UtteranceEnd da mesma fala geram um único utterance.end", () => {
    const a = new UtteranceAssembler("them");
    a.push(segment("Yes.", 1, 1.3, { speechFinal: true }));
    expect(a.push(utteranceEnd(1.3))).toEqual([]);
  });

  it("UtteranceEnd atrasado da fala anterior não fecha a fala nova", () => {
    const a = new UtteranceAssembler("them");
    a.push(segment("First one.", 1, 1.6, { speechFinal: true }));
    a.push(segment("And then", 3, 3.4));
    expect(a.push(utteranceEnd(1.6))).toEqual([]);
    expect(a.hasOpenUtterance).toBe(true);
    expect(a.push(utteranceEnd(3.4))).toEqual([{ type: "utterance.end", utteranceId: "them-2", interrupted: false }]);
  });

  it("segmento vindo do Finalize encerra a fala sem marcar interrompida", () => {
    const a = new UtteranceAssembler("them");
    a.push(partial("almost do"));
    expect(a.push(segment("almost done", 0, 0.8, { fromFinalize: true }))).toEqual([
      { type: "transcript.segment", utteranceId: "them-1", segmentIdx: 0, text: "almost done" },
      { type: "utterance.end", utteranceId: "them-1", interrupted: false },
    ]);
  });

  it("forceClose fecha como interrompida e não emite nada sem fala aberta", () => {
    const a = new UtteranceAssembler("them");
    expect(a.forceClose()).toEqual([]);
    a.push(partial("wait"));
    expect(a.forceClose()).toEqual([{ type: "utterance.end", utteranceId: "them-1", interrupted: true }]);
    expect(a.hasOpenUtterance).toBe(false);
  });

  it("final vazio sem fala aberta não emite nada", () => {
    const a = new UtteranceAssembler("them");
    expect(a.push(segment("", 0, 1, { speechFinal: true }))).toEqual([]);
  });
  it("UtteranceEnd atrasado não fecha a fala nova que ainda só tem parcial", () => {
    const a = new UtteranceAssembler("them");
    a.push(segment("First one.", 1, 1.6, { speechFinal: true }));
    a.push(partial("and"));
    expect(a.push(utteranceEnd(1.6))).toEqual([]);
    expect(a.hasOpenUtterance).toBe(true);
    expect(a.push(utteranceEnd(3.4))).toEqual([{ type: "utterance.end", utteranceId: "them-2", interrupted: false }]);
  });
});
