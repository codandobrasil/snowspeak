import type { ChannelStats } from "@snowspeak/engine";
import { isEngineEvent, type Channel, type EngineMessage, type SuggestionErrorCode, type SuggestionTrigger } from "@snowspeak/shared";

export type SessionStatus = "idle" | "starting" | "running" | "stopping" | "error";
export type MicStatus = "unknown" | "active" | "denied";

export const MAX_CAPTIONS = 200;
export const BUSY_SUGGESTION_NOTICE = "Aguarde a sugestão atual terminar.";
export const RATE_LIMITED_SUGGESTION_NOTICE = "Espere um instante para pedir outra sugestão.";
export const STT_RECONNECTING_NOTICE = "Reconectando ao Deepgram…";

export interface SuggestionState {
  requestId: string;
  trigger: SuggestionTrigger;
  status: "streaming" | "done" | "error";
  en: string;
  pt: string;
  basedOnUtteranceId: string | null;
  errorCode: SuggestionErrorCode | null;
}

export interface ChannelView {
  level: number;
  sentFrames: number;
  droppedFrames: number;
  lostMs: number;
}

export interface CaptionSentence {
  source: string;
  /** null enquanto não traduzida (ou quando a tradução falhou). */
  translation: string | null;
  failed: boolean;
}

export interface Caption {
  utteranceId: string;
  channel: Channel;
  segments: string[];
  partial: string;
  ended: boolean;
  interrupted: boolean;
  /** Por sentenceIdx. */
  sentences: Record<number, CaptionSentence>;
}

export interface SessionState {
  status: SessionStatus;
  errorMessage: string | null;
  notice: string | null;
  sessionId: string | null;
  mic: MicStatus;
  /** O usuário desligou o microfone pelo painel: o áudio dele não sai do computador. */
  micMuted: boolean;
  lastSeq: number;
  channels: Record<Channel, ChannelView>;
  /** Canais cujo Deepgram caiu e está reconectando. */
  sttReconnecting: Record<Channel, boolean>;
  /** Aviso de um canal cujo Deepgram não voltou; tem prioridade sobre o de reconexão. */
  sttLost: string | null;
  captions: Caption[];
  suggestion: SuggestionState | null;
  /** Aviso curto de pedido de sugestão recusado; some quando a sugestão atual avança. */
  suggestionNotice: string | null;
  /** Sessão com a chave do OpenRouter: sem ela, não há sugestões. */
  suggestionsEnabled: boolean;
}

export type StoreAction =
  | { type: "starting"; suggestionsEnabled: boolean }
  | { type: "mic"; status: MicStatus }
  | { type: "mic-muted"; muted: boolean }
  | { type: "level"; channel: Channel; rms: number }
  | { type: "stats"; stats: Record<Channel, ChannelStats> }
  | { type: "engine"; message: EngineMessage }
  | { type: "sentence-translated"; sessionId: string; utteranceId: string; sentenceIdx: number; text: string }
  | { type: "sentence-translation-failed"; sessionId: string; utteranceId: string; sentenceIdx: number }
  | { type: "notice"; message: string }
  /** Apaga o aviso só se ele ainda for o indicado (não apaga avisos de outra origem). */
  | { type: "clear-notice"; message: string }
  /** Botão Limpar: some com o que já terminou; a fala e a sugestão em andamento continuam. */
  | { type: "clear" }
  | { type: "stopping" }
  | { type: "failed"; message: string }
  | { type: "stopped" };

function emptyChannel(): ChannelView {
  return { level: 0, sentFrames: 0, droppedFrames: 0, lostMs: 0 };
}

export function initialState(): SessionState {
  return {
    status: "idle",
    errorMessage: null,
    notice: null,
    sessionId: null,
    mic: "unknown",
    micMuted: false,
    lastSeq: 0,
    channels: { them: emptyChannel(), me: emptyChannel() },
    sttReconnecting: { them: false, me: false },
    sttLost: null,
    captions: [],
    suggestion: null,
    suggestionNotice: null,
    suggestionsEnabled: true,
  };
}

function withChannel(state: SessionState, channel: Channel, patch: Partial<ChannelView>): SessionState {
  return { ...state, channels: { ...state.channels, [channel]: { ...state.channels[channel], ...patch } } };
}

function silenced(state: SessionState): SessionState["channels"] {
  return { them: { ...state.channels.them, level: 0 }, me: { ...state.channels.me, level: 0 } };
}

/** Sessão encerrada: não há mais reconexão em andamento, e o aviso dela sai da tela. */
function withoutReconnecting(state: SessionState): SessionState {
  return {
    ...state,
    sttReconnecting: { them: false, me: false },
    notice: state.notice === STT_RECONNECTING_NOTICE ? null : state.notice,
  };
}

function withCaption(state: SessionState, channel: Channel, utteranceId: string, update: (caption: Caption) => Caption): SessionState {
  const index = state.captions.findIndex((c) => c.utteranceId === utteranceId);
  const current: Caption =
    index >= 0
      ? (state.captions[index] as Caption)
      : { utteranceId, channel, segments: [], partial: "", ended: false, interrupted: false, sentences: {} };
  const captions = [...state.captions];
  if (index >= 0) captions[index] = update(current);
  else captions.push(update(current));
  return { ...state, captions: captions.slice(-MAX_CAPTIONS) };
}

function endCaption(state: SessionState, utteranceId: string, interrupted: boolean): SessionState {
  const caption = state.captions.find((c) => c.utteranceId === utteranceId);
  if (!caption) return state;
  // Fala que terminou sem nenhum trecho estável não aparece na legenda.
  if (caption.segments.length === 0) return { ...state, captions: state.captions.filter((c) => c !== caption) };
  return withCaption(state, caption.channel, utteranceId, (c) => ({ ...c, ended: true, interrupted, partial: "" }));
}

function updateSentence(
  state: SessionState,
  sessionId: string,
  utteranceId: string,
  sentenceIdx: number,
  patch: Partial<CaptionSentence>,
): SessionState {
  // utteranceIds se repetem entre sessões (them-1…): tradução de outra sessão é descartada.
  if (sessionId !== state.sessionId) return state;
  const caption = state.captions.find((c) => c.utteranceId === utteranceId);
  const sentence = caption?.sentences[sentenceIdx];
  if (!caption || !sentence) return state; // a fala já saiu da legenda
  return withCaption(state, caption.channel, utteranceId, (c) => ({ ...c, sentences: { ...c.sentences, [sentenceIdx]: { ...sentence, ...patch } } }));
}

function applyEngineMessage(state: SessionState, message: EngineMessage): SessionState {
  if (!isEngineEvent(message)) {
    if (message.type === "session.started") return { ...state, status: "running", sessionId: message.sessionId, lastSeq: 0 };
    return withoutReconnecting({ ...state, status: "idle", channels: silenced(state) });
  }
  if (message.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: message.seq };
  switch (message.type) {
    case "transcript.partial":
      return withCaption(next, message.channel, message.utteranceId, (c) => ({ ...c, partial: message.text }));
    case "transcript.segment":
      return withCaption(next, message.channel, message.utteranceId, (c) => {
        const segments = [...c.segments];
        segments[message.segmentIdx] = message.text;
        return { ...c, segments, partial: "" };
      });
    case "utterance.end":
      return endCaption(next, message.utteranceId, message.interrupted);
    case "sentence.ready":
      return withCaption(next, message.channel, message.utteranceId, (c) => ({
        ...c,
        sentences: { ...c.sentences, [message.sentenceIdx]: { source: message.text, translation: null, failed: false } },
      }));
    case "audio.gap":
      return withChannel(next, message.channel, { lostMs: next.channels[message.channel].lostMs + message.durationMs });
    case "stt.status": {
      const sttReconnecting = { ...next.sttReconnecting, [message.channel]: message.state === "reconnecting" };
      // Um canal que não voltou continua sendo o aviso mais importante.
      if (next.sttLost) return { ...next, sttReconnecting, notice: next.sttLost };
      if (sttReconnecting.them || sttReconnecting.me) return { ...next, sttReconnecting, notice: STT_RECONNECTING_NOTICE };
      // Só apaga o aviso da reconexão; avisos de outra origem ficam.
      return { ...next, sttReconnecting, notice: next.notice === STT_RECONNECTING_NOTICE ? null : next.notice };
    }
    case "error":
      if (message.scope === "stt" && message.channel) {
        // O canal desistiu de reconectar: sai da reconexão e o aviso passa a ser o da perda.
        const sttReconnecting = { ...next.sttReconnecting, [message.channel]: false };
        return { ...next, sttReconnecting, sttLost: message.message, notice: message.message };
      }
      return { ...next, notice: message.message };
    case "suggestion.started":
      return {
        ...next,
        suggestionNotice: null,
        suggestion: {
          requestId: message.requestId,
          trigger: message.trigger,
          status: "streaming",
          en: "",
          pt: "",
          basedOnUtteranceId: message.basedOnUtteranceId,
          errorCode: null,
        },
      };
    case "suggestion.delta":
      if (next.suggestion?.requestId !== message.requestId) return next;
      return { ...next, suggestion: { ...next.suggestion, [message.lang]: next.suggestion[message.lang] + message.text } };
    case "suggestion.done":
      if (next.suggestion?.requestId !== message.requestId) return next;
      return { ...next, suggestionNotice: null, suggestion: { ...next.suggestion, status: "done", en: message.en, pt: message.pt } };
    case "suggestion.error":
      if (next.suggestion?.requestId === message.requestId) {
        return { ...next, suggestionNotice: null, suggestion: { ...next.suggestion, status: "error", errorCode: message.code } };
      }
      // Pedido recusado: aviso curto no cartão, sem esconder outros avisos; a sugestão atual continua.
      if (message.code === "busy") return { ...next, suggestionNotice: BUSY_SUGGESTION_NOTICE };
      if (message.code === "rate_limited") return { ...next, suggestionNotice: RATE_LIMITED_SUGGESTION_NOTICE };
      return next;
  }
}

export function reduce(state: SessionState, action: StoreAction): SessionState {
  switch (action.type) {
    case "starting":
      return { ...initialState(), status: "starting", suggestionsEnabled: action.suggestionsEnabled };
    case "mic":
      return { ...state, mic: action.status };
    case "mic-muted":
      return action.muted ? withChannel({ ...state, micMuted: true }, "me", { level: 0 }) : { ...state, micMuted: false };
    case "level":
      return withChannel(state, action.channel, { level: action.rms });
    case "stats":
      return {
        ...state,
        channels: {
          them: { ...state.channels.them, ...action.stats.them },
          me: { ...state.channels.me, ...action.stats.me },
        },
      };
    case "engine":
      return applyEngineMessage(state, action.message);
    case "sentence-translated":
      return updateSentence(state, action.sessionId, action.utteranceId, action.sentenceIdx, { translation: action.text, failed: false });
    case "sentence-translation-failed":
      return updateSentence(state, action.sessionId, action.utteranceId, action.sentenceIdx, { failed: true });
    case "notice":
      return { ...state, notice: action.message };
    case "clear-notice":
      return state.notice === action.message ? { ...state, notice: null } : state;
    case "clear":
      return {
        ...state,
        captions: state.captions.filter((c) => !c.ended),
        suggestion: state.suggestion?.status === "streaming" ? state.suggestion : null,
        suggestionNotice: null,
      };
    case "stopping":
      return { ...state, status: "stopping", channels: silenced(state) };
    case "failed":
      return withoutReconnecting({ ...state, status: "error", errorMessage: action.message, channels: silenced(state) });
    case "stopped":
      return withoutReconnecting({ ...state, status: "idle", channels: silenced(state) });
  }
}

export class SessionStore {
  private state = initialState();
  private readonly listeners = new Set<(state: SessionState) => void>();

  dispatch(action: StoreAction): void {
    this.state = reduce(this.state, action);
    for (const listener of this.listeners) listener(this.state);
  }

  snapshot(): SessionState {
    return this.state;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
