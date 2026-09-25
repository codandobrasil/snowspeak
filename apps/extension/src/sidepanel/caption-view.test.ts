import { describe, expect, it } from "vitest";
import type { Caption } from "../offscreen/session-store";
import { captionView } from "./caption-view";

const caption = (overrides: Partial<Caption>): Caption => ({
  utteranceId: "them-1",
  channel: "them",
  segments: [],
  partial: "",
  ended: false,
  interrupted: false,
  sentences: {},
  ...overrides,
});

describe("captionView", () => {
  it("junta os segmentos e mostra o parcial separado", () => {
    expect(captionView(caption({ segments: ["Hello there.", "How are"], partial: "you" }))).toMatchObject({
      speaker: "Participantes",
      english: "Hello there. How are",
      partial: "you",
    });
  });

  it("junta as traduções na ordem das frases", () => {
    const view = captionView(
      caption({
        segments: ["Hi. Bye."],
        sentences: { 1: { source: "Bye.", translation: "Tchau.", failed: false }, 0: { source: "Hi.", translation: "Oi.", failed: false } },
      }),
    );
    expect(view.portuguese).toBe("Oi. Tchau.");
    expect(view.translating).toBe(false);
  });

  it("indica tradução em andamento enquanto uma frase pronta não foi traduzida", () => {
    const view = captionView(caption({ segments: ["Hi. Bye."], sentences: { 0: { source: "Hi.", translation: "Oi.", failed: false }, 1: { source: "Bye.", translation: null, failed: false } } }));
    expect(view).toMatchObject({ portuguese: "Oi.", translating: true });
    expect(captionView(caption({ segments: ["Hello"] })).translating).toBe(false);
  });

  it("marca falha de tradução", () => {
    const view = captionView(caption({ segments: ["Hi."], sentences: { 0: { source: "Hi.", translation: null, failed: true } } }));
    expect(view).toMatchObject({ translationFailed: true, translating: false, portuguese: "" });
  });

  it("falas do usuário não têm tradução", () => {
    expect(captionView(caption({ channel: "me", utteranceId: "me-1", segments: ["Sure."] }))).toMatchObject({
      speaker: "Você",
      translating: false,
      portuguese: "",
    });
  });
});
