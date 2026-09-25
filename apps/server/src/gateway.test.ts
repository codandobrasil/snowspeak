import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { encodeFrame, type Channel, type ServerMessage } from "@snowspeak/shared";
import type { ServerConfig } from "./config";
import { startGateway, type Gateway } from "./gateway";
import { createFakeSttFactory } from "./stt/fake-stt";
import { sinePcm } from "./test-support/sine";

const ORIGIN = "chrome-extension://test-extension";
const START = { type: "session.start", token: "key-1", mode: "work", context: "" };

const config: ServerConfig = {
  port: 0,
  host: "127.0.0.1",
  accessKeys: new Set(["key-1"]),
  allowedOrigins: new Set([ORIGIN]),
  authTimeoutMs: 200,
};

class TestClient {
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  static async connect(url: string, origin = ORIGIN): Promise<TestClient> {
    const ws = new WebSocket(url, { origin });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new TestClient(ws);
  }

  static async started(url: string): Promise<TestClient> {
    const client = await TestClient.connect(url);
    client.sendJson(START);
    await client.waitFor((m) => m.type === "session.started");
    return client;
  }

  sendJson(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendFrame(channel: Channel, frameSeq: number, sampleOffset: number, pcm: Uint8Array): void {
    this.ws.send(encodeFrame({ channel, frameSeq, sampleOffset, pcm }));
  }

  sendSilence(channel: Channel, frameSeq: number): void {
    this.sendFrame(channel, frameSeq, frameSeq * 1600, new Uint8Array(3200));
  }

  partials(channel: Channel): string[] {
    return this.messages.flatMap((m) => (m.type === "transcript.partial" && m.channel === channel ? [m.text] : []));
  }

  async stopAndWaitClose(): Promise<void> {
    this.sendJson({ type: "session.stop" });
    await this.closed;
  }

  async waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs = 2_000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout; recebidas: ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

describe("gateway", () => {
  let gateway: Gateway;

  beforeEach(async () => {
    gateway = await startGateway(config, { sttFactory: createFakeSttFactory() });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("inicia a sessão com chave válida", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendJson(START);
    const started = await client.waitFor((m) => m.type === "session.started");
    if (started.type !== "session.started") throw new Error("tipo inesperado");
    expect(started.v).toBe(1);
    expect(started.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.resumeToken.length).toBeGreaterThanOrEqual(43);
  });

  it("fecha com 4401 quando a chave é inválida", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendJson({ ...START, token: "errada" });
    expect((await client.closed).code).toBe(4401);
  });

  it("fecha com 4401 quando nenhuma mensagem chega no prazo", async () => {
    const client = await TestClient.connect(gateway.url);
    expect((await client.closed).code).toBe(4401);
  });

  it("fecha com 4401 quando a primeira mensagem não é session.start", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendJson({ type: "session.stop" });
    expect((await client.closed).code).toBe(4401);
  });

  it("recusa a conexão de uma origem não permitida", async () => {
    await expect(TestClient.connect(gateway.url, "https://evil.example")).rejects.toThrow(/401/);
  });

  it("fecha com 4400 quando chega áudio antes da sessão", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendSilence("them", 0);
    expect((await client.closed).code).toBe(4400);
  });

  it("encaminha os frames de cada canal ao STT e devolve eventos com seq", async () => {
    const client = await TestClient.started(gateway.url);
    for (let i = 0; i < 10; i++) client.sendSilence("them", i);
    for (let i = 0; i < 10; i++) client.sendSilence("me", i);

    const them = await client.waitFor((m) => m.type === "transcript.partial" && m.channel === "them");
    const me = await client.waitFor((m) => m.type === "transcript.partial" && m.channel === "me");
    expect(them).toMatchObject({ seq: 1, text: "[fake-stt them] 1.0 s · silêncio" });
    expect(me).toMatchObject({ seq: 2, text: "[fake-stt me] 1.0 s · silêncio" });
  });

  it("confere nível e frequência de um seno de 440 Hz recebido", async () => {
    const client = await TestClient.started(gateway.url);
    for (let i = 0; i < 10; i++) {
      client.sendFrame("them", i, i * 1600, sinePcm({ frequencyHz: 440, amplitude: 0.5, startSample: i * 1600, samples: 1600 }));
    }
    const partial = await client.waitFor((m) => m.type === "transcript.partial");
    expect(partial).toMatchObject({ text: "[fake-stt them] 1.0 s · -9 dBFS · ~440 Hz" });
  });

  it("descarta frame malformado sem fechar a conexão", async () => {
    const client = await TestClient.started(gateway.url);
    client.ws.send(new Uint8Array(9 + 3)); // payload ímpar
    client.ws.send(new Uint8Array(9 + 3200 + 2)); // grande demais
    for (let i = 0; i < 10; i++) client.sendSilence("them", i);

    await client.waitFor((m) => m.type === "transcript.partial");
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("ignora frames duplicados ou reenviados", async () => {
    const client = await TestClient.started(gateway.url);
    for (let i = 0; i < 10; i++) client.sendSilence("them", i);
    for (let i = 0; i < 10; i++) client.sendSilence("them", i); // reenvio
    for (let i = 10; i < 20; i++) client.sendSilence("them", i);
    await client.stopAndWaitClose();
    expect(client.partials("them")).toEqual(["[fake-stt them] 1.0 s · silêncio", "[fake-stt them] 2.0 s · silêncio"]);
  });

  it("emite audio.gap com a duração exata quando o cliente pula áudio", async () => {
    const client = await TestClient.started(gateway.url);
    client.sendFrame("me", 0, 0, new Uint8Array(3200));
    client.sendFrame("me", 2, 3200, new Uint8Array(3200)); // frame 1 (1600 samples) descartado no cliente
    const gap = await client.waitFor((m) => m.type === "audio.gap");
    expect(gap).toMatchObject({ channel: "me", durationMs: 100, reason: "client_drop", seq: 1 });
  });

  it("session.stop envia session.ended e fecha com 4410", async () => {
    const client = await TestClient.started(gateway.url);
    client.sendJson({ type: "session.stop" });
    expect((await client.closed).code).toBe(4410);
    expect(client.messages.at(-1)).toMatchObject({ type: "session.ended", reason: "stopped" });
  });

  it("fecha com 4400 quando a mensagem JSON é inválida", async () => {
    const client = await TestClient.started(gateway.url);
    client.ws.send("{quebrado");
    expect((await client.closed).code).toBe(4400);
  });

  it("serve a página de tom de teste em /tone", async () => {
    const response = await fetch(gateway.url.replace("ws://", "http://").replace("/ws", "/tone"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("440");
  });
});
