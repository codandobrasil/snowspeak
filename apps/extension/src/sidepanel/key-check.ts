export type KeyCheck = "ok" | "rejected" | "missing" | "failed";

export const DEEPGRAM_CHECK_URL = "https://api.deepgram.com/v1/projects";
export const OPENROUTER_CHECK_URL = "https://openrouter.ai/api/v1/key";

export type KeyFetch = (url: string, init: RequestInit) => Promise<{ status: number }>;

const browserFetch: KeyFetch = (url, init) => fetch(url, init);

async function check(url: string, authorization: (key: string) => string, rawKey: string, fetchImpl: KeyFetch): Promise<KeyCheck> {
  const key = rawKey.trim();
  if (!key) return "missing";
  try {
    const { status } = await fetchImpl(url, { headers: { Authorization: authorization(key) } });
    if (status >= 200 && status < 300) return "ok";
    if (status === 401 || status === 403) return "rejected";
    return "failed";
  } catch {
    return "failed";
  }
}

/** Uma chamada leve e gratuita que só responde 200 com uma chave válida. */
export function checkDeepgramKey(key: string, fetchImpl: KeyFetch = browserFetch): Promise<KeyCheck> {
  return check(DEEPGRAM_CHECK_URL, (k) => `Token ${k}`, key, fetchImpl);
}

export function checkOpenRouterKey(key: string, fetchImpl: KeyFetch = browserFetch): Promise<KeyCheck> {
  return check(OPENROUTER_CHECK_URL, (k) => `Bearer ${k}`, key, fetchImpl);
}

export function describeKeyCheck(provider: "Deepgram" | "OpenRouter", result: KeyCheck): string {
  switch (result) {
    case "ok":
      return `${provider}: ok`;
    case "rejected":
      return `${provider}: chave recusada`;
    case "missing":
      return provider === "Deepgram" ? "Deepgram: informe a chave (obrigatória)" : "OpenRouter: não configurada (sem sugestões)";
    case "failed":
      return `${provider}: não foi possível testar agora (rede ou serviço fora do ar)`;
  }
}
