import type { Channel } from "./audio-frame";

export const MODES = ["work", "sales", "interview", "relationship"] as const;
export type Mode = (typeof MODES)[number];
export const RESPONSE_LENGTHS = ["short", "medium", "long"] as const;
export type ResponseLength = (typeof RESPONSE_LENGTHS)[number];
export const MAX_CONTEXT_CHARS = 2_000;
export const MAX_PROFILE_CHARS = 8_000;
export const MAX_JOB_CHARS = 8_000;
export const MAX_QUESTION_CHARS = 2_000;

export const SESSION_END_REASONS = ["stopped", "error"] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export const AUDIO_GAP_REASONS = ["client_drop", "stt_unavailable"] as const;
export type AudioGapReason = (typeof AUDIO_GAP_REASONS)[number];

export const STT_STATES = ["reconnecting", "ok"] as const;
export type SttState = (typeof STT_STATES)[number];

export const ERROR_SCOPES = ["stt", "translate", "suggest", "session"] as const;
export type ErrorScope = (typeof ERROR_SCOPES)[number];
export const SUGGESTION_TRIGGERS = ["auto", "manual"] as const;
export type SuggestionTrigger = (typeof SUGGESTION_TRIGGERS)[number];
export const SUGGESTION_ERROR_CODES = ["busy", "rate_limited", "timeout", "invalid_output", "provider", "unauthorized", "cancelled"] as const;
export type SuggestionErrorCode = (typeof SUGGESTION_ERROR_CODES)[number];

// Mensagens de controle: sem seq.
export type EngineControl =
  | { v: 1; type: "session.started"; sessionId: string }
  | { v: 1; type: "session.ended"; sessionId: string; reason: SessionEndReason };

// Eventos: envelope com seq monotônico.
export interface EventEnvelope {
  v: 1;
  sessionId: string;
  seq: number;
  ts: number;
}

export type EngineEventBody =
  | { type: "transcript.partial"; channel: Channel; utteranceId: string; text: string }
  | { type: "transcript.segment"; channel: Channel; utteranceId: string; segmentIdx: number; text: string }
  | { type: "utterance.end"; channel: Channel; utteranceId: string; interrupted: boolean }
  /** Frase do canal them pronta para tradução (a tradução acontece no offscreen). */
  | { type: "sentence.ready"; channel: Channel; utteranceId: string; sentenceIdx: number; text: string }
  | { type: "audio.gap"; channel: Channel; durationMs: number; reason: AudioGapReason }
  /** Conexão com o Deepgram de um canal: caiu e está reconectando, ou voltou. */
  | { type: "stt.status"; channel: Channel; state: SttState }
  | { type: "error"; scope: ErrorScope; code: string; retryable: boolean; message: string; channel?: Channel }
  | { type: "suggestion.started"; requestId: string; trigger: SuggestionTrigger; basedOnUtteranceId: string | null }
  | { type: "suggestion.delta"; requestId: string; lang: "en" | "pt"; text: string }
  | { type: "suggestion.done"; requestId: string; en: string; pt: string }
  | { type: "suggestion.error"; requestId: string; code: SuggestionErrorCode };

export type EngineEvent = EventEnvelope & EngineEventBody;

export type EngineMessage = EngineControl | EngineEvent;

export function isEngineEvent(message: EngineMessage): message is EngineEvent {
  return "seq" in message;
}
