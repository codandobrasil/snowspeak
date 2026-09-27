import { MAX_CONTEXT_CHARS, MAX_JOB_CHARS, MAX_PROFILE_CHARS, MODES, type Mode } from "@snowspeak/shared";
import { DEFAULT_SUGGESTION_MODEL } from "@snowspeak/engine";
import type { PanelStartParams, RuntimeMessage, StartResponse } from "../messaging";
import { initialState, type Caption, type SessionState, type SessionStatus } from "../offscreen/session-store";
import { TRANSLATOR_UNAVAILABLE_NOTICE } from "../offscreen/translation-queue";
import { prepareChromeTranslator } from "../translation/chrome-translator";
import { captionView } from "./caption-view";
import { captionEmphasis, captionLines, columnTitles, isCaptureMode, selectableQuestion, timeline, type CaptionEmphasis } from "./panel-view";
import { checkDeepgramKey, checkOpenRouterKey, describeKeyCheck } from "./key-check";
import { suggestionCard } from "./suggestion-view";
import { waitForTranslator } from "./translator-wait";

const DEFAULT_SETTINGS: PanelStartParams = {
  deepgramKey: "",
  openRouterKey: "",
  suggestionModel: DEFAULT_SUGGESTION_MODEL,
  mode: "work",
  context: "",
  profile: "",
  job: "",
};
// Campos da versão com servidor, apagados do storage na primeira abertura.
const LEGACY_SETTINGS = ["serverUrl", "token"];
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
const deepgramKeyInput = byId<HTMLInputElement>("deepgramKey");
const openRouterKeyInput = byId<HTMLInputElement>("openRouterKey");
const suggestionModelInput = byId<HTMLInputElement>("suggestionModel");
const modeSelect = byId<HTMLSelectElement>("mode");
const contextInput = byId<HTMLTextAreaElement>("context");
const profileInput = byId<HTMLTextAreaElement>("profile");
const jobInput = byId<HTMLTextAreaElement>("job");
const suggestButton = byId<HTMLButtonElement>("suggest");
const suggestionItem = byId<HTMLLIElement>("suggestion-item");
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
const columnThem = byId<HTMLSpanElement>("column-them");
const columnMe = byId<HTMLSpanElement>("column-me");
const portugueseOnlyButton = byId<HTMLButtonElement>("portuguese-only");
const clearButton = byId<HTMLButtonElement>("clear");
const muteMicButton = byId<HTMLButtonElement>("mute-mic");
const widthHint = byId<HTMLParagraphElement>("width-hint");
const dismissWidthHintButton = byId<HTMLButtonElement>("dismiss-width-hint");
const checkKeysButton = byId<HTMLButtonElement>("check-keys");
const keyCheckResult = byId<HTMLSpanElement>("key-check-result");

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

function fillCaptionItem(item: HTMLLIElement, caption: Caption, emphasis: CaptionEmphasis, answered: boolean): void {
  const view = captionView(caption);
  const lines = captionLines(view, caption.channel, portugueseOnly);
  item.classList.toggle("current", emphasis === "current");
  item.classList.toggle("previous", emphasis === "previous");
  item.classList.toggle("answered", answered);
  // Pergunta terminada: clicar (ou Enter) pede a resposta para ela.
  const selectable = selectableQuestion(caption) !== null && lastState.suggestionsEnabled;
  item.classList.toggle("selectable", selectable);
  if (selectable) {
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.title = "Clique para sugerir uma resposta";
  } else {
    item.removeAttribute("tabindex");
    item.removeAttribute("role");
    item.removeAttribute("title");
  }
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

function renderCaptions(state: SessionState, suggestionVisible: boolean): void {
  const { captions } = state;
  const nearBottom = captionsList.scrollHeight - captionsList.scrollTop - captionsList.clientHeight < 60;
  const answeredId = state.suggestion?.basedOnUtteranceId ?? null;
  const alive = new Set<string>();
  captions.forEach((caption, index) => {
    alive.add(caption.utteranceId);
    let item = captionItems.get(caption.utteranceId);
    if (!item) {
      item = createCaptionItem(caption);
      item.dataset.utteranceId = caption.utteranceId;
      captionItems.set(caption.utteranceId, item);
    }
    fillCaptionItem(item, caption, captionEmphasis(captions, index), suggestionVisible && caption.utteranceId === answeredId);
  });
  for (const [id, item] of captionItems) {
    if (alive.has(id)) continue;
    item.remove();
    captionItems.delete(id);
  }
  // Põe os elementos na ordem da linha do tempo, mexendo só no que está fora do lugar.
  const order = timeline(captions, suggestionVisible ? { basedOnUtteranceId: answeredId } : null).map((entry) =>
    entry.kind === "caption" ? (captionItems.get(entry.caption.utteranceId) as HTMLLIElement) : suggestionItem,
  );
  if (!suggestionVisible) order.push(suggestionItem);
  order.forEach((node, index) => {
    const current = captionsList.children[index];
    if (current !== node) captionsList.insertBefore(node, current ?? null);
  });
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
  muteMicButton.setAttribute("aria-pressed", String(state.micMuted));
  muteMicButton.textContent = state.micMuted ? "Microfone desligado" : "Microfone";
  muteMicButton.disabled = state.mic !== "active" || state.status !== "running";
  clearButton.disabled = state.captions.length === 0 && state.suggestion === null;
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
  const titles = columnTitles(modeSelect.value as Mode);
  columnThem.textContent = titles.them;
  columnMe.textContent = titles.me;
  const suggestionVisible = renderSuggestion(state);
  renderCaptions(state, suggestionVisible);
}

/** Preenche o cartão da sugestão; devolve se ele está visível. */
function renderSuggestion(state: SessionState): boolean {
  const card = suggestionCard(state.suggestion, state.suggestionNotice, state.suggestionsEnabled);
  suggestionItem.hidden = !card.visible;
  suggestionLabel.textContent = card.label;
  suggestionPending.hidden = !card.pending;
  suggestionEn.textContent = card.en;
  suggestionPt.textContent = card.pt;
  suggestionError.hidden = !card.error;
  suggestionError.textContent = card.error ?? "";
  suggestionNotice.hidden = !card.notice;
  suggestionNotice.textContent = card.notice ?? "";
  suggestionLabel.hidden = !card.label;
  suggestButton.disabled = state.status !== "running" || !state.suggestionsEnabled;
  return card.visible;
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

function readForm(): PanelStartParams {
  const mode = MODES.includes(modeSelect.value as Mode) ? (modeSelect.value as Mode) : "work";
  return {
    // Chaves coladas costumam vir com espaço ou quebra de linha.
    deepgramKey: deepgramKeyInput.value.trim(),
    openRouterKey: openRouterKeyInput.value.trim(),
    suggestionModel: suggestionModelInput.value.trim() || DEFAULT_SUGGESTION_MODEL,
    mode,
    context: contextInput.value,
    profile: profileInput.value,
    job: jobInput.value,
  };
}

async function loadSettings(): Promise<void> {
  await chrome.storage.local.remove(LEGACY_SETTINGS);
  const settings = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as PanelStartParams;
  deepgramKeyInput.value = settings.deepgramKey;
  openRouterKeyInput.value = settings.openRouterKey;
  suggestionModelInput.value = settings.suggestionModel;
  modeSelect.value = settings.mode;
  contextInput.value = settings.context;
  profileInput.value = settings.profile;
  jobInput.value = settings.job;
  render();
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
  if (!settings.deepgramKey) {
    showLocalError("Informe a chave do Deepgram em Configurações.");
    settingsPanel.open = true;
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

muteMicButton.addEventListener("click", () => {
  const muted = !lastState.micMuted;
  chrome.runtime.sendMessage({ target: "offscreen", type: "mute-mic", muted } satisfies RuntimeMessage).catch(() => undefined);
});

clearButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ target: "offscreen", type: "clear" } satisfies RuntimeMessage).catch(() => undefined);
});

function requestSuggestionFor(target: EventTarget | null): void {
  if (lastState.status !== "running" || !lastState.suggestionsEnabled || !(target instanceof Element)) return;
  const id = target.closest<HTMLElement>("li.caption.selectable")?.dataset.utteranceId;
  const caption = lastState.captions.find((c) => c.utteranceId === id);
  const question = caption ? selectableQuestion(caption) : null;
  if (!question) return;
  chrome.runtime.sendMessage({ target: "offscreen", type: "suggest", question } satisfies RuntimeMessage).catch(() => undefined);
}
captionsList.addEventListener("click", (event) => {
  // Seleção de texto (arrastar) não é clique para pedir resposta.
  if (window.getSelection()?.toString()) return;
  requestSuggestionFor(event.target);
});
captionsList.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (!(event.target instanceof Element) || !event.target.matches("li.caption.selectable")) return;
  event.preventDefault();
  requestSuggestionFor(event.target);
});

// Mudanças durante a sessão valem para as próximas sugestões.
function onSettingsChanged(): void {
  const settings = readForm();
  void chrome.storage.local.set(settings);
  if (lastState.status !== "running") return;
  const changes = { mode: settings.mode, context: settings.context, profile: settings.profile, job: settings.job };
  chrome.runtime.sendMessage({ target: "offscreen", type: "update", changes } satisfies RuntimeMessage).catch(() => undefined);
}
for (const field of [modeSelect, contextInput, profileInput, jobInput, deepgramKeyInput, openRouterKeyInput, suggestionModelInput]) {
  field.addEventListener("change", onSettingsChanged);
}
modeSelect.addEventListener("change", render);

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

checkKeysButton.addEventListener("click", async () => {
  const { deepgramKey, openRouterKey } = readForm();
  checkKeysButton.disabled = true;
  keyCheckResult.textContent = "Testando…";
  const [deepgram, openRouter] = await Promise.all([checkDeepgramKey(deepgramKey), checkOpenRouterKey(openRouterKey)]);
  keyCheckResult.textContent = `${describeKeyCheck("Deepgram", deepgram)} · ${describeKeyCheck("OpenRouter", openRouter)}`;
  checkKeysButton.disabled = false;
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
