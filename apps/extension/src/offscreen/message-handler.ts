import type { RuntimeMessage } from "../messaging";
import type { StartParams } from "./session-controller";
import type { SessionState, SessionStore } from "./session-store";

export interface OffscreenController {
  start(params: StartParams): Promise<void>;
  stop(): void;
}

export type OffscreenResponse = { ok: true } | SessionState;

/**
 * Trata as mensagens destinadas ao offscreen. Sempre responde a start/stop, para que quem enviou
 * (o service worker) não dependa de como o Chrome trata uma mensagem sem resposta.
 */
export function handleOffscreenMessage(
  message: RuntimeMessage,
  controller: OffscreenController,
  store: SessionStore,
): OffscreenResponse | undefined {
  if (message.target !== "offscreen") return undefined;
  switch (message.type) {
    case "start":
      void controller.start(message.params);
      return { ok: true };
    case "stop":
      controller.stop();
      return { ok: true };
    case "get-state":
      return store.snapshot();
  }
}
