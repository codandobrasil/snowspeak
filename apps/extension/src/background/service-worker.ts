import type { PanelStartParams, RuntimeMessage, StartResponse } from "../messaging";
import { AttemptTracker } from "./attempt-tracker";
import { addInvokedTab, removeInvokedTab, resolveCaptureTab } from "./invoked-tabs";

const attempts = new AttemptTracker();
let creatingOffscreen: Promise<void> | null = null;

// O clique no ícone é a invocação que autoriza capturar a aba: abre o painel e registra a aba.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

async function readInvokedTabs(): Promise<number[]> {
  const { invokedTabIds } = await chrome.storage.session.get("invokedTabIds");
  return Array.isArray(invokedTabIds) ? (invokedTabIds as number[]) : [];
}

async function updateInvokedTabs(change: (tabs: number[]) => number[]): Promise<void> {
  await chrome.storage.session.set({ invokedTabIds: change(await readInvokedTabs()) });
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  const tabId = tab.id;
  void chrome.sidePanel.open({ tabId }); // primeiro, ainda dentro do gesto do usuário
  void updateInvokedTabs((tabs) => addInvokedTab(tabs, tabId));
});

// Fechar ou recarregar a aba desfaz a autorização do Chrome; desfaz a nossa também.
chrome.tabs.onRemoved.addListener((tabId) => void updateInvokedTabs((tabs) => removeInvokedTab(tabs, tabId)));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") void updateInvokedTabs((tabs) => removeInvokedTab(tabs, tabId));
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

async function handleStart(params: PanelStartParams, activeTabId: number | undefined): Promise<StartResponse> {
  const attempt = attempts.begin();
  if (attempt === null) return { ok: false, error: "Já existe um início em andamento." };
  try {
    const target = resolveCaptureTab(await readInvokedTabs(), activeTabId);
    if (!target.ok) return { ok: false, error: target.error };

    await ensureOffscreen();
    if (!attempts.isCurrent(attempt)) return { ok: false, cancelled: true };

    // O streamId expira em poucos segundos: obtido só agora, logo antes de entregar ao offscreen.
    let streamId: string;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.tabId });
    } catch (error) {
      console.warn(`getMediaStreamId falhou: ${errorText(error)}`);
      return { ok: false, error: "Não foi possível capturar esta aba. Clique no ícone do SnowSpeak nela e tente de novo." };
    }
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
    void handleStart(message.params, message.tabId).then(sendResponse);
    return true; // resposta assíncrona
  }

  attempts.cancel();
  void chrome.runtime.sendMessage({ target: "offscreen", type: "stop" } satisfies RuntimeMessage).catch(() => undefined);
  sendResponse({ ok: true });
  return;
});
