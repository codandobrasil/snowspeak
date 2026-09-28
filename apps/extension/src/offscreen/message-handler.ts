import type { RuntimeMessage } from "../messaging";
import { ConversationLog, type ConversationSnapshot } from "./conversation-log";
import type { SessionSettingsChanges, StartParams, SuggestionQuestion } from "./session-controller";
import type { SessionState, SessionStore } from "./session-store";

export interface OffscreenController {
  start(params: StartParams): Promise<void>;
  stop(): void;
  requestSuggestion(question?: SuggestionQuestion): void;
  update(changes: SessionSettingsChanges): void;
  setMicMuted(muted: boolean): void;
  setSuggestionsOn(on: boolean): void;
}

export type OffscreenResponse = { ok: true } | SessionState | ConversationSnapshot;

/**
 * Trata as mensagens destinadas ao offscreen. Sempre responde a start/stop, para que quem enviou
 * (o service worker) não dependa de como o Chrome trata uma mensagem sem resposta.
 */
export function handleOffscreenMessage(
  message: RuntimeMessage,
  controller: OffscreenController,
  store: SessionStore,
  log: ConversationLog = new ConversationLog(),
): OffscreenResponse | undefined {
  if (message.target !== "offscreen") return undefined;
  switch (message.type) {
    case "start":
      void controller.start(message.params);
      return { ok: true };
    case "stop":
      controller.stop();
      return { ok: true };
    case "suggest":
      controller.requestSuggestion(message.question);
      return { ok: true };
    case "update":
      controller.update(message.changes);
      return { ok: true };
    case "mute-mic":
      controller.setMicMuted(message.muted);
      return { ok: true };
    case "suggestions-on":
      controller.setSuggestionsOn(message.on);
      return { ok: true };
    case "clear":
      store.dispatch({ type: "clear" });
      return { ok: true };
    case "get-state":
      return store.snapshot();
    case "get-conversation":
      return log.snapshot();
  }
}
