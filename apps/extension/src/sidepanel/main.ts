import { MAX_CONTEXT_CHARS, MAX_JOB_CHARS, MAX_PROFILE_CHARS, MODES, type Mode } from "@snowspeak/shared";
import type { PanelStartParams, RuntimeMessage, StartResponse } from "../messaging";
import { initialState, type Caption, type SessionState, type SessionStatus } from "../offscreen/session-store";
import { TRANSLATOR_UNAVAILABLE_NOTICE } from "../offscreen/translation-queue";
import { prepareChromeTranslator } from "../translation/chrome-translator";
import { captionView } from "./caption-view";
import { captionEmphasis, captionLines, isCaptureMode, type CaptionEmphasis } from "./panel-view";
import { suggestionCard } from "./suggestion-view";
import { waitForTranslator } from "./translator-wait";

const DEFAULT_SETTINGS: PanelStartParams = { serverUrl: "ws://localhost:8787/ws", token: "", mode: "work", context: "", profile: "", job: "" };
const DEFAULT_PREFERENCES = { portugueseOnly: false, widthHintDismissed: false };

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
const profileInput = byId<HTMLTextAreaElement>("profile");
const jobInput = byId<HTMLTextAreaElement>("job");
const suggestButton = byId<HTMLButtonElement>("suggest");
const suggestionBox = byId<HTMLDivElement>("suggestion");
const suggestionLabel = byId<HTMLSpanElement>("suggestion-label");
const suggestionPending = byId<HTMLSpanElement>("suggestion-pending");
const suggestionEn = byId<HTMLParagraphElement>("suggestion-en");
const suggestionPt = byId<HTMLParagraphElement>("suggestion-pt");
const suggestionError = byId<HTMLParagraphElement>("suggestion-error");
const suggestionNotice = byId<HTMLParagraphElement>("suggestion-notice");
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
const portugueseOnlyButton = byId<HTMLButtonElement>("portuguese-only");
const widthHint = byId<HTMLParagraphElement>("width-hint");
const dismissWidthHintButton = byId<HTMLButtonElement>("dismiss-width-hint");

contextInput.maxLength = MAX_CONTEXT_CHARS;
profileInput.maxLength = MAX_PROFILE_CHARS;
jobInput.maxLength = MAX_JOB_CHARS;

let lastState: SessionState = initialState();
// Início pedido e ainda não entregue ao offscreen (preparo do tradutor + service worker).
let pendingStart = false;
// Cada clique em Iniciar é uma tentativa; Parar durante a espera a invalida.
let startAttempt = 0;
let translatorDownload: AbortController | null = null;
let skipTranslatorWait: (() => void) | null = null;
let portugueseOnly = false;

const captionItems = new Map<string, HTMLLIElement>();

function createCaptionItem(caption: Caption): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `caption caption-${caption.channel}`;
  item.innerHTML =
    '<div class="speaker"></div><p class="english"><span class="final"></span> <span class="partial"></span></p>' +
    '<p class="portuguese"></p><div class="interrupted" hidden>fala interrompida</div>';
  return item;
}

function fillCaptionItem(item: HTMLLIElement, caption: Caption, emphasis: CaptionEmphasis): void {
  const view = captionView(caption);
  const lines = captionLines(view, caption.channel, portugueseOnly);
  item.classList.toggle("current", emphasis === "current");
  item.classList.toggle("previous", emphasis === "previous");
  (item.querySelector(".speaker") as HTMLElement).textContent = view.speaker;
  const english = item.querySelector(".english") as HTMLElement;
  english.hidden = !lines.showEnglish;
  english.classList.toggle("placeholder", lines.englishIsPlaceholder);
  (item.querySelector(".final") as HTMLElement).textContent = view.english;
  (item.querySelector(".partial") as HTMLElement).textContent = view.partial;
  const portuguese = item.querySelector(".portuguese") as HTMLElement;
  portuguese.hidden = !lines.showPortuguese;
  portuguese.classList.toggle("pending", !view.portuguese && view.translating);
  portuguese.classList.toggle("failed", !view.portuguese && view.translationFailed);
  portuguese.textContent = view.portuguese || (view.translating ? "traduzindo…" : view.translationFailed ? "tradução indisponível" : "");
  (item.querySelector(".interrupted") as HTMLElement).hidden = !view.interrupted;
}

function renderCaptions(captions: Caption[]): void {
  const nearBottom = captionsList.scrollHeight - captionsList.scrollTop - captionsList.clientHeight < 60;
  const alive = new Set<string>();
  captions.forEach((caption, index) => {
    alive.add(caption.utteranceId);
    let item = captionItems.get(caption.utteranceId);
    if (!item) {
      item = createCaptionItem(caption);
      captionItems.set(caption.utteranceId, item);
      captionsList.append(item);
    }
    fillCaptionItem(item, caption, captionEmphasis(captions, index));
  });
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
  document.body.classList.toggle("capturing", isCaptureMode(state.status, pendingStart));
  portugueseOnlyButton.setAttribute("aria-pressed", String(portugueseOnly));
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
    const dot = document.querySelector<HTMLElement>(`[data-dot="${channel}"]`);
    if (dot) dot.style.opacity = String(0.2 + Math.min(0.8, view.level * 4));
    (section.querySelector(".stats") as HTMLElement).textContent =
      `${view.sentFrames} frames · ${view.droppedFrames} descartados · ${(view.lostMs / 1000).toFixed(1)} s perdidos`;
  }
  renderCaptions(state.captions);
  renderSuggestion(state);
}

function renderSuggestion(state: SessionState): void {
  const card = suggestionCard(state.suggestion, state.suggestionNotice);
  suggestionBox.hidden = !card.visible;
  suggestionLabel.textContent = card.label;
  suggestionPending.hidden = !card.pending;
  suggestionEn.textContent = card.en;
  suggestionPt.textContent = card.pt;
  suggestionError.hidden = !card.error;
  suggestionError.textContent = card.error ?? "";
  suggestionNotice.hidden = !card.notice;
  suggestionNotice.textContent = card.notice ?? "";
  suggestionLabel.hidden = !card.label;
  suggestButton.disabled = state.status !== "running";
}

function applyState(state: SessionState): void {
  // Ao voltar para Parado, as configurações aparecem abertas de novo.
  if (!isCaptureMode(state.status, pendingStart) && isCaptureMode(lastState.status, false)) settingsPanel.open = true;
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
  return {
    serverUrl: serverUrlInput.value.trim(),
    token: tokenInput.value.trim(),
    mode,
    context: contextInput.value,
    profile: profileInput.value,
    job: jobInput.value,
  };
}

async function loadSettings(): Promise<void> {
  const settings = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as PanelStartParams;
  serverUrlInput.value = settings.serverUrl;
  tokenInput.value = settings.token;
  modeSelect.value = settings.mode;
  contextInput.value = settings.context;
  profileInput.value = settings.profile;
  jobInput.value = settings.job;
}

async function loadPreferences(): Promise<void> {
  const preferences = (await chrome.storage.local.get(DEFAULT_PREFERENCES)) as typeof DEFAULT_PREFERENCES;
  portugueseOnly = preferences.portugueseOnly;
  widthHint.hidden = preferences.widthHintDismissed;
  render();
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

suggestButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ target: "offscreen", type: "suggest" } satisfies RuntimeMessage).catch(() => undefined);
});

// Mudanças durante a sessão valem para as próximas sugestões.
function onSettingsChanged(): void {
  const settings = readForm();
  void chrome.storage.local.set(settings);
  if (lastState.status !== "running") return;
  const changes = { mode: settings.mode, context: settings.context, profile: settings.profile, job: settings.job };
  chrome.runtime.sendMessage({ target: "offscreen", type: "update", changes } satisfies RuntimeMessage).catch(() => undefined);
}
for (const field of [modeSelect, contextInput, profileInput, jobInput]) field.addEventListener("change", onSettingsChanged);

portugueseOnlyButton.addEventListener("click", () => {
  portugueseOnly = !portugueseOnly;
  void chrome.storage.local.set({ portugueseOnly });
  render();
});

dismissWidthHintButton.addEventListener("click", () => {
  widthHint.hidden = true;
  void chrome.storage.local.set({ widthHintDismissed: true });
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
void loadPreferences();
void refreshMicPermission();
// Ao reabrir o painel, reconstrói a tela a partir do offscreen (se existir).
chrome.runtime.sendMessage({ target: "offscreen", type: "get-state" } satisfies RuntimeMessage).then(
  (state: SessionState | undefined) => applyState(state ?? initialState()),
  () => applyState(initialState()),
);
