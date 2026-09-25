import { describe, expect, it } from "vitest";
import { looksLikeQuestion } from "./question-detector";

describe("looksLikeQuestion", () => {
  it("reconhece perguntas com ponto de interrogação", () => {
    expect(looksLikeQuestion("How was your weekend?")).toBe(true);
    expect(looksLikeQuestion("So you worked with Kafka before?")).toBe(true);
  });

  it("reconhece pedidos típicos de entrevista sem interrogação", () => {
    expect(looksLikeQuestion("Great. Tell me about yourself.")).toBe(true);
    expect(looksLikeQuestion("Walk me through your last project")).toBe(true);
    expect(looksLikeQuestion("Could you describe a conflict with a teammate.")).toBe(true);
  });

  it("não dispara para afirmações, frases curtas ou perguntas no meio", () => {
    expect(looksLikeQuestion("That sounds great, thanks for sharing.")).toBe(false);
    expect(looksLikeQuestion("Okay?")).toBe(false);
    expect(looksLikeQuestion("What a day. Anyway, let's move on to the next topic.")).toBe(false);
  });
});
