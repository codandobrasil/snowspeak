import type { Channel } from "@snowspeak/shared";
import { parseDeepgramMessage } from "./deepgram-messages";
import type { SttFactory } from "./types";

export const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";
export const DEEPGRAM_OPEN_TIMEOUT_MS = 5_000;
// ~1 s de áudio (PCM16 16 kHz): acima disso a conexão está atrasada e o frame é descartado.
export const DEEPGRAM_MAX_BUFFERED_BYTES = 32 * 1024;
// O Deepgram fecha a conexão (NET-0001) após ~10 s sem áudio nem KeepAlive — ex.: canal "me" sem microfone.
export const DEEPGRAM_KEEPALIVE_MS = 4_000;
// Conexão que trava sem fechar (rota perdida, VPN ou NAT expirando): o navegador segue com o socket aberto,
// mas nada sai. Depois de 5 s seguidos sem conseguir enviar áudio, o stream é derrubado para reconectar.
export const DEEPGRAM_STALL_MS = 5_000;
const MAX_PENDING_FRAMES = 10; // até 1 s de áudio enquanto a conexão abre
const CONNECTING = 0;
const OPEN = 1;

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

/** A parte do WebSocket do navegador que o cliente usa (os testes passam uma versão falsa). */
export interface BrowserSocket {
  binaryType: BinaryType;
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number): void;
}

export type BrowserSocketConstructor = new (url: string, protocols: string[]) => BrowserSocket;

export interface DeepgramOptions {
  apiKey: string;
  baseUrl?: string;
  openTimeoutMs?: number;
  maxBufferedBytes?: number;
  keepAliveMs?: number;
  stallMs?: number;
  /** Padrão: o WebSocket do navegador. */
  socketImpl?: BrowserSocketConstructor;
}

export function createDeepgramSttFactory(options: DeepgramOptions): SttFactory {
  const baseUrl = options.baseUrl ?? DEEPGRAM_URL;
  const openTimeoutMs = options.openTimeoutMs ?? DEEPGRAM_OPEN_TIMEOUT_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEEPGRAM_MAX_BUFFERED_BYTES;
  const keepAliveMs = options.keepAliveMs ?? DEEPGRAM_KEEPALIVE_MS;
  const stallMs = options.stallMs ?? DEEPGRAM_STALL_MS;

  return (channel, callbacks) => {
    const Socket = options.socketImpl ?? (WebSocket as unknown as BrowserSocketConstructor);
    // O WebSocket do navegador não envia cabeçalhos: a chave vai no subprotocolo, como o Deepgram documenta.
    const ws = new Socket(deepgramListenUrl(baseUrl, channel), ["token", options.apiKey]);
    ws.binaryType = "arraybuffer";
    const pending: Uint8Array[] = [];
    let droppedFrames = 0;
    let lastSentAt = Date.now();
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let closedByUs = false;
    /** Desde quando todo áudio está sendo descartado por congestionamento. */
    let congestedSince: number | null = null;
    let failed = false;

    const stopTimers = (): void => {
      clearTimeout(openTimer);
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    };

    const fail = (reason: string): void => {
      if (closedByUs || failed) return;
      failed = true;
      stopTimers();
      callbacks.onError(new Error(reason));
    };

    const openTimer = setTimeout(() => {
      fail(`Deepgram não abriu a conexão no prazo (${openTimeoutMs} ms)`);
      ws.close();
    }, openTimeoutMs);

    ws.onopen = () => {
      clearTimeout(openTimer);
      for (const pcm of pending.splice(0)) ws.send(pcm);
      lastSentAt = Date.now();
      keepAliveTimer = setInterval(() => {
        if (ws.readyState !== OPEN || Date.now() - lastSentAt < keepAliveMs) return;
        ws.send(JSON.stringify({ type: "KeepAlive" }));
        lastSentAt = Date.now();
      }, keepAliveMs);
      callbacks.onOpen?.();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const result = parseDeepgramMessage(event.data);
      if (result) callbacks.onResult(result);
    };
    // O navegador não diz o motivo do erro (nem o status HTTP do handshake); o close vem logo depois e é ele que avisa.
    ws.onerror = () => undefined;
    ws.onclose = (event) => {
      stopTimers();
      if (droppedFrames > 0) console.warn(`Deepgram (${channel}): ${droppedFrames} frames descartados por congestionamento`);
      fail(`Deepgram encerrou a conexão (código ${event.code})`);
    };

    return {
      get droppedFrames() {
        return droppedFrames;
      },
      write(pcm) {
        if (ws.readyState === OPEN) {
          // Áudio atrasado não serve para legenda ao vivo: descarta em vez de acumular.
          if (ws.bufferedAmount > maxBufferedBytes) {
            droppedFrames += 1;
            congestedSince ??= Date.now();
            if (Date.now() - congestedSince >= stallMs) {
              fail("Deepgram parou de receber o áudio (conexão travada)");
              ws.close();
            }
            return;
          }
          congestedSince = null;
          ws.send(pcm);
          lastSentAt = Date.now();
        } else if (ws.readyState === CONNECTING) {
          pending.push(pcm);
          if (pending.length > MAX_PENDING_FRAMES) {
            pending.shift();
            droppedFrames += 1;
          }
        }
      },
      finalize() {
        if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: "Finalize" }));
      },
      close() {
        closedByUs = true;
        stopTimers();
        if (ws.readyState === OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close(1000);
        } else {
          ws.close();
        }
      },
    };
  };
}
