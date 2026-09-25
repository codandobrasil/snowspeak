import type { ServerConfig } from "./config";
import { createDeepgramSttFactory } from "./stt/deepgram-stt";
import { createFakeSttFactory } from "./stt/fake-stt";
import type { SttFactory } from "./stt/types";

export interface Providers {
  sttFactory: SttFactory;
  description: string;
}

export function createProviders(config: ServerConfig): Providers {
  const stt = config.deepgramApiKey
    ? { factory: createDeepgramSttFactory({ apiKey: config.deepgramApiKey }), label: "Deepgram" }
    : { factory: createFakeSttFactory(), label: "falso (sem DEEPGRAM_API_KEY)" };
  return { sttFactory: stt.factory, description: `STT: ${stt.label} · tradução: no Chrome do usuário` };
}
