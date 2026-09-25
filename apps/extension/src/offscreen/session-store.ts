import { isServerEvent, type Channel, type ServerMessage } from "@snowspeak/shared";
import type { ChannelStats } from "./frame-sender";

export type SessionStatus = "idle" | "starting" | "running" | "stopping" | "error";
export type MicStatus = "unknown" | "active" | "denied";

export const MAX_CAPTIONS = 200;

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
  lastSeq: number;
  channels: Record<Channel, ChannelView>;
  captions: Caption[];
}

export type StoreAction =
  | { type: "starting" }
  | { type: "mic"; status: MicStatus }
  | { type: "level"; channel: Channel; rms: number }
  | { type: "stats"; stats: Record<Channel, ChannelStats> }
  | { type: "server"; message: ServerMessage }
  | { type: "sentence-translated"; sessionId: string; utteranceId: string; sentenceIdx: number; text: string }
  | { type: "sentence-translation-failed"; sessionId: string; utteranceId: string; sentenceIdx: number }
  | { type: "notice"; message: string }
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
    lastSeq: 0,
    channels: { them: emptyChannel(), me: emptyChannel() },
    captions: [],
  };
}

function withChannel(state: SessionState, channel: Channel, patch: Partial<ChannelView>): SessionState {
  return { ...state, channels: { ...state.channels, [channel]: { ...state.channels[channel], ...patch } } };
}

function silenced(state: SessionState): SessionState["channels"] {
  return { them: { ...state.channels.them, level: 0 }, me: { ...state.channels.me, level: 0 } };
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

function applyServerMessage(state: SessionState, message: ServerMessage): SessionState {
  if (!isServerEvent(message)) {
    switch (message.type) {
      case "session.started":
        return { ...state, status: "running", sessionId: message.sessionId, lastSeq: 0 };
      case "session.ended":
        return { ...state, status: "idle", channels: silenced(state) };
    }
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
    case "error":
      return { ...next, notice: message.message };
  }
}

export function reduce(state: SessionState, action: StoreAction): SessionState {
  switch (action.type) {
    case "starting":
      return { ...initialState(), status: "starting" };
    case "mic":
      return { ...state, mic: action.status };
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
    case "server":
      return applyServerMessage(state, action.message);
    case "sentence-translated":
      return updateSentence(state, action.sessionId, action.utteranceId, action.sentenceIdx, { translation: action.text, failed: false });
    case "sentence-translation-failed":
      return updateSentence(state, action.sessionId, action.utteranceId, action.sentenceIdx, { failed: true });
    case "notice":
      return { ...state, notice: action.message };
    case "stopping":
      return { ...state, status: "stopping", channels: silenced(state) };
    case "failed":
      return { ...state, status: "error", errorMessage: action.message, channels: silenced(state) };
    case "stopped":
      return { ...state, status: "idle", channels: silenced(state) };
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
