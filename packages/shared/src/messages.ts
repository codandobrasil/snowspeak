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

// Eventos: envelope com seq monotônico.
const envelopeShape = {
  v: z.literal(1),
  sessionId: z.string().min(1),
  seq: z.number().int().min(1),
  ts: z.number(),
  utteranceId: z.string().optional(),
};

const transcriptPartialBody = z.object({
  type: z.literal("transcript.partial"),
  channel: channelSchema,
  text: z.string(),
});

const audioGapBody = z.object({
  type: z.literal("audio.gap"),
  channel: channelSchema,
  durationMs: z.number().nonnegative(),
  reason: z.enum(AUDIO_GAP_REASONS),
});

const serverMessageSchema = z.discriminatedUnion("type", [
  sessionStartedSchema,
  sessionEndedSchema,
  transcriptPartialBody.extend(envelopeShape),
  audioGapBody.extend(envelopeShape),
]);

export type ServerControl = z.infer<typeof sessionStartedSchema> | z.infer<typeof sessionEndedSchema>;

export interface EventEnvelope {
  v: 1;
  sessionId: string;
  seq: number;
  ts: number;
  utteranceId?: string;
}

export type ServerEventBody = z.infer<typeof transcriptPartialBody> | z.infer<typeof audioGapBody>;

export type ServerEvent = EventEnvelope & ServerEventBody;

export type ServerMessage = ServerControl | ServerEvent;

export function isServerEvent(message: ServerMessage): message is ServerEvent {
  return "seq" in message;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const result = serverMessageSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}
