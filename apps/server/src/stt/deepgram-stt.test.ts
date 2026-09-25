import type { IncomingMessage } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { waitUntil } from "../test-support/wait";
import { createDeepgramSttFactory } from "./deepgram-stt";
import type { SttResult } from "./types";

interface FakeDeepgram {
  server: WebSocketServer;
  url: string;
  connections: Array<{ socket: WebSocket; request: IncomingMessage; received: Array<Buffer | string> }>;
}

async function startFakeDeepgram(options: { reject?: boolean } = {}): Promise<FakeDeepgram> {
  const server = new WebSocketServer({ port: 0, verifyClient: () => !options.reject });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const fake: FakeDeepgram = { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/listen`, connections: [] };
  server.on("connection", (socket, request) => {
    const entry = { socket, request, received: [] as Array<Buffer | string> };
    socket.on("message", (data, isBinary) => entry.received.push(isBinary ? (data as Buffer) : data.toString()));
    fake.connections.push(entry);
  });
  return fake;
}

function collect() {
  const results: SttResult[] = [];
  const errors: Error[] = [];
  return { results, errors, callbacks: { onResult: (r: SttResult) => results.push(r), onError: (e: Error) => errors.push(e) } };
}

describe("DeepgramStt", () => {
  let fake: FakeDeepgram;

  beforeEach(async () => {
    fake = await startFakeDeepgram();
  });

  afterEach(async () => {
    for (const client of fake.server.clients) client.terminate();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it("conecta com a chave e os parâmetros de cada canal", async () => {
    const factory = createDeepgramSttFactory({ apiKey: "test-key", baseUrl: fake.url });
    factory("them", collect().callbacks);
    factory("me", collect().callbacks);
    await waitUntil(() => fake.connections.length === 2);

    const [them, me] = fake.connections.map((c) => new URL(c.request.url ?? "", "http://x").searchParams);
    expect(fake.connections[0]?.request.headers.authorization).toBe("Token test-key");
    expect(Object.fromEntries(them!)).toMatchObject({
      model: "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
    });
    expect(me!.get("language")).toBe("multi");
  });

  it("envia o áudio como binário, inclusive o que chegou antes de a conexão abrir", async () => {
    const stream = createDeepgramSttFactory({ apiKey: "k", baseUrl: fake.url })("them", collect().callbacks);
    stream.write(new Uint8Array([1, 2]));
    await waitUntil(() => fake.connections.length === 1);
    stream.write(new Uint8Array([3, 4]));
    const connection = fake.connections[0]!;
    await waitUntil(() => connection.received.length === 2);
    expect(connection.received.map((m) => Array.from(m as Buffer))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("entrega os resultados interpretados", async () => {
    const c = collect();
    createDeepgramSttFactory({ apiKey: "k", baseUrl: fake.url })("them", c.callbacks);
    await waitUntil(() => fake.connections.length === 1);
    fake.connections[0]!.socket.send(
      JSON.stringify({ type: "Results", is_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: "hello" }] } }),
    );
    await waitUntil(() => c.results.length === 1);
    expect(c.results).toEqual([{ kind: "partial", text: "hello" }]);
  });

  it("envia Finalize e, ao fechar, CloseStream sem reportar erro", async () => {
    const c = collect();
    const stream = createDeepgramSttFactory({ apiKey: "k", baseUrl: fake.url })("them", c.callbacks);
    await waitUntil(() => fake.connections.length === 1);
    const connection = fake.connections[0]!;
    await waitUntil(() => connection.socket.readyState === connection.socket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.finalize();
    stream.close();
    await waitUntil(() => connection.received.length === 2);
    expect(connection.received).toEqual(['{"type":"Finalize"}', '{"type":"CloseStream"}']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(c.errors).toEqual([]);
  });

  it("avisa uma única vez quando a conexão cai", async () => {
    const c = collect();
    createDeepgramSttFactory({ apiKey: "k", baseUrl: fake.url })("them", c.callbacks);
    await waitUntil(() => fake.connections.length === 1);
    fake.connections[0]!.socket.terminate();
    await waitUntil(() => c.errors.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(c.errors).toHaveLength(1);
  });

  it("avisa quando a chave é recusada", async () => {
    const rejecting = await startFakeDeepgram({ reject: true });
    const c = collect();
    createDeepgramSttFactory({ apiKey: "errada", baseUrl: rejecting.url })("them", c.callbacks);
    await waitUntil(() => c.errors.length > 0);
    expect(c.errors[0]?.message).toContain("401");
    for (const client of rejecting.server.clients) client.terminate();
    await new Promise<void>((resolve) => rejecting.server.close(() => resolve()));
  });
  it("desiste quando o Deepgram não completa a conexão no prazo", async () => {
    // Servidor TCP que aceita e nunca responde ao handshake do WebSocket.
    const silent = createTcpServer((socket) => socket.resume());
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const c = collect();
    const url = `ws://127.0.0.1:${(silent.address() as AddressInfo).port}/v1/listen`;
    createDeepgramSttFactory({ apiKey: "k", baseUrl: url, openTimeoutMs: 100 })("them", c.callbacks);
    await waitUntil(() => c.errors.length > 0);
    expect(c.errors[0]?.message).toContain("prazo");
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it("descarta e conta o áudio quando a conexão congestiona", async () => {
    const stream = createDeepgramSttFactory({ apiKey: "k", baseUrl: fake.url, maxBufferedBytes: 64 * 1024 })("them", collect().callbacks);
    await waitUntil(() => fake.connections.length === 1);
    // O "Deepgram" para de ler: o que o cliente envia se acumula no buffer.
    (fake.connections[0]!.socket as unknown as { _socket: { pause(): void } })._socket.pause();
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (let i = 0; i < 5_000; i++) stream.write(new Uint8Array(3_200));
    expect(stream.droppedFrames).toBeGreaterThan(0);
    stream.close();
  });
});
