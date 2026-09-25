import { describe, expect, it } from "vitest";
import { NOT_INVOKED_MESSAGE, addInvokedTab, removeInvokedTab, resolveCaptureTab } from "./invoked-tabs";

describe("abas autorizadas pelo clique no ícone", () => {
  it("registra cada aba uma vez e remove a que foi fechada ou recarregada", () => {
    const tabs = addInvokedTab(addInvokedTab(addInvokedTab([], 7), 9), 7);
    expect(tabs).toEqual([7, 9]);
    expect(removeInvokedTab(tabs, 7)).toEqual([9]);
    expect(removeInvokedTab(tabs, 42)).toEqual([7, 9]);
  });

  it("captura a aba que o painel está mostrando quando ela foi autorizada", () => {
    expect(resolveCaptureTab([3, 5], 5)).toEqual({ ok: true, tabId: 5 });
  });

  it("recusa uma aba em que o ícone não foi clicado, em vez de capturar outra", () => {
    expect(resolveCaptureTab([3], 5)).toEqual({ ok: false, error: NOT_INVOKED_MESSAGE });
  });

  it("recusa quando não há aba ativa", () => {
    expect(resolveCaptureTab([3], undefined)).toEqual({ ok: false, error: "Nenhuma aba ativa para capturar." });
  });
});
