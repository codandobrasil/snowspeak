import type { PanelStartParams, RuntimeMessage, StartResponse } from "../messaging";
import { AttemptTracker } from "./attempt-tracker";

const attempts = new AttemptTracker();
let creatingOffscreen: Promise<void> | null = null;

// O clique no ícone é a invocação que autoriza capturar a aba: abre o painel e associa a aba.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void chrome.sidePanel.open({ tabId: tab.id }); // primeiro, ainda dentro do gesto do usuário
  void chrome.storage.session.set({ invokedTabId: tab.id });
});

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length > 0) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Capturar o áudio da aba e do microfone para transcrição.",
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleStart(params: PanelStartParams): Promise<StartResponse> {
  const attempt = attempts.begin();
  if (attempt === null) return { ok: false, error: "Já existe um início em andamento." };
  try {
    const { invokedTabId } = await chrome.storage.session.get("invokedTabId");
    if (typeof invokedTabId !== "number") return { ok: false, error: "Clique no ícone do SnowSpeak na aba da chamada." };

    await ensureOffscreen();
    if (!attempts.isCurrent(attempt)) return { ok: false, cancelled: true };

    // O streamId expira em poucos segundos: obtido só agora, logo antes de entregar ao offscreen.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: invokedTabId });
    if (!attempts.isCurrent(attempt)) return { ok: false, cancelled: true };

    await chrome.runtime.sendMessage({ target: "offscreen", type: "start", params: { ...params, streamId } } satisfies RuntimeMessage);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  } finally {
    attempts.finish(attempt);
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse: (response: StartResponse) => void) => {
  if (message.target !== "background") return;

  if (message.type === "start") {
    void handleStart(message.params).then(sendResponse);
    return true; // resposta assíncrona
  }

  attempts.cancel();
  void chrome.runtime.sendMessage({ target: "offscreen", type: "stop" } satisfies RuntimeMessage).catch(() => undefined);
  return;
});
