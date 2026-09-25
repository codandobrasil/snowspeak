import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { CLOSE_CODES, decodeFrame, parseClientMessage, type ServerMessage } from "@snowspeak/shared";
import type { ServerConfig } from "./config";
import { Session } from "./session";
import type { SttFactory } from "./stt/types";
import type { Suggester } from "./suggest/openrouter";
import { TONE_PAGE_HTML } from "./tone-page";

export interface GatewayDeps {
  sttFactory: SttFactory;
  suggester: Suggester;
}

export interface Gateway {
  url: string;
  close(): Promise<void>;
}

export async function startGateway(config: ServerConfig, deps: GatewayDeps): Promise<Gateway> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (req.url === "/tone") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(TONE_PAGE_HTML);
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 64 * 1024,
    verifyClient: (info: { origin: string }) => config.allowedOrigins.has(info.origin),
  });
  wss.on("connection", (ws) => handleConnection(ws, config, deps));
  wss.on("error", (error) => console.warn(`erro no servidor WebSocket: ${error.message}`));

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function handleConnection(ws: WebSocket, config: ServerConfig, deps: GatewayDeps): void {
  let session: Session | null = null;
  let stopping = false;
  let rejectedFrames = 0;

  const send = (message: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const authTimer = setTimeout(() => ws.close(CLOSE_CODES.unauthorized, "auth timeout"), config.authTimeoutMs);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!session) {
        ws.close(CLOSE_CODES.protocolError, "audio before session");
        return;
      }
      if (stopping) return;
      const decoded = decodeFrame(toBytes(data));
      if (!decoded.ok || !session.acceptFrame(decoded.frame)) rejectedFrames += 1;
      return;
    }

    const message = parseClientMessage(data.toString());
    if (!session) {
      if (message?.type !== "session.start") {
        ws.close(CLOSE_CODES.unauthorized, "session.start required");
        return;
      }
      if (!config.accessKeys.has(message.token)) {
        ws.close(CLOSE_CODES.unauthorized, "invalid token");
        return;
      }
      clearTimeout(authTimer);
      session = new Session(
        { sttFactory: deps.sttFactory, suggester: deps.suggester, send },
        { mode: message.mode, context: message.context, profile: message.profile ?? "", job: message.job ?? "" },
      );
      send({ v: 1, type: "session.started", sessionId: session.id, resumeToken: session.resumeToken });
      return;
    }

    if (stopping) return;

    if (message?.type === "session.stop") {
      stopping = true;
      const current = session;
      current.beginStop();
      // Entrega as últimas palavras e frases antes de encerrar.
      void current.drain().finally(() => {
        // close() cancela a sugestão em andamento e avisa antes do session.ended.
        current.close();
        send({ v: 1, type: "session.ended", sessionId: current.id, reason: "stopped" });
        ws.close(CLOSE_CODES.sessionEnded, "stopped");
      });
      return;
    }

    if (message?.type === "session.update") {
      session.update(message);
      return;
    }

    if (message?.type === "suggest.request") {
      session.requestSuggestion(message.requestId);
      return;
    }

    ws.close(CLOSE_CODES.protocolError, "invalid message");
  });

  // Sem este listener, um erro de protocolo (ex.: mensagem acima de maxPayload) derrubaria o processo.
  // O ws já fecha a conexão com o código adequado; só registramos.
  ws.on("error", (error) => console.warn(`conexão encerrada por erro de protocolo: ${error.message}`));

  ws.on("close", () => {
    clearTimeout(authTimer);
    session?.close();
    if (rejectedFrames > 0) console.warn(`conexão encerrada com ${rejectedFrames} frames rejeitados`);
  });
}
