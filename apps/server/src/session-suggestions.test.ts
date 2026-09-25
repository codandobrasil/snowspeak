import { afterEach, describe, expect, it } from "vitest";
import { startGateway, type Gateway } from "./gateway";
import type { SttResult } from "./stt/types";
import type { Suggester } from "./suggest/openrouter";
import type { ChatMessage } from "./suggest/prompt";
import { createScriptedSttHub } from "./test-support/scripted-stt";
import { START, TestClient, testConfig } from "./test-support/test-client";

function recordingSuggester(script?: (signal: AbortSignal) => AsyncIterable<string>) {
  const calls: ChatMessage[][] = [];
  const suggester: Suggester = {
    stream: (messages, signal) => {
      calls.push(messages);
      if (script) return script(signal);
      return (async function* () {
        yield "<en>OK.</en>";
        yield "<pt>Certo.</pt>";
      })();
    },
  };
  return { suggester, calls };
}

// Só termina quando cancelado.
const hanging = (signal: AbortSignal): AsyncIterable<string> =>
  (async function* () {
    yield "<en>Partial";
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  })();

const finalSegment = (text: string): SttResult => ({ kind: "segment", text, start: 0, end: 1, speechFinal: true, fromFinalize: false });

describe("sugestões de ponta a ponta", () => {
  let gateway: Gateway;

  afterEach(async () => {
    await gateway.close();
  });

  async function setup(script?: (signal: AbortSignal) => AsyncIterable<string>) {
    const hub = createScriptedSttHub();
    const recorder = recordingSuggester(script);
    gateway = await startGateway(testConfig(), { sttFactory: hub.factory, suggester: recorder.suggester });
    return { hub, ...recorder };
  }

  it("pergunta do participante gera sugestão automática", async () => {
    const { hub } = await setup();
    const client = await TestClient.started(gateway.url);
    hub.channel("them").emit(finalSegment("Tell me about yourself."));
    const done = await client.waitFor((m) => m.type === "suggestion.done");
    expect(done).toMatchObject({ en: "OK.", pt: "Certo." });
    expect(client.messages.find((m) => m.type === "suggestion.started")).toMatchObject({ trigger: "auto", basedOnUtteranceId: "them-1" });
  });

  it("suggest.request gera sugestão a pedido", async () => {
    await setup();
    const client = await TestClient.started(gateway.url);
    client.sendJson({ type: "suggest.request", requestId: "r1" });
    await client.waitFor((m) => m.type === "suggestion.done");
    expect(client.messages.find((m) => m.type === "suggestion.started")).toMatchObject({ requestId: "r1", trigger: "manual" });
  });

  it("session.update muda o currículo usado nas próximas sugestões", async () => {
    const { calls } = await setup();
    const client = await TestClient.connect(gateway.url);
    client.sendJson({ ...START, mode: "interview", profile: "Primeira versão" });
    await client.waitFor((m) => m.type === "session.started");
    client.sendJson({ type: "session.update", profile: "Kafka expert at Nubank" });
    client.sendJson({ type: "suggest.request", requestId: "r1" });
    await client.waitFor((m) => m.type === "suggestion.done");
    const prompt = calls[0]?.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain("Kafka expert at Nubank");
    expect(prompt).not.toContain("Primeira versão");
  });

  it("parar cancela a sugestão em andamento e nada chega depois de session.ended", async () => {
    await setup(hanging);
    const client = await TestClient.started(gateway.url);
    client.sendJson({ type: "suggest.request", requestId: "r1" });
    await client.waitFor((m) => m.type === "suggestion.started");
    client.sendJson({ type: "session.stop" });
    expect((await client.closed).code).toBe(4410);
    expect(client.types().at(-1)).toBe("session.ended");
    expect(client.messages.find((m) => m.type === "suggestion.error")).toMatchObject({ requestId: "r1", code: "cancelled" });
  });
});
