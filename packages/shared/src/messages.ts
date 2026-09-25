import { z } from "zod";
import type { Channel } from "./audio-frame";

export const MODES = ["work", "sales", "interview", "relationship"] as const;
export type Mode = (typeof MODES)[number];
export const MAX_CONTEXT_CHARS = 2_000;
export const MAX_PROFILE_CHARS = 8_000;
export const MAX_JOB_CHARS = 8_000;

export const CLOSE_CODES = {
  protocolError: 4400,
  unauthorized: 4401,
  sessionNotFound: 4404,
  superseded: 4409,
  sessionEnded: 4410,
} as const;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Cliente → servidor

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.start"),
    token: z.string().min(1),
    mode: z.enum(MODES),
    context: z.string().max(MAX_CONTEXT_CHARS),
    profile: z.string().max(MAX_PROFILE_CHARS).optional(),
    job: z.string().max(MAX_JOB_CHARS).optional(),
  }),
  z.object({
    type: z.literal("session.update"),
    mode: z.enum(MODES).optional(),
    context: z.string().max(MAX_CONTEXT_CHARS).optional(),
    profile: z.string().max(MAX_PROFILE_CHARS).optional(),
    job: z.string().max(MAX_JOB_CHARS).optional(),
  }),
  z.object({ type: z.literal("suggest.request"), requestId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("session.stop") }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export function parseClientMessage(raw: string): ClientMessage | null {
  const result = clientMessageSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}

// Servidor → cliente

const channelSchema = z.enum(["them", "me"] satisfies Channel[]);

export const SESSION_END_REASONS = ["stopped", "replaced", "expired", "max_duration", "error"] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export const AUDIO_GAP_REASONS = ["client_drop", "server_drop", "stt_unavailable"] as const;
export type AudioGapReason = (typeof AUDIO_GAP_REASONS)[number];

// Mensagens de controle: sem seq, nunca entram no replay.
const sessionStartedSchema = z.object({
  v: z.literal(1),
  type: z.literal("session.started"),
  sessionId: z.string().min(1),
  resumeToken: z.string().min(1),
});

const sessionEndedSchema = z.object({
  v: z.literal(1),
  type: z.literal("session.ended"),
  sessionId: z.string().min(1),
  reason: z.enum(SESSION_END_REASONS),
});

export const ERROR_SCOPES = ["stt", "translate", "suggest", "session"] as const;
export const SUGGESTION_TRIGGERS = ["auto", "manual"] as const;
export type SuggestionTrigger = (typeof SUGGESTION_TRIGGERS)[number];
export const SUGGESTION_ERROR_CODES = ["busy", "rate_limited", "timeout", "invalid_output", "provider", "cancelled"] as const;
export type SuggestionErrorCode = (typeof SUGGESTION_ERROR_CODES)[number];
export type ErrorScope = (typeof ERROR_SCOPES)[number];

// Eventos: envelope com seq monotônico.
const envelopeShape = {
  v: z.literal(1),
  sessionId: z.string().min(1),
  seq: z.number().int().min(1),
  ts: z.number(),
};

const utteranceIdSchema = z.string().min(1);
const indexSchema = z.number().int().min(0);

const transcriptPartialBody = z.object({
  type: z.literal("transcript.partial"),
  channel: channelSchema,
  utteranceId: utteranceIdSchema,
  text: z.string(),
});

const transcriptSegmentBody = z.object({
  type: z.literal("transcript.segment"),
  channel: channelSchema,
  utteranceId: utteranceIdSchema,
  segmentIdx: indexSchema,
  text: z.string(),
});

const utteranceEndBody = z.object({
  type: z.literal("utterance.end"),
  channel: channelSchema,
  utteranceId: utteranceIdSchema,
  interrupted: z.boolean(),
});

// Frase do canal them pronta para tradução (a tradução acontece no cliente).
const sentenceReadyBody = z.object({
  type: z.literal("sentence.ready"),
  channel: channelSchema,
  utteranceId: utteranceIdSchema,
  sentenceIdx: indexSchema,
  text: z.string(),
});

const audioGapBody = z.object({
  type: z.literal("audio.gap"),
  channel: channelSchema,
  durationMs: z.number().nonnegative(),
  reason: z.enum(AUDIO_GAP_REASONS),
});

const errorBody = z.object({
  type: z.literal("error"),
  scope: z.enum(ERROR_SCOPES),
  code: z.string().min(1),
  retryable: z.boolean(),
  message: z.string(),
  channel: channelSchema.optional(),
});

const requestIdSchema = z.string().min(1).max(64);

const suggestionStartedBody = z.object({
  type: z.literal("suggestion.started"),
  requestId: requestIdSchema,
  trigger: z.enum(SUGGESTION_TRIGGERS),
  basedOnUtteranceId: z.string().min(1).nullable(),
});

const suggestionDeltaBody = z.object({
  type: z.literal("suggestion.delta"),
  requestId: requestIdSchema,
  lang: z.enum(["en", "pt"]),
  text: z.string(),
});

const suggestionDoneBody = z.object({
  type: z.literal("suggestion.done"),
  requestId: requestIdSchema,
  en: z.string().min(1),
  pt: z.string().min(1),
});

const suggestionErrorBody = z.object({
  type: z.literal("suggestion.error"),
  requestId: requestIdSchema,
  code: z.enum(SUGGESTION_ERROR_CODES),
});

const serverMessageSchema = z.discriminatedUnion("type", [
  sessionStartedSchema,
  sessionEndedSchema,
  transcriptPartialBody.extend(envelopeShape),
  transcriptSegmentBody.extend(envelopeShape),
  utteranceEndBody.extend(envelopeShape),
  sentenceReadyBody.extend(envelopeShape),
  audioGapBody.extend(envelopeShape),
  errorBody.extend(envelopeShape),
  suggestionStartedBody.extend(envelopeShape),
  suggestionDeltaBody.extend(envelopeShape),
  suggestionDoneBody.extend(envelopeShape),
  suggestionErrorBody.extend(envelopeShape),
]);

export type ServerControl = z.infer<typeof sessionStartedSchema> | z.infer<typeof sessionEndedSchema>;

export interface EventEnvelope {
  v: 1;
  sessionId: string;
  seq: number;
  ts: number;
}

export type ServerEventBody =
  | z.infer<typeof transcriptPartialBody>
  | z.infer<typeof transcriptSegmentBody>
  | z.infer<typeof utteranceEndBody>
  | z.infer<typeof sentenceReadyBody>
  | z.infer<typeof audioGapBody>
  | z.infer<typeof errorBody>
  | z.infer<typeof suggestionStartedBody>
  | z.infer<typeof suggestionDeltaBody>
  | z.infer<typeof suggestionDoneBody>
  | z.infer<typeof suggestionErrorBody>;

export type ServerEvent = EventEnvelope & ServerEventBody;

export type ServerMessage = ServerControl | ServerEvent;

export function isServerEvent(message: ServerMessage): message is ServerEvent {
  return "seq" in message;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const result = serverMessageSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}
