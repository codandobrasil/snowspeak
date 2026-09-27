import { describe, expect, it } from "vitest";
import { isFillerOnly } from "./filler";

describe("isFillerOnly", () => {
  it("reconhece interjeições em inglês e português, com pontuação e maiúsculas", () => {
    for (const text of ["Hmm.", "Uh-huh.", "Yeah.", "Sure!", "Okay, okay.", "Right.", "Got it.", "Mhm", "I see.", "Claro.", "Sim, sim.", "Tá.", "Aham", "Beleza.", "Entendi.", "Yes, sure.", "Oh, okay.", "Got it, got it.", "I see, I see."]) {
      expect(isFillerOnly(text), text).toBe(true);
    }
  });

  it("reconhece interjeições esticadas", () => {
    for (const text of ["Hummmm", "hurrummm", "Hmmmmm...", "Uhhh", "Ummm, yeah", "Ahhh", "Mmmm"]) {
      expect(isFillerOnly(text), text).toBe(true);
    }
  });

  it("não esconde falas de verdade, mesmo começando com interjeição", () => {
    for (const text of ["Yeah, so tell me about your last project.", "Sure, I have five years of experience.", "Okay, why this company?", "No.", "Tell me more.", "I am", "Hello"]) {
      expect(isFillerOnly(text), text).toBe(false);
    }
  });

  it("texto vazio não é interjeição", () => {
    expect(isFillerOnly("")).toBe(false);
    expect(isFillerOnly("  ...  ")).toBe(false);
  });
});
