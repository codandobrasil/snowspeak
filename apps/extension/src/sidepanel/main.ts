import { MAX_CONTEXT_CHARS, MODES, type Mode } from "@snowspeak/shared";
import type { PanelStartParams, RuntimeMessage, StartResponse } from "../messaging";
import { initialState, type SessionState, type SessionStatus } from "../offscreen/session-store";

const DEFAULT_SETTINGS: PanelStartParams = { serverUrl: "ws://localhost:8787/ws", token: "", mode: "work", context: "" };

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "Parado",
  starting: "Iniciando…",
  running: "Capturando",
  error: "Erro",
};

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const serverUrlInput = byId<HTMLInputElement>("serverUrl");
const tokenInput = byId<HTMLInputElement>("token");
const modeSelect = byId<HTMLSelectElement>("mode");
const contextInput = byId<HTMLTextAreaElement>("context");
const startButton = byId<HTMLButtonElement>("start");
const stopButton = byId<HTMLButtonElement>("stop");
const statusLabel = byId<HTMLSpanElement>("status");
const errorLabel = byId<HTMLParagraphElement>("error");
const localErrorLabel = byId<HTMLParagraphElement>("local-error");
const micDeniedLabel = byId<HTMLParagraphElement>("mic-denied");
const micPermissionNotice = byId<HTMLParagraphElement>("mic-permission");
const grantMicButton = byId<HTMLButtonElement>("grant-mic");

contextInput.maxLength = MAX_CONTEXT_CHARS;

let lastState: SessionState = initialState();
// Início pedido ao service worker e ainda não entregue ao offscreen.
let pendingStart = false;

function render(): void {
  const state = lastState;
  const active = pendingStart || state.status === "starting" || state.status === "running";
  statusLabel.textContent = pendingStart && state.status !== "running" ? STATUS_LABELS.starting : STATUS_LABELS[state.status];
  startButton.disabled = active;
  stopButton.disabled = !active;
  errorLabel.hidden = !state.errorMessage;
  errorLabel.textContent = state.errorMessage ?? "";
  micDeniedLabel.hidden = !(state.status === "running" && state.mic === "denied");

  for (const channel of ["them", "me"] as const) {
    const view = state.channels[channel];
    const section = document.querySelector<HTMLElement>(`[data-channel="${channel}"]`);
    if (!section) continue;
    (section.querySelector(".bar") as HTMLElement).style.width = `${Math.min(100, view.level * 300)}%`;
    (section.querySelector(".stats") as HTMLElement).textContent =
      `${view.sentFrames} frames enviados · ${view.droppedFrames} descartados · ${(view.lostMs / 1000).toFixed(1)} s perdidos`;
    (section.querySelector(".partial") as HTMLElement).textContent = view.lastPartial;
  }
}

function applyState(state: SessionState): void {
  lastState = state;
  render();
}

function showLocalError(message: string | null): void {
  localErrorLabel.hidden = !message;
  localErrorLabel.textContent = message ?? "";
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
  render();
  try {
    await chrome.storage.local.set(settings);
    const response = (await chrome.runtime.sendMessage({
      target: "background",
      type: "start",
      params: settings,
    } satisfies RuntimeMessage)) as StartResponse | undefined;
    if (!response?.ok && !response?.cancelled) showLocalError(`Falha ao iniciar: ${response?.error ?? "sem resposta"}`);
  } catch (error) {
    showLocalError(`Falha ao iniciar: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pendingStart = false;
    render();
  }
});

stopButton.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ target: "background", type: "stop" } satisfies RuntimeMessage);
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
