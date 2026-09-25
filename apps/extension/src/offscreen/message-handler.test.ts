import { describe, expect, it, vi } from "vitest";
import type { RuntimeMessage } from "../messaging";
import { handleOffscreenMessage, type OffscreenController } from "./message-handler";
import type { StartParams } from "./session-controller";
import { SessionStore } from "./session-store";

const params: StartParams = { streamId: "s", serverUrl: "ws://x/ws", token: "k", mode: "work", context: "" };

function fakeController() {
  const start = vi.fn((_params: StartParams) => Promise.resolve());
  const stop = vi.fn(() => undefined);
  return { start, stop } satisfies OffscreenController;
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

  it("ignora mensagens destinadas a outros contextos", () => {
    const message: RuntimeMessage = { target: "background", type: "stop" };
    expect(handleOffscreenMessage(message, fakeController(), new SessionStore())).toBeUndefined();
  });
});
