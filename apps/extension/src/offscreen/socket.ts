import { parseServerMessage } from "@snowspeak/shared";
import type { ControllerSocket, SocketHandlers } from "./session-controller";

/** Lança SyntaxError de forma síncrona se a URL for inválida. */
export function openBrowserSocket(url: string, handlers: SocketHandlers): ControllerSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const message = parseServerMessage(event.data);
    if (message) handlers.onMessage(message);
    else console.warn("mensagem do servidor inválida descartada");
  };
  ws.onclose = (event) => handlers.onClose(event.code, event.reason);

  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    send(data) {
      ws.send(data);
    },
    sendJson(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    close() {
      ws.onclose = null;
      ws.close(1000);
    },
  };
}
