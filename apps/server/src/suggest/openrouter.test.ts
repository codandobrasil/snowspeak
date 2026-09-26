import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenRouterSuggester } from "./openrouter";

let server: Server | null = null;
let lastRequest: { headers: IncomingMessage["headers"]; body: Record<string, unknown> } | null = null;

async function startFake(handler: (res: ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastRequest = { headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> };
      handler(res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/chat/completions`;
}

const sse = (res: ServerResponse, lines: string[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const line of lines) res.write(`${line}\n\n`);
  res.end();
};
const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of iterable) out.push(piece);
  return out;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("OpenRouterSuggester", () => {
  it("envia modelo, mensagens e stream com a chave, e entrega os pedaços", async () => {
    const url = await startFake((res) => sse(res, [": OPENROUTER PROCESSING", chunk("<en>Hi"), chunk(" there</en>"), "data: [DONE]"]));
    const suggester = createOpenRouterSuggester({ apiKey: "or-key", model: "anthropic/claude-haiku-4.5", url });
    const pieces = await collect(suggester.stream([{ role: "user", content: "x" }], new AbortController().signal));
    expect(pieces).toEqual(["<en>Hi", " there</en>"]);
    expect(lastRequest?.headers.authorization).toBe("Bearer or-key");
    expect(lastRequest?.body).toMatchObject({ model: "anthropic/claude-haiku-4.5", stream: true, max_tokens: 400, messages: [{ role: "user", content: "x" }] });
  });

  it("junta linhas SSE que chegam quebradas entre pacotes", async () => {
    const url = await startFake((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const line = `${chunk("abc")}\n\n`;
      res.write(line.slice(0, 10));
      setTimeout(() => {
        res.write(line.slice(10));
        res.end("data: [DONE]\n\n");
      }, 10);
    });
    const pieces = await collect(createOpenRouterSuggester({ apiKey: "k", model: "m", url }).stream([], new AbortController().signal));
    expect(pieces).toEqual(["abc"]);
  });

  it("falha com o status quando a API recusa (chave, crédito)", async () => {
    const url = await startFake((res) => res.writeHead(402, { "content-type": "application/json" }).end('{"error":{"message":"no credits"}}'));
    await expect(collect(createOpenRouterSuggester({ apiKey: "k", model: "m", url }).stream([], new AbortController().signal))).rejects.toThrow("402");
  });

  it("falha quando o provedor manda erro no meio do stream", async () => {
    const url = await startFake((res) => sse(res, [chunk("<en>Hi"), `data: ${JSON.stringify({ error: { message: "overloaded" }, choices: [{ finish_reason: "error" }] })}`]));
    await expect(collect(createOpenRouterSuggester({ apiKey: "k", model: "m", url }).stream([], new AbortController().signal))).rejects.toThrow("overloaded");
  });

  it("para quando o pedido é cancelado", async () => {
    const url = await startFake((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`${chunk("<en>Hi")}\n\n`);
    });
    const controller = new AbortController();
    const pieces: string[] = [];
    const run = (async () => {
      for await (const piece of createOpenRouterSuggester({ apiKey: "k", model: "m", url }).stream([], controller.signal)) {
        pieces.push(piece);
        controller.abort();
      }
    })();
    await expect(run).rejects.toThrow();
    expect(pieces).toEqual(["<en>Hi"]);
  });
});
