import { describe, expect, it, vi } from "vitest";
import type { RuntimeMessage } from "../messaging";
import { handleOffscreenMessage, type OffscreenController } from "./message-handler";
import type { StartParams } from "./session-controller";
import { SessionStore } from "./session-store";

const params: StartParams = { streamId: "s", serverUrl: "ws://x/ws", token: "k", mode: "work", context: "", profile: "", job: "" };

function fakeController() {
  const start = vi.fn((_params: StartParams) => Promise.resolve());
  const stop = vi.fn(() => undefined);
  const requestSuggestion = vi.fn((_question?: object) => undefined);
  const update = vi.fn((_changes: object) => undefined);
  return { start, stop, requestSuggestion, update } satisfies OffscreenController;
}

describe("handleOffscreenMessage", () => {
  it("confirma o start para quem enviou e inicia o controlador", () => {
    const controller = fakeController();
    const response = handleOffscreenMessage({ target: "offscreen", type: "start", params }, controller, new SessionStore());
    expect(response).toEqual({ ok: true });
    expect(controller.start).toHaveBeenCalledWith(params);
  });

  it("confirma o stop e para o controlador", () => {
    const controller = fakeController();
    expect(handleOffscreenMessage({ target: "offscreen", type: "stop" }, controller, new SessionStore())).toEqual({ ok: true });
    expect(controller.stop).toHaveBeenCalled();
  });

  it("devolve o snapshot do store em get-state", () => {
    const store = new SessionStore();
    store.dispatch({ type: "starting" });
    expect(handleOffscreenMessage({ target: "offscreen", type: "get-state" }, fakeController(), store)).toBe(store.snapshot());
  });

  it("limpa a legenda no store em clear", () => {
    const store = new SessionStore();
    store.dispatch({ type: "server", message: { v: 1, type: "session.started", sessionId: "s1", resumeToken: "r" } });
    store.dispatch({ type: "server", message: { v: 1, type: "suggestion.started", sessionId: "s1", seq: 1, ts: 0, requestId: "a", trigger: "manual", basedOnUtteranceId: null } });
    store.dispatch({ type: "server", message: { v: 1, type: "suggestion.done", sessionId: "s1", seq: 2, ts: 0, requestId: "a", en: "Hi.", pt: "Oi." } });
    expect(store.snapshot().suggestion).not.toBeNull();
    expect(handleOffscreenMessage({ target: "offscreen", type: "clear" }, fakeController(), store)).toEqual({ ok: true });
    expect(store.snapshot().suggestion).toBeNull();
  });

  it("ignora mensagens destinadas a outros contextos", () => {
    const message: RuntimeMessage = { target: "background", type: "stop" };
    expect(handleOffscreenMessage(message, fakeController(), new SessionStore())).toBeUndefined();
  });
  it("pede sugestão e repassa mudanças de contexto", () => {
    const controller = fakeController();
    expect(handleOffscreenMessage({ target: "offscreen", type: "suggest" }, controller, new SessionStore())).toEqual({ ok: true });
    expect(controller.requestSuggestion).toHaveBeenCalledWith(undefined);
    const question = { utteranceId: "them-3", text: "Why us?" };
    handleOffscreenMessage({ target: "offscreen", type: "suggest", question }, controller, new SessionStore());
    expect(controller.requestSuggestion).toHaveBeenLastCalledWith(question);
    expect(handleOffscreenMessage({ target: "offscreen", type: "update", changes: { mode: "interview" } }, controller, new SessionStore())).toEqual({ ok: true });
    expect(controller.update).toHaveBeenCalledWith({ mode: "interview" });
  });
});
