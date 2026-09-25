import { describe, expect, it } from "vitest";
import type { SuggestionState } from "../offscreen/session-store";
import { suggestionCard } from "./suggestion-view";

const suggestion = (overrides: Partial<SuggestionState>): SuggestionState => ({
  requestId: "r1",
  trigger: "auto",
  status: "streaming",
  en: "",
  pt: "",
  basedOnUtteranceId: "them-1",
  errorCode: null,
  ...overrides,
});

describe("suggestionCard", () => {
  it("fica escondido sem sugestão", () => {
    expect(suggestionCard(null).visible).toBe(false);
  });

  it("mostra a sugestão automática enquanto é gerada", () => {
    expect(suggestionCard(suggestion({ en: "Sure", pt: "" }))).toEqual({
      visible: true,
      label: "Sugestão para a pergunta",
      en: "Sure",
      pt: "",
      pending: true,
      error: null,
    });
  });

  it("mostra a sugestão a pedido concluída", () => {
    expect(suggestionCard(suggestion({ trigger: "manual", status: "done", en: "Sure.", pt: "Claro." }))).toMatchObject({
      label: "Sugestão a pedido",
      pending: false,
      error: null,
    });
  });

  it("explica cada erro em português", () => {
    const error = (code: SuggestionState["errorCode"]) => suggestionCard(suggestion({ status: "error", errorCode: code })).error;
    expect(error("timeout")).toBe("A sugestão demorou demais. Tente de novo (Alt+S).");
    expect(error("provider")).toBe("Não foi possível gerar a sugestão agora (serviço de IA indisponível).");
    expect(error("invalid_output")).toBe("A IA respondeu fora do formato. Tente de novo (Alt+S).");
    expect(error("cancelled")).toBe("Sugestão cancelada.");
  });
});
