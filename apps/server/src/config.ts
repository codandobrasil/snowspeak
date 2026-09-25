export interface ServerConfig {
  port: number;
  host: string;
  accessKeys: Set<string>;
  allowedOrigins: Set<string>;
  authTimeoutMs: number;
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
  };
}
