import WebSocket from "ws";
import type { Channel } from "@snowspeak/shared";
import { parseDeepgramMessage } from "./deepgram-messages";
import type { SttFactory } from "./types";

export const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";
export const DEEPGRAM_OPEN_TIMEOUT_MS = 5_000;
// ~1 s de áudio (PCM16 16 kHz): acima disso a conexão está atrasada e o frame é descartado.
export const DEEPGRAM_MAX_BUFFERED_BYTES = 32 * 1024;
const MAX_PENDING_FRAMES = 10; // até 1 s de áudio enquanto a conexão abre

export function deepgramListenUrl(baseUrl: string, channel: Channel): string {
  const params = new URLSearchParams({
    model: "nova-3",
    // Participantes falam inglês; no microfone o usuário pode misturar português.
    language: channel === "them" ? "en" : "multi",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
  });
  return `${baseUrl}?${params.toString()}`;
}

export interface DeepgramOptions {
  apiKey: string;
  baseUrl?: string;
  openTimeoutMs?: number;
  maxBufferedBytes?: number;
}

export function createDeepgramSttFactory(options: DeepgramOptions): SttFactory {
  const baseUrl = options.baseUrl ?? DEEPGRAM_URL;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEEPGRAM_MAX_BUFFERED_BYTES;

  return (channel, callbacks) => {
    const ws = new WebSocket(deepgramListenUrl(baseUrl, channel), { headers: { Authorization: `Token ${options.apiKey}` } });
    const pending: Uint8Array[] = [];
    let droppedFrames = 0;
    let closedByUs = false;
    let failed = false;

    const fail = (reason: string): void => {
      if (closedByUs || failed) return;
      failed = true;
      callbacks.onError(new Error(reason));
    };

    const openTimer = setTimeout(() => {
      fail(`Deepgram não abriu a conexão no prazo (${options.openTimeoutMs ?? DEEPGRAM_OPEN_TIMEOUT_MS} ms)`);
      ws.terminate();
    }, options.openTimeoutMs ?? DEEPGRAM_OPEN_TIMEOUT_MS);

    ws.on("open", () => {
      clearTimeout(openTimer);
      for (const pcm of pending.splice(0)) ws.send(pcm);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const result = parseDeepgramMessage(data.toString());
      if (result) callbacks.onResult(result);
    });
    ws.on("error", (error) => fail(`Deepgram: ${error.message}`));
    ws.on("close", (code) => {
      clearTimeout(openTimer);
      if (droppedFrames > 0) console.warn(`Deepgram (${channel}): ${droppedFrames} frames descartados por congestionamento`);
      fail(`Deepgram encerrou a conexão (código ${code})`);
    });

    return {
      get droppedFrames() {
        return droppedFrames;
      },
      write(pcm) {
        if (ws.readyState === WebSocket.OPEN) {
          // Áudio atrasado não serve para legenda ao vivo: descarta em vez de acumular.
          if (ws.bufferedAmount > maxBufferedBytes) {
            droppedFrames += 1;
            return;
          }
          ws.send(pcm);
        } else if (ws.readyState === WebSocket.CONNECTING) {
          pending.push(pcm);
          if (pending.length > MAX_PENDING_FRAMES) {
            pending.shift();
            droppedFrames += 1;
          }
        }
      },
      finalize() {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Finalize" }));
      },
      close() {
        closedByUs = true;
        clearTimeout(openTimer);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close(1000);
        } else {
          ws.terminate();
        }
      },
    };
  };
}
