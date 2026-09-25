import type { ServerConfig } from "./config";
import { createDeepgramSttFactory } from "./stt/deepgram-stt";
import { createFakeSttFactory } from "./stt/fake-stt";
import type { SttFactory } from "./stt/types";
import { createFakeSuggester, createOpenRouterSuggester, type Suggester } from "./suggest/openrouter";

export interface Providers {
  sttFactory: SttFactory;
  suggester: Suggester;
  description: string;
}

export function createProviders(config: ServerConfig): Providers {
  const stt = config.deepgramApiKey
    ? { factory: createDeepgramSttFactory({ apiKey: config.deepgramApiKey }), label: "Deepgram" }
    : { factory: createFakeSttFactory(), label: "falso (sem DEEPGRAM_API_KEY)" };
  const suggestions = config.openRouterApiKey
    ? { suggester: createOpenRouterSuggester({ apiKey: config.openRouterApiKey, model: config.suggestionModel }), label: `OpenRouter (${config.suggestionModel})` }
    : { suggester: createFakeSuggester(), label: "falsas (sem OPENROUTER_API_KEY)" };
  return {
    sttFactory: stt.factory,
    suggester: suggestions.suggester,
    description: `STT: ${stt.label} · tradução: no Chrome do usuário · sugestões: ${suggestions.label}`,
  };
}
