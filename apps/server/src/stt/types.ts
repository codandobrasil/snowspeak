import type { Channel } from "@snowspeak/shared";

// Ampliado no marco 3 (segmentos estáveis, fim de fala, tempos de palavra).
export type SttResult = { kind: "partial"; text: string };

export interface SttStream {
  write(pcm: Uint8Array): void;
  close(): void;
}

export type SttFactory = (channel: Channel, onResult: (result: SttResult) => void) => SttStream;
