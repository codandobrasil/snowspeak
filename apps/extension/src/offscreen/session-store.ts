import { isServerEvent, type Channel, type ServerMessage } from "@snowspeak/shared";
import type { ChannelStats } from "./frame-sender";

export type SessionStatus = "idle" | "starting" | "running" | "error";
export type MicStatus = "unknown" | "active" | "denied";

export interface ChannelView {
  level: number;
  sentFrames: number;
  droppedFrames: number;
  lostMs: number;
  lastPartial: string;
}

export interface SessionState {
  status: SessionStatus;
  errorMessage: string | null;
  sessionId: string | null;
  mic: MicStatus;
  lastSeq: number;
  channels: Record<Channel, ChannelView>;
}

export type StoreAction =
  | { type: "starting" }
  | { type: "mic"; status: MicStatus }
  | { type: "level"; channel: Channel; rms: number }
  | { type: "stats"; stats: Record<Channel, ChannelStats> }
  | { type: "server"; message: ServerMessage }
  | { type: "failed"; message: string }
  | { type: "stopped" };

function emptyChannel(): ChannelView {
  return { level: 0, sentFrames: 0, droppedFrames: 0, lostMs: 0, lastPartial: "" };
}

export function initialState(): SessionState {
  return {
    status: "idle",
    errorMessage: null,
    sessionId: null,
    mic: "unknown",
    lastSeq: 0,
    channels: { them: emptyChannel(), me: emptyChannel() },
  };
}

function withChannel(state: SessionState, channel: Channel, patch: Partial<ChannelView>): SessionState {
  return { ...state, channels: { ...state.channels, [channel]: { ...state.channels[channel], ...patch } } };
}

function silenced(state: SessionState): SessionState["channels"] {
  return { them: { ...state.channels.them, level: 0 }, me: { ...state.channels.me, level: 0 } };
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
      return withChannel(next, message.channel, { lastPartial: message.text });
    case "audio.gap":
      return withChannel(next, message.channel, { lostMs: next.channels[message.channel].lostMs + message.durationMs });
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
