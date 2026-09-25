import { afterEach, describe, expect, it } from "vitest";
import { startGateway, type Gateway } from "./gateway";
import type { SttResult } from "./stt/types";
import { createScriptedSttHub } from "./test-support/scripted-stt";
import { TestClient, testConfig } from "./test-support/test-client";
import { waitUntil } from "./test-support/wait";

const segment = (text: string, start: number, end: number, flags: { speechFinal?: boolean; fromFinalize?: boolean } = {}): SttResult => ({
  kind: "segment",
  text,
  start,
  end,
  speechFinal: flags.speechFinal ?? false,
  fromFinalize: flags.fromFinalize ?? false,
});

describe("transcrição de ponta a ponta", () => {
  let gateway: Gateway;

  afterEach(async () => {
    await gateway.close();
  });

  async function setup() {
    const hub = createScriptedSttHub();
    gateway = await startGateway(testConfig(), { sttFactory: hub.factory });
    const client = await TestClient.started(gateway.url);
    return { hub, client };
  }

  const events = (client: TestClient, type: string) => client.messages.filter((m) => m.type === type);

  it("transmite parcial, segmentos e fim de fala com o mesmo utteranceId", async () => {
    const { hub, client } = await setup();
    const them = hub.channel("them");
    them.emit({ kind: "partial", text: "hello" });
    them.emit(segment("Hello there.", 0, 0.8, { speechFinal: true }));
    await client.waitFor((m) => m.type === "utterance.end");
    expect(client.messages.filter((m) => m.type !== "session.started" && m.type !== "sentence.ready")).toMatchObject([
      { type: "transcript.partial", channel: "them", utteranceId: "them-1", text: "hello" },
      { type: "transcript.segment", channel: "them", utteranceId: "them-1", segmentIdx: 0, text: "Hello there." },
      { type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: false },
    ]);
  });

  it("envia a frase do canal them assim que ela termina", async () => {
    const { hub, client } = await setup();
    hub.channel("them").emit(segment("Hello there.", 0, 0.8));
    const sentence = await client.waitFor((m) => m.type === "sentence.ready");
    expect(sentence).toMatchObject({ channel: "them", utteranceId: "them-1", sentenceIdx: 0, text: "Hello there." });
  });

  it("frase sem pontuação sai no fim da fala", async () => {
    const { hub, client } = await setup();
    const them = hub.channel("them");
    them.emit(segment("so we were thinking", 0, 1));
    them.emit(segment("about it", 1.1, 1.5, { speechFinal: true }));
    const sentence = await client.waitFor((m) => m.type === "sentence.ready");
    expect(sentence).toMatchObject({ sentenceIdx: 0, text: "so we were thinking about it" });
  });

  it("não gera frases para as falas do usuário", async () => {
    const { hub, client } = await setup();
    hub.channel("me").emit(segment("Sure, sounds good.", 0, 1, { speechFinal: true }));
    await client.waitFor((m) => m.type === "utterance.end" && m.channel === "me");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events(client, "sentence.ready")).toEqual([]);
  });

  it("fecha a fala como interrompida e avisa quando o STT cai, sem derrubar a sessão", async () => {
    const { hub, client } = await setup();
    const them = hub.channel("them");
    them.emit({ kind: "partial", text: "and then we" });
    them.fail();
    const error = await client.waitFor((m) => m.type === "error");
    expect(error).toMatchObject({ scope: "stt", code: "stt_connection_lost", retryable: false, channel: "them" });
    expect(events(client, "utterance.end")).toMatchObject([{ utteranceId: "them-1", interrupted: true }]);
    expect(client.ws.readyState).toBe(client.ws.OPEN);
  });

  it("ao parar, pede Finalize e entrega a fala e a frase antes de encerrar", async () => {
    const { hub, client } = await setup();
    const them = hub.channel("them");
    client.sendSilence("them", 0);
    await waitUntil(() => them.writes === 1);
    them.emit({ kind: "partial", text: "almost do" });
    them.onFinalize = () => them.emit(segment("almost done", 0, 0.9, { fromFinalize: true }));
    client.sendJson({ type: "session.stop" });
    expect((await client.closed).code).toBe(4410);
    expect(them.finalizes).toBe(1);
    const order = client.types().filter((t) => t !== "session.started" && t !== "transcript.partial");
    expect(order).toEqual(["transcript.segment", "utterance.end", "sentence.ready", "session.ended"]);
    expect(events(client, "utterance.end")).toMatchObject([{ interrupted: false }]);
    expect(them.closed).toBe(true);
  });

  it("ao parar sem resposta do STT, fecha a fala como interrompida em até 500 ms", async () => {
    const { hub, client } = await setup();
    hub.channel("them").emit({ kind: "partial", text: "wait for" });
    const stoppedAt = Date.now();
    client.sendJson({ type: "session.stop" });
    await client.closed;
    expect(Date.now() - stoppedAt).toBeLessThan(1_500);
    expect(events(client, "utterance.end")).toMatchObject([{ utteranceId: "them-1", interrupted: true }]);
    expect(client.types().at(-1)).toBe("session.ended");
  });

  it("fecha as conexões de STT quando o socket cai", async () => {
    const { hub, client } = await setup();
    client.drop();
    await waitUntil(() => hub.channel("them").closed && hub.channel("me").closed);
  });

  it("ignora áudio e mensagens enquanto finaliza o Parar", async () => {
    const { hub, client } = await setup();
    hub.channel("them").emit({ kind: "partial", text: "slow" });
    client.sendJson({ type: "session.stop" });
    client.sendSilence("them", 0);
    expect((await client.closed).code).toBe(4410);
    expect(hub.channel("them").writes).toBe(0);
    expect(client.types()).toContain("session.ended");
  });
  it("ao parar antes do primeiro parcial, finaliza e entrega a fala", async () => {
    const { hub, client } = await setup();
    const them = hub.channel("them");
    client.sendSilence("them", 0);
    await waitUntil(() => them.writes === 1);
    them.onFinalize = () => them.emit(segment("Hi there.", 0, 0.5, { fromFinalize: true }));
    client.sendJson({ type: "session.stop" });
    await client.closed;
    expect(them.finalizes).toBe(1);
    const order = client.types().filter((t) => t !== "session.started");
    // Com ponto final, a frase sai junto com o segmento, antes do fim da fala.
    expect(order).toEqual(["transcript.segment", "sentence.ready", "utterance.end", "session.ended"]);
  });

  it("sem áudio enviado, parar não pede Finalize", async () => {
    const { hub, client } = await setup();
    client.sendJson({ type: "session.stop" });
    await client.closed;
    expect(hub.channel("them").finalizes).toBe(0);
    expect(hub.channel("me").finalizes).toBe(0);
  });
  it("o aviso de queda do STT diz qual transcrição parou", async () => {
    const { hub, client } = await setup();
    hub.channel("me").fail();
    const error = await client.waitFor((m) => m.type === "error");
    expect(error).toMatchObject({ channel: "me", message: "A transcrição da sua voz parou: a conexão com o provedor caiu." });
    hub.channel("them").fail();
    const second = await client.waitFor((m) => m.type === "error" && m.channel === "them");
    expect(second).toMatchObject({ message: "A transcrição dos participantes parou: a conexão com o provedor caiu." });
  });
});
