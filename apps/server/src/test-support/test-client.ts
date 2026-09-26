import WebSocket from "ws";
import { encodeFrame, type Channel, type ServerMessage } from "@snowspeak/shared";
import type { ServerConfig } from "../config";

export const ORIGIN = "chrome-extension://test-extension";
export const START = { type: "session.start", token: "key-1", mode: "work", context: "" };

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    accessKeys: new Set(["key-1"]),
    allowedOrigins: new Set([ORIGIN]),
    authTimeoutMs: 200,
    deepgramApiKey: null,
    openRouterApiKey: null,
    suggestionModel: "test-model",
    ...overrides,
  };
}

export class TestClient {
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

  drop(): void {
    this.ws.terminate();
  }

  types(): string[] {
    return this.messages.map((m) => m.type);
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
