import { MAX_CONTEXT_CHARS, MODES, type Mode } from "@snowspeak/shared";
import type { PanelStartParams, RuntimeMessage, StartResponse } from "../messaging";
import { initialState, type Caption, type SessionState, type SessionStatus } from "../offscreen/session-store";
import { TRANSLATOR_UNAVAILABLE_NOTICE } from "../offscreen/translation-queue";
import { prepareChromeTranslator } from "../translation/chrome-translator";
import { captionView } from "./caption-view";
import { waitForTranslator } from "./translator-wait";

const DEFAULT_SETTINGS: PanelStartParams = { serverUrl: "ws://localhost:8787/ws", token: "", mode: "work", context: "" };

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "Parado",
  starting: "Iniciando…",
  running: "Capturando",
  stopping: "Finalizando…",
  error: "Erro",
};

const SKIPPED_TRANSLATOR_NOTICE = "O tradutor do Chrome continua baixando; as frases ficam em inglês até ele ficar pronto.";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const serverUrlInput = byId<HTMLInputElement>("serverUrl");
const tokenInput = byId<HTMLInputElement>("token");
const modeSelect = byId<HTMLSelectElement>("mode");
const contextInput = byId<HTMLTextAreaElement>("context");
const startButton = byId<HTMLButtonElement>("start");
const stopButton = byId<HTMLButtonElement>("stop");
const skipTranslatorButton = byId<HTMLButtonElement>("skip-translator");
const statusLabel = byId<HTMLSpanElement>("status");
const errorLabel = byId<HTMLParagraphElement>("error");
const localErrorLabel = byId<HTMLParagraphElement>("local-error");
const localNoticeLabel = byId<HTMLParagraphElement>("local-notice");
const noticeLabel = byId<HTMLParagraphElement>("notice");
const micDeniedLabel = byId<HTMLParagraphElement>("mic-denied");
const micPermissionNotice = byId<HTMLParagraphElement>("mic-permission");
const grantMicButton = byId<HTMLButtonElement>("grant-mic");
const settingsPanel = byId<HTMLDetailsElement>("settings");
const captionsList = byId<HTMLOListElement>("captions");

contextInput.maxLength = MAX_CONTEXT_CHARS;

let lastState: SessionState = initialState();
// Início pedido e ainda não entregue ao offscreen (preparo do tradutor + service worker).
let pendingStart = false;
// Cada clique em Iniciar é uma tentativa; Parar durante a espera a invalida.
let startAttempt = 0;
let translatorDownload: AbortController | null = null;
let skipTranslatorWait: (() => void) | null = null;

const captionItems = new Map<string, HTMLLIElement>();

function createCaptionItem(caption: Caption): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `caption caption-${caption.channel}`;
  item.innerHTML =
    '<div class="speaker"></div><p class="english"><span class="final"></span> <span class="partial"></span></p>' +
    '<p class="portuguese"></p><div class="interrupted" hidden>fala interrompida</div>';
  return item;
}

function fillCaptionItem(item: HTMLLIElement, caption: Caption): void {
  const view = captionView(caption);
  (item.querySelector(".speaker") as HTMLElement).textContent = view.speaker;
  (item.querySelector(".final") as HTMLElement).textContent = view.english;
  (item.querySelector(".partial") as HTMLElement).textContent = view.partial;
  const portuguese = item.querySelector(".portuguese") as HTMLElement;
  portuguese.hidden = caption.channel === "me" || (!view.portuguese && !view.translating && !view.translationFailed);
  portuguese.classList.toggle("pending", !view.portuguese && view.translating);
  portuguese.classList.toggle("failed", !view.portuguese && view.translationFailed);
  portuguese.textContent = view.portuguese || (view.translating ? "traduzindo…" : view.translationFailed ? "tradução indisponível" : "");
  (item.querySelector(".interrupted") as HTMLElement).hidden = !view.interrupted;
}

function renderCaptions(captions: Caption[]): void {
  const nearBottom = captionsList.scrollHeight - captionsList.scrollTop - captionsList.clientHeight < 60;
  const alive = new Set<string>();
  for (const caption of captions) {
    alive.add(caption.utteranceId);
    let item = captionItems.get(caption.utteranceId);
    if (!item) {
      item = createCaptionItem(caption);
      captionItems.set(caption.utteranceId, item);
      captionsList.append(item);
    }
    fillCaptionItem(item, caption);
  }
  for (const [id, item] of captionItems) {
    if (alive.has(id)) continue;
    item.remove();
    captionItems.delete(id);
  }
  // Acompanha a conversa, a menos que o usuário tenha rolado para ler algo anterior.
  if (nearBottom) captionsList.scrollTop = captionsList.scrollHeight;
}

function render(): void {
  const state = lastState;
  const active = pendingStart || state.status === "starting" || state.status === "running";
  statusLabel.textContent = pendingStart && state.status !== "running" ? STATUS_LABELS.starting : STATUS_LABELS[state.status];
  startButton.disabled = active || state.status === "stopping";
  stopButton.disabled = !active;
  errorLabel.hidden = !state.errorMessage;
  errorLabel.textContent = state.errorMessage ?? "";
  noticeLabel.hidden = !state.notice;
  noticeLabel.textContent = state.notice ?? "";
  micDeniedLabel.hidden = !(state.status === "running" && state.mic === "denied");

  for (const channel of ["them", "me"] as const) {
    const view = state.channels[channel];
    const section = document.querySelector<HTMLElement>(`[data-channel="${channel}"]`);
    if (!section) continue;
    (section.querySelector(".bar") as HTMLElement).style.width = `${Math.min(100, view.level * 300)}%`;
    (section.querySelector(".stats") as HTMLElement).textContent =
      `${view.sentFrames} frames · ${view.droppedFrames} descartados · ${(view.lostMs / 1000).toFixed(1)} s perdidos`;
  }
  renderCaptions(state.captions);
}

function applyState(state: SessionState): void {
  if (state.status === "starting" && lastState.status !== "starting") settingsPanel.open = false;
  lastState = state;
  render();
}

function showLocalError(message: string | null): void {
  localErrorLabel.hidden = !message;
  localErrorLabel.textContent = message ?? "";
}

function showLocalNotice(message: string | null): void {
  localNoticeLabel.hidden = !message;
  localNoticeLabel.textContent = message ?? "";
}

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

function readForm(): PanelStartParams {
  const mode = MODES.includes(modeSelect.value as Mode) ? (modeSelect.value as Mode) : "work";
  return { serverUrl: serverUrlInput.value.trim(), token: tokenInput.value.trim(), mode, context: contextInput.value };
}

async function loadSettings(): Promise<void> {
  const settings = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as PanelStartParams;
  serverUrlInput.value = settings.serverUrl;
  tokenInput.value = settings.token;
  modeSelect.value = settings.mode;
  contextInput.value = settings.context;
}

async function refreshMicPermission(): Promise<void> {
  try {
    const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
    micPermissionNotice.hidden = permission.state === "granted";
    permission.onchange = () => {
      micPermissionNotice.hidden = permission.state === "granted";
    };
  } catch {
    micPermissionNotice.hidden = true;
  }
}

/** Prepara o tradutor do Chrome (baixa o modelo na primeira vez); o usuário pode seguir sem esperar. */
async function prepareTranslator(): Promise<void> {
  const download = new AbortController();
  translatorDownload = download;
  const skipped = new Promise<void>((resolve) => {
    skipTranslatorWait = resolve;
  });
  // Primeira chamada do clique: o download do modelo exige o gesto do usuário.
  const preparation = prepareChromeTranslator((fraction) => {
    showLocalNotice(`Baixando o tradutor do Chrome… ${Math.round(fraction * 100)}%`);
    skipTranslatorButton.hidden = false;
  }, download.signal);
  const outcome = await waitForTranslator(preparation, skipped);
  skipTranslatorButton.hidden = true;
  skipTranslatorWait = null;
  if (translatorDownload === download) translatorDownload = null;
  if (outcome === "unavailable") showLocalNotice(TRANSLATOR_UNAVAILABLE_NOTICE);
  else if (outcome === "skipped") showLocalNotice(SKIPPED_TRANSLATOR_NOTICE);
  else showLocalNotice(null);
}

startButton.addEventListener("click", async () => {
  if (pendingStart) return;
  showLocalError(null);
  const settings = readForm();
  if (!isWebSocketUrl(settings.serverUrl)) {
    showLocalError("Endereço do servidor inválido (use ws:// ou wss://).");
    return;
  }
  if (!settings.token) {
    showLocalError("Informe a chave de acesso.");
    return;
  }

  pendingStart = true;
  startAttempt += 1;
  const attempt = startAttempt;
  render();
  try {
    await prepareTranslator();
    // Parar durante a espera do tradutor cancela este início.
    if (attempt !== startAttempt) {
      showLocalNotice(null);
      return;
    }

    await chrome.storage.local.set(settings);
    // A aba que este painel está mostrando; o service worker só captura se o ícone foi clicado nela.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (attempt !== startAttempt) return;
    const response = (await chrome.runtime.sendMessage({
      target: "background",
      type: "start",
      params: settings,
      tabId: activeTab?.id,
    } satisfies RuntimeMessage)) as StartResponse | undefined;
    if (!response?.ok && !response?.cancelled) showLocalError(`Falha ao iniciar: ${response?.error ?? "sem resposta"}`);
  } catch (error) {
    showLocalError(`Falha ao iniciar: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (attempt === startAttempt) pendingStart = false;
    render();
  }
});

stopButton.addEventListener("click", () => {
  if (pendingStart) {
    // Cancela um início ainda em preparo: invalida a tentativa e interrompe o download do tradutor.
    startAttempt += 1;
    pendingStart = false;
    translatorDownload?.abort();
    showLocalNotice(null);
    render();
  }
  chrome.runtime.sendMessage({ target: "background", type: "stop" } satisfies RuntimeMessage).catch(() => undefined);
});

skipTranslatorButton.addEventListener("click", () => {
  skipTranslatorWait?.();
});

grantMicButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message.target === "sidepanel" && message.type === "state") applyState(message.state);
});

render();
void loadSettings();
void refreshMicPermission();
// Ao reabrir o painel, reconstrói a tela a partir do offscreen (se existir).
chrome.runtime.sendMessage({ target: "offscreen", type: "get-state" } satisfies RuntimeMessage).then(
  (state: SessionState | undefined) => applyState(state ?? initialState()),
  () => applyState(initialState()),
);
