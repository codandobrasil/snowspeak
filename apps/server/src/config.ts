import { DEFAULT_EVENT_BUFFER_SIZE } from "./event-buffer";

export const DEFAULT_SUGGESTION_MODEL = "anthropic/claude-haiku-4.5";

export interface ServerConfig {
  port: number;
  host: string;
  accessKeys: Set<string>;
  allowedOrigins: Set<string>;
  authTimeoutMs: number;
  deepgramApiKey: string | null;
  openRouterApiKey: string | null;
  suggestionModel: string;
  /** Quanto tempo uma sessão sem socket espera a retomada. */
  resumeWindowMs: number;
  eventBufferSize: number;
  heartbeatIntervalMs: number;
  pingIntervalMs: number;
  /** POST /dev/drop-sockets (só para validar a retomada). */
  devEndpoints: boolean;
}

function parseList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const accessKeys = parseList(env.ACCESS_KEYS);
  if (accessKeys.size === 0) throw new Error("ACCESS_KEYS não configurado");
  const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
  if (allowedOrigins.size === 0) throw new Error("ALLOWED_ORIGINS não configurado");

  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "0.0.0.0",
    accessKeys,
    allowedOrigins,
    authTimeoutMs: 5_000,
    deepgramApiKey: env.DEEPGRAM_API_KEY?.trim() || null,
    openRouterApiKey: env.OPENROUTER_API_KEY?.trim() || null,
    suggestionModel: env.SUGGESTION_MODEL?.trim() || DEFAULT_SUGGESTION_MODEL,
    resumeWindowMs: 60_000,
    eventBufferSize: DEFAULT_EVENT_BUFFER_SIZE,
    heartbeatIntervalMs: 5_000,
    pingIntervalMs: 10_000,
    devEndpoints: env.DEV_ENDPOINTS?.trim() === "1",
  };
}
