import { z } from "zod";
import type { Channel } from "./audio-frame";

export const MODES = ["work", "sales", "interview", "relationship"] as const;
export type Mode = (typeof MODES)[number];
export const MAX_CONTEXT_CHARS = 2_000;

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
  }),
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

const serverMessageSchema = z.discriminatedUnion("type", [
  sessionStartedSchema,
  sessionEndedSchema,
  transcriptPartialBody.extend(envelopeShape),
  transcriptSegmentBody.extend(envelopeShape),
  utteranceEndBody.extend(envelopeShape),
  sentenceReadyBody.extend(envelopeShape),
  audioGapBody.extend(envelopeShape),
  errorBody.extend(envelopeShape),
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
  | z.infer<typeof errorBody>;

export type ServerEvent = EventEnvelope & ServerEventBody;

export type ServerMessage = ServerControl | ServerEvent;

export function isServerEvent(message: ServerMessage): message is ServerEvent {
  return "seq" in message;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const result = serverMessageSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}
