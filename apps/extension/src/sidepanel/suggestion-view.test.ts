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
    expect(suggestionCard(null, null).visible).toBe(false);
  });

  it("mostra só o aviso curto quando o pedido foi recusado sem sugestão na tela", () => {
    expect(suggestionCard(null, "Espere um instante para pedir outra sugestão.")).toMatchObject({
      visible: true,
      notice: "Espere um instante para pedir outra sugestão.",
      en: "",
    });
  });

  it("esconde texto parcial quando a sugestão falhou", () => {
    const card = suggestionCard(suggestion({ status: "error", errorCode: "invalid_output", en: "Hi <pt>Olá", pt: "" }), null);
    expect(card).toMatchObject({ en: "", pt: "", error: "A IA respondeu fora do formato. Tente de novo (Alt+S)." });
  });

  it("mostra a sugestão automática enquanto é gerada", () => {
    expect(suggestionCard(suggestion({ en: "Sure", pt: "" }), null)).toEqual({
      visible: true,
      label: "Sugestão para a pergunta",
      en: "Sure",
      pt: "",
      pending: true,
      error: null,
      notice: null,
    });
  });

  it("mostra a sugestão a pedido concluída", () => {
    expect(suggestionCard(suggestion({ trigger: "manual", status: "done", en: "Sure.", pt: "Claro." }), null)).toMatchObject({
      label: "Sugestão a pedido",
      pending: false,
      error: null,
    });
  });

  it("explica cada erro em português", () => {
    const error = (code: SuggestionState["errorCode"]) => suggestionCard(suggestion({ status: "error", errorCode: code }), null).error;
    expect(error("timeout")).toBe("A sugestão demorou demais. Tente de novo (Alt+S).");
    expect(error("provider")).toBe("Não foi possível gerar a sugestão agora (serviço de IA indisponível).");
    expect(error("invalid_output")).toBe("A IA respondeu fora do formato. Tente de novo (Alt+S).");
    expect(error("cancelled")).toBe("Sugestão cancelada.");
    expect(error("unauthorized")).toBe("O OpenRouter recusou a chave. Confira em Configurações.");
  });
});
