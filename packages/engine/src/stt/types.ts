import type { Channel } from "@snowspeak/shared";

/** Tempos em segundos desde o início do stream do provedor. */
export type SttResult =
  | { kind: "partial"; text: string }
  | { kind: "segment"; text: string; start: number; end: number; speechFinal: boolean; fromFinalize: boolean }
  | { kind: "utteranceEnd"; lastWordEnd: number };

export interface SttCallbacks {
  /** A conexão com o provedor abriu (antes disso, write() só enfileira). */
  onOpen?(): void;
  onResult(result: SttResult): void;
  /** A conexão com o provedor caiu ou foi recusada (nunca chamado depois de close()). */
  onError(error: Error): void;
}

export interface SttStream {
  write(pcm: Uint8Array): void;
  /** Pede ao provedor que entregue já o que tem pendente. */
  finalize(): void;
  close(): void;
  /** Frames descartados por congestionamento da conexão com o provedor. */
  readonly droppedFrames: number;
}

export type SttFactory = (channel: Channel, callbacks: SttCallbacks) => SttStream;
