import { describe, expect, it } from "vitest";
import type { Caption } from "../offscreen/session-store";
import { captionEmphasis, captionLines, columnTitles, isCaptureMode, selectableQuestion, timeline } from "./panel-view";
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
    expect(isCaptureMode("reconnecting", false)).toBe(true);
    expect(isCaptureMode("idle", true)).toBe(true);
  });

  it("volta às configurações parado ou com erro", () => {
    expect(isCaptureMode("idle", false)).toBe(false);
    expect(isCaptureMode("error", false)).toBe(false);
  });
});

describe("captionEmphasis", () => {
  it("destaca a última fala dos participantes, mesmo quando o usuário fala depois", () => {
    const captions = [caption("them-1"), caption("them-2"), caption("me-1", "me")];
    expect(captions.map((_, i) => captionEmphasis(captions, i))).toEqual(["previous", "current", "normal"]);
  });
});

describe("timeline", () => {
  const captions = [caption("them-1"), caption("me-1", "me"), caption("them-2"), caption("me-2", "me")];
  const ids = (items: ReturnType<typeof timeline>) => items.map((item) => (item.kind === "caption" ? item.caption.utteranceId : "SUGESTAO"));

  it("sem sugestão, só as falas na ordem", () => {
    expect(ids(timeline(captions, null))).toEqual(["them-1", "me-1", "them-2", "me-2"]);
  });

  it("coloca a sugestão logo abaixo da pergunta em que se baseia", () => {
    expect(ids(timeline(captions, { basedOnUtteranceId: "them-1" }))).toEqual(["them-1", "SUGESTAO", "me-1", "them-2", "me-2"]);
  });

  it("sem pergunta de base (ou fora da legenda), a sugestão vai para o fim", () => {
    expect(ids(timeline(captions, { basedOnUtteranceId: null }))).toEqual(["them-1", "me-1", "them-2", "me-2", "SUGESTAO"]);
    expect(ids(timeline(captions, { basedOnUtteranceId: "them-99" }))).toEqual(["them-1", "me-1", "them-2", "me-2", "SUGESTAO"]);
  });
});

describe("selectableQuestion", () => {
  it("fala terminada dos participantes vira pergunta com o texto em inglês", () => {
    const ended = { ...caption("them-1"), segments: ["Why fintech?", "Tell me."], ended: true };
    expect(selectableQuestion(ended)).toEqual({ utteranceId: "them-1", text: "Why fintech? Tell me." });
  });

  it("fala em andamento, fala do usuário ou fala sem texto não é clicável", () => {
    expect(selectableQuestion({ ...caption("them-1"), segments: ["Why"] })).toBeNull();
    expect(selectableQuestion({ ...caption("me-1", "me"), segments: ["Hi."], ended: true })).toBeNull();
    expect(selectableQuestion({ ...caption("them-2"), segments: [""], ended: true })).toBeNull();
  });
});

describe("columnTitles", () => {
  it("chama o outro lado de Entrevistador só no modo entrevista", () => {
    expect(columnTitles("interview")).toEqual({ them: "Entrevistador", me: "Você" });
    expect(columnTitles("work")).toEqual({ them: "Participantes", me: "Você" });
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
