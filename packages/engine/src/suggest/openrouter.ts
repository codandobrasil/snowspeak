import type { ChatMessage } from "./prompt";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface Suggester {
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
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
        body: JSON.stringify({ model: options.model, messages, stream: true, max_tokens: 400, temperature: 0.4 }),
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`OpenRouter respondeu HTTP ${response.status}`);

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
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
    },
  };
}

// Sem OPENROUTER_API_KEY: resposta fixa, em pedaços, para testar o caminho completo.
export function createFakeSuggester(): Suggester {
  return {
    async *stream() {
      for (const piece of ["<en>[sugestão falsa] Sure, ", "I'd be happy to talk about that.</en>", "<pt>[sugestão falsa] Claro, falo sobre isso com prazer.</pt>"]) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield piece;
      }
    },
  };
}
