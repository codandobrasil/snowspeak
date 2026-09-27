import type { ChatMessage } from "./prompt";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_SUGGESTION_MODEL = "anthropic/claude-haiku-4.5";

export interface Suggester {
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
}

/** O OpenRouter recusou a chave do usuário (HTTP 401 ou 403). */
export class SuggesterAuthError extends Error {
  constructor(status: number) {
    super(`OpenRouter recusou a chave (HTTP ${status})`);
    this.name = "SuggesterAuthError";
  }
}

interface StreamChunk {
  error?: { message?: string };
  choices?: Array<{ delta?: { content?: unknown } }>;
}

export function createOpenRouterSuggester(options: { apiKey: string; model: string; url?: string }): Suggester {
  const url = options.url ?? OPENROUTER_URL;
  return {
    async *stream(messages, signal) {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", "X-Title": "SnowSpeak" },
        body: JSON.stringify({ model: options.model, messages, stream: true, max_tokens: 800, temperature: 0.4 }),
        signal,
      });
      if (response.status === 401 || response.status === 403) throw new SuggesterAuthError(response.status);
      if (!response.ok || !response.body) throw new Error(`OpenRouter respondeu HTTP ${response.status}`);

      // getReader em vez de for await: a iteração assíncrona do corpo só existe em Chromes mais novos que o mínimo do manifesto.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            // Linhas vazias separam eventos; ":" são comentários (ex.: OPENROUTER PROCESSING).
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") return;
            const data = JSON.parse(payload) as StreamChunk;
            if (data.error) throw new Error(`OpenRouter: ${data.error.message ?? "erro no stream"}`);
            const content = data.choices?.[0]?.delta?.content;
            if (typeof content === "string" && content) yield content;
          }
        }
      } finally {
        // Fim antecipado (cancelamento, [DONE], erro): libera a conexão.
        reader.cancel().catch(() => undefined);
      }
    },
  };
}
