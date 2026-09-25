import { describe, expect, it } from "vitest";
import type { Caption } from "../offscreen/session-store";
import { captionEmphasis, captionLines, isCaptureMode } from "./panel-view";
import type { CaptionView } from "./caption-view";

const caption = (utteranceId: string, channel: "them" | "me" = "them"): Caption => ({
  utteranceId,
  channel,
  segments: [],
  partial: "",
  ended: false,
  interrupted: false,
  sentences: {},
});

const view = (overrides: Partial<CaptionView>): CaptionView => ({
  speaker: "Participantes",
  english: "",
  partial: "",
  portuguese: "",
  translating: false,
  translationFailed: false,
  interrupted: false,
  ...overrides,
});

describe("isCaptureMode", () => {
  it("mostra o modo captura enquanto inicia, captura ou finaliza", () => {
    expect(isCaptureMode("starting", false)).toBe(true);
    expect(isCaptureMode("running", false)).toBe(true);
    expect(isCaptureMode("stopping", false)).toBe(true);
    expect(isCaptureMode("idle", true)).toBe(true);
  });

  it("volta às configurações parado ou com erro", () => {
    expect(isCaptureMode("idle", false)).toBe(false);
    expect(isCaptureMode("error", false)).toBe(false);
  });
});

describe("captionEmphasis", () => {
  it("destaca só a fala mais recente", () => {
    const captions = [caption("them-1"), caption("me-1", "me"), caption("them-2")];
    expect(captions.map((_, i) => captionEmphasis(captions, i))).toEqual(["previous", "previous", "current"]);
  });
});

describe("captionLines", () => {
  it("mostra inglês e português normalmente", () => {
    const lines = captionLines(view({ english: "Hello.", portuguese: "Olá." }), "them", false);
    expect(lines).toEqual({ showEnglish: true, englishIsPlaceholder: false, showPortuguese: true });
  });

  it("no modo só português esconde o inglês quando a tradução chegou", () => {
    const lines = captionLines(view({ english: "Hello.", portuguese: "Olá." }), "them", true);
    expect(lines).toEqual({ showEnglish: false, englishIsPlaceholder: false, showPortuguese: true });
  });

  it("no modo só português mostra o inglês provisório enquanto não há tradução", () => {
    const lines = captionLines(view({ english: "", partial: "hel", translating: false }), "them", true);
    expect(lines).toEqual({ showEnglish: true, englishIsPlaceholder: true, showPortuguese: false });
  });

  it("as falas do usuário continuam em inglês/português original, sem tradução", () => {
    const lines = captionLines(view({ english: "Sure." }), "me", true);
    expect(lines).toEqual({ showEnglish: true, englishIsPlaceholder: false, showPortuguese: false });
  });
});
