import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { CLOSE_CODES, decodeFrame, parseClientMessage, type ClientMessage, type ServerMessage } from "@snowspeak/shared";
import type { ServerConfig } from "./config";
import { Session, type SessionOwner } from "./session";
import { SessionRegistry } from "./session-registry";
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
  const registry = new SessionRegistry();
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (req.url === "/tone") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(TONE_PAGE_HTML);
      return;
    }
    // Só para validar a retomada: derruba as conexões sem encerrar as sessões.
    if (config.devEndpoints && req.method === "POST" && req.url === "/dev/drop-sockets") {
      for (const client of wss.clients) client.terminate();
      res.writeHead(204).end();
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
  wss.on("connection", (ws) => handleConnection(ws, config, deps, registry));
  wss.on("error", (error) => console.warn(`erro no servidor WebSocket: ${error.message}`));

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    async close() {
      for (const client of wss.clients) client.terminate();
      registry.endAll();
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

function handleConnection(ws: WebSocket, config: ServerConfig, deps: GatewayDeps, registry: SessionRegistry): void {
  let session: Session | null = null;
  let stopping = false;
  let rejectedFrames = 0;
  let answeredPing = true;

  const send = (message: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const owner: SessionOwner = { send, close: (code, reason) => ws.close(code, reason) };
  // Depois de uma retomada por outro socket, este deixa de mandar na sessão.
  const ownsSession = (): boolean => session !== null && session.owner === owner;

  const authTimer = setTimeout(() => ws.close(CLOSE_CODES.unauthorized, "auth timeout"), config.authTimeoutMs);
  const heartbeat = setInterval(() => {
    if (session && ownsSession()) send({ v: 1, type: "heartbeat", sessionId: session.id });
  }, config.heartbeatIntervalMs);
  ws.on("pong", () => {
    answeredPing = true;
  });
  const ping = setInterval(() => {
    if (!answeredPing) {
      ws.terminate();
      return;
    }
    answeredPing = false;
    ws.ping();
  }, config.pingIntervalMs);

  const startSession = (message: Extract<ClientMessage, { type: "session.start" }>): Session | null => {
    if (!config.accessKeys.has(message.token)) {
      ws.close(CLOSE_CODES.unauthorized, "invalid token");
      return null;
    }
    clearTimeout(authTimer);
    // Uma sessão ativa por chave: a anterior é encerrada.
    const previous = registry.activeFor(message.token);
    if (previous) {
      const previousOwner = previous.owner;
      registry.end(previous);
      previousOwner?.send({ v: 1, type: "session.ended", sessionId: previous.id, reason: "replaced" });
      previousOwner?.close(CLOSE_CODES.sessionEnded, "replaced");
    }
    const created = new Session(
      { sttFactory: deps.sttFactory, suggester: deps.suggester, eventBufferSize: config.eventBufferSize },
      { mode: message.mode, context: message.context, profile: message.profile ?? "", job: message.job ?? "" },
      message.token,
    );
    registry.add(created);
    created.attach(owner);
    send({ v: 1, type: "session.started", sessionId: created.id, resumeToken: created.resumeToken });
    return created;
  };

  const resumeSession = (message: Extract<ClientMessage, { type: "session.resume" }>): Session | null => {
    if (!config.accessKeys.has(message.token)) {
      ws.close(CLOSE_CODES.unauthorized, "invalid token");
      return null;
    }
    clearTimeout(authTimer);
    const target = registry.get(message.sessionId);
    if (!target || target.resumeToken !== message.resumeToken || target.accessKey !== message.token) {
      ws.close(CLOSE_CODES.sessionNotFound, "session not found");
      return null;
    }
    const check = target.replayCheck(message.lastSeq);
    if (check === "ahead") {
      ws.close(CLOSE_CODES.protocolError, "lastSeq ahead");
      return null;
    }
    if (check === "gap") {
      // Eventos perdidos já saíram do buffer: não há como repor.
      registry.end(target);
      ws.close(CLOSE_CODES.sessionNotFound, "events lost");
      return null;
    }
    const previousOwner = target.owner;
    if (previousOwner) {
      previousOwner.send({ v: 1, type: "session.superseded", sessionId: target.id });
      previousOwner.close(CLOSE_CODES.superseded, "superseded");
    }
    registry.cancelExpiry(target);
    target.resume(owner, message.lastSeq);
    return target;
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!session) {
        ws.close(CLOSE_CODES.protocolError, "audio before session");
        return;
      }
      if (stopping || !ownsSession()) return;
      const decoded = decodeFrame(toBytes(data));
      if (!decoded.ok || !session.acceptFrame(decoded.frame)) rejectedFrames += 1;
      return;
    }

    const message = parseClientMessage(data.toString());
    if (!session) {
      if (message?.type === "session.start") session = startSession(message);
      else if (message?.type === "session.resume") session = resumeSession(message);
      else ws.close(CLOSE_CODES.unauthorized, "session.start required");
      return;
    }

    if (stopping || !ownsSession()) return;

    if (message?.type === "session.stop") {
      stopping = true;
      const current = session;
      current.beginStop();
      // Entrega as últimas palavras e frases antes de encerrar.
      void current.drain().finally(() => {
        // end() cancela a sugestão em andamento e avisa antes do session.ended.
        registry.end(current);
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
      session.requestSuggestion(message.requestId, message.question);
      return;
    }

    ws.close(CLOSE_CODES.protocolError, "invalid message");
  });

  // Sem este listener, um erro de protocolo (ex.: mensagem acima de maxPayload) derrubaria o processo.
  // O ws já fecha a conexão com o código adequado; só registramos.
  ws.on("error", (error) => console.warn(`conexão encerrada por erro de protocolo: ${error.message}`));

  ws.on("close", () => {
    clearTimeout(authTimer);
    clearInterval(heartbeat);
    clearInterval(ping);
    // Queda: a sessão espera a retomada. Socket já substituído ou sessão parando: nada a fazer.
    if (session && ownsSession() && !stopping) {
      session.detach();
      registry.expireIn(session, config.resumeWindowMs);
    }
    if (rejectedFrames > 0) console.warn(`conexão encerrada com ${rejectedFrames} frames rejeitados`);
  });
}
