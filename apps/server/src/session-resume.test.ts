import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@snowspeak/shared";
import type { ServerConfig } from "./config";
import { startGateway, type Gateway } from "./gateway";
import type { Suggester } from "./suggest/openrouter";
import { createScriptedSttHub } from "./test-support/scripted-stt";
import { TestClient, testConfig } from "./test-support/test-client";
import { waitUntil } from "./test-support/wait";

const segment = (text: string, speechFinal = false) =>
  ({ kind: "segment", text, start: 0, end: 1, speechFinal, fromFinalize: false }) as const;

// Responde depois de um instante: dá tempo de derrubar o socket no meio.
const slowSuggester: Suggester = {
  stream: () =>
    (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield "<en>OK.</en><pt>Certo.</pt>";
    })(),
};

describe("retomada da sessão", () => {
  let gateway: Gateway;

  afterEach(async () => {
    await gateway.close();
  });

  async function setup(overrides: Partial<ServerConfig> = {}) {
    const hub = createScriptedSttHub();
    gateway = await startGateway(testConfig(overrides), { sttFactory: hub.factory, suggester: slowSuggester });
    return hub;
  }

  function startedOf(client: TestClient) {
    const started = client.messages.find((m) => m.type === "session.started");
    if (started?.type !== "session.started") throw new Error("sem session.started");
    return started;
  }

  async function resume(from: TestClient, lastSeq = from.lastSeq(), overrides: Record<string, unknown> = {}) {
    const started = startedOf(from);
    const client = await TestClient.connect(gateway.url);
    client.sendJson({ type: "session.resume", token: "key-1", sessionId: started.sessionId, resumeToken: started.resumeToken, lastSeq, ...overrides });
    return client;
  }

  it("repõe os eventos perdidos em ordem, sem parciais, depois de session.resumed", async () => {
    const hub = await setup();
    const a = await TestClient.started(gateway.url);
    hub.channel("them").emit({ kind: "partial", text: "hel" });
    hub.channel("them").emit(segment("Hello"));
    await a.waitFor((m) => m.type === "transcript.segment");
    a.drop();
    await waitUntil(() => hub.channel("them").closed);
    const b = await resume(a, 0);
    await b.waitFor((m) => m.type === "sentence.ready");
    // Fala sem pontuação: a frase sai no fim da fala, depois do utterance.end.
    expect(b.types()).toEqual(["session.resumed", "transcript.segment", "utterance.end", "sentence.ready"]);
    expect(b.messages[0]).toMatchObject({ type: "session.resumed", throughSeq: 4 });
    expect(b.messages[2]).toMatchObject({ seq: 3, interrupted: true });
  });

  it("reabre o STT e mede a lacuna de áudio da queda", async () => {
    const hub = await setup();
    const a = await TestClient.started(gateway.url);
    a.sendSilence("them", 0);
    a.sendSilence("them", 1);
    await waitUntil(() => hub.channel("them").writes === 2);
    const before = hub.channel("them");
    a.drop();
    const b = await resume(a);
    await b.waitFor((m) => m.type === "session.resumed");
    await waitUntil(() => hub.channel("them") !== before, 3_000);
    b.sendSilence("them", 5);
    const gap = await b.waitFor((m) => m.type === "audio.gap");
    expect(gap).toMatchObject({ channel: "them", durationMs: 300, reason: "client_drop" });
    await waitUntil(() => hub.channel("them").writes === 1);
  });

  it("sugestão concluída durante a queda chega na reposição", async () => {
    await setup();
    const a = await TestClient.started(gateway.url);
    a.sendJson({ type: "suggest.request", requestId: "r1" });
    await a.waitFor((m) => m.type === "suggestion.started");
    const lastSeq = a.lastSeq();
    a.drop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const b = await resume(a, lastSeq);
    const done = await b.waitFor((m) => m.type === "suggestion.done");
    expect(done).toMatchObject({ requestId: "r1", en: "OK.", pt: "Certo." });
  });

  it("socket antigo ainda aberto recebe session.superseded e 4409; o novo assume", async () => {
    await setup();
    const a = await TestClient.started(gateway.url);
    const b = await resume(a);
    await b.waitFor((m) => m.type === "session.resumed");
    await a.waitFor((m) => m.type === "session.superseded");
    expect((await a.closed).code).toBe(4409);
    // O fechamento do socket antigo não derruba a sessão: o novo segue recebendo.
    b.sendJson({ type: "suggest.request", requestId: "r2" });
    await b.waitFor((m) => m.type === "suggestion.started");
  });

  it("session.start com a mesma chave encerra a sessão anterior com replaced e 4410", async () => {
    await setup();
    const a = await TestClient.started(gateway.url);
    await TestClient.started(gateway.url);
    const ended = await a.waitFor((m) => m.type === "session.ended");
    expect(ended).toMatchObject({ reason: "replaced" });
    expect((await a.closed).code).toBe(4410);
  });

  it("chaves diferentes têm sessões independentes", async () => {
    await setup();
    const a = await TestClient.started(gateway.url, "key-1");
    await TestClient.started(gateway.url, "key-2");
    a.sendJson({ type: "suggest.request", requestId: "r3" });
    await a.waitFor((m) => m.type === "suggestion.started");
  });

  it.each([
    ["chave inválida", { token: "nope" }, 4401],
    ["resumeToken errado", { resumeToken: "wrong" }, 4404],
    ["sessão inexistente", { sessionId: "missing" }, 4404],
    ["sessão de outra chave", { token: "key-2" }, 4404],
    ["lastSeq à frente do servidor", { lastSeq: 99 }, 4400],
  ])("recusa a retomada: %s", async (_name, overrides, code) => {
    await setup();
    const a = await TestClient.started(gateway.url);
    a.drop();
    const b = await resume(a, 0, overrides);
    expect((await b.closed).code).toBe(code);
  });

  it("depois do prazo, a sessão expira: STT fechado e retomada com 4404", async () => {
    const hub = await setup({ resumeWindowMs: 50 });
    const a = await TestClient.started(gateway.url);
    a.drop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(hub.channel("them").closed).toBe(true);
    const b = await resume(a, 0);
    expect((await b.closed).code).toBe(4404);
  });

  it("eventos perdidos que já saíram do buffer: encerra a sessão e fecha com 4404", async () => {
    const hub = await setup({ eventBufferSize: 2 });
    const a = await TestClient.started(gateway.url);
    for (const text of ["a", "b", "c"]) hub.channel("them").emit(segment(text));
    await waitUntil(() => a.lastSeq() === 3);
    a.drop();
    const b = await resume(a, 0);
    expect((await b.closed).code).toBe(4404);
    const c = await resume(a, 3);
    expect((await c.closed).code).toBe(4404);
  });

  it("envia heartbeat periódico ao socket ligado", async () => {
    await setup({ heartbeatIntervalMs: 30 });
    const a = await TestClient.started(gateway.url);
    const beat = await a.waitFor((m) => m.type === "heartbeat");
    expect(beat).toMatchObject({ v: 1, sessionId: startedOf(a).sessionId });
    expect("seq" in (beat as ServerMessage)).toBe(false);
  });

  it("derruba o socket que não responde ao ping, e a sessão espera a retomada", async () => {
    await setup({ pingIntervalMs: 40 });
    const a = await TestClient.started(gateway.url);
    // Parado, o cliente não lê o ping nem responde com pong (nem vê o próprio fechamento).
    a.ws.pause();
    await new Promise((resolve) => setTimeout(resolve, 200));
    a.ws.resume();
    expect((await a.closed).code).toBe(1006);
    const b = await resume(a);
    await b.waitFor((m) => m.type === "session.resumed");
  });

  it("POST /dev/drop-sockets derruba as conexões só com devEndpoints", async () => {
    await setup({ devEndpoints: true });
    const a = await TestClient.started(gateway.url);
    const http = gateway.url.replace("ws://", "http://").replace("/ws", "/dev/drop-sockets");
    expect((await fetch(http, { method: "POST" })).status).toBe(204);
    expect((await a.closed).code).toBe(1006);
    const b = await resume(a);
    await b.waitFor((m) => m.type === "session.resumed");
  });

  it("sem devEndpoints, /dev/drop-sockets responde 404", async () => {
    await setup();
    const http = gateway.url.replace("ws://", "http://").replace("/ws", "/dev/drop-sockets");
    expect((await fetch(http, { method: "POST" })).status).toBe(404);
  });
});
