import { DEFAULT_SUGGESTION_MODEL, LocalSession, createDeepgramSttFactory, createOpenRouterSuggester } from "@snowspeak/engine";
import type { RuntimeMessage } from "../messaging";
import { createChromeTranslator } from "../translation/chrome-translator";
import { captureMic, captureTab } from "./capture";
import { BROADCAST_INTERVAL_MS, createCoalescer } from "./coalesce";
import { handleOffscreenMessage } from "./message-handler";
import { SessionController } from "./session-controller";
import { SessionStore } from "./session-store";
import { TranslationQueue } from "./translation-queue";

const store = new SessionStore();
const translations = new TranslationQueue(createChromeTranslator, store);
const controller = new SessionController({
  store,
  captureTab,
  captureMic,
  // As chaves chegam do painel a cada Iniciar e vivem só nesta sessão.
  createSession: (params, onMessage) =>
    new LocalSession(
      {
        sttFactory: createDeepgramSttFactory({ apiKey: params.deepgramKey }),
        suggester: params.openRouterKey
          ? createOpenRouterSuggester({ apiKey: params.openRouterKey, model: params.suggestionModel || DEFAULT_SUGGESTION_MODEL })
          : null,
        onMessage,
      },
      { mode: params.mode, context: params.context, profile: params.profile, job: params.job },
    ),
  onEngineMessage: (message) => translations.handle(message),
});

const broadcast = createCoalescer(() => {
  const message: RuntimeMessage = { target: "sidepanel", type: "state", state: store.snapshot() };
  // O painel pode estar fechado; nesse caso não há receptor.
  chrome.runtime.sendMessage(message).catch(() => undefined);
}, BROADCAST_INTERVAL_MS);
store.subscribe(broadcast);

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  const response = handleOffscreenMessage(message, controller, store);
  if (response !== undefined) sendResponse(response);
});
