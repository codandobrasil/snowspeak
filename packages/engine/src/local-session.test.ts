import { describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "@snowspeak/shared";
import { LocalSession } from "./local-session";
import type { SttResult } from "./stt/types";
import type { Suggester } from "./suggest/openrouter";
import type { ChatMessage } from "./suggest/prompt";
import { createScriptedSttHub } from "./test-support/scripted-stt";

const segment = (text: string, start: number, end: number, flags: { speechFinal?: boolean; fromFinalize?: boolean } = {}): SttResult => ({
  kind: "segment",
  text,
  start,
  end,
  speechFinal: flags.speechFinal ?? false,
  fromFinalize: flags.fromFinalize ?? false,
});
const finalSegment = (text: string): SttResult => segment(text, 0, 1, { speechFinal: true });

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

const SETTINGS = { mode: "interview" as const, context: "", profile: "Primeira versão", job: "" };
const pcm = (): Uint8Array => new Uint8Array(3200);

function create(suggester: Suggester | null = recordingSuggester().suggester) {
  const hub = createScriptedSttHub();
  const messages: EngineMessage[] = [];
  const session = new LocalSession({ sttFactory: hub.factory, suggester, onMessage: (message) => messages.push(message) }, SETTINGS);
  return {
    hub,
    session,
    messages,
    types: () => messages.map((m) => m.type),
    of: (type: EngineMessage["type"]) => messages.filter((m) => m.type === type),
  };
}

async function started(suggester?: Suggester | null) {
  const t = create(suggester);
  const starting = t.session.start();
  t.hub.channel("them").open();
  await starting;
  t.hub.channel("me").open();
  return t;
}

describe("LocalSession", () => {
  it("abre o Deepgram dos participantes, anuncia a sessão e só então abre o do microfone", async () => {
    const t = create();
    const starting = t.session.start();
    expect(t.hub.streamsCreated("them")).toBe(1);
    expect(t.hub.streamsCreated("me")).toBe(0);
    expect(t.messages).toEqual([]);
    t.hub.channel("them").open();
    await starting;
    expect(t.messages).toEqual([{ v: 1, type: "session.started", sessionId: t.session.id }]);
    expect(t.hub.streamsCreated("me")).toBe(1);
  });

  it("rejeita o início quando a primeira conexão dos participantes falha, sem anunciar nada", async () => {
    const t = create();
    const starting = t.session.start();
    t.hub.channel("them").fail();
    await expect(starting).rejects.toThrow("falha roteirizada");
    expect(t.messages).toEqual([]);
    expect(t.hub.channel("them").closed).toBe(true);
    expect(t.hub.streamsCreated("me")).toBe(0);
  });

  it("fechar durante o início rejeita o start e não emite nada", async () => {
    const t = create();
    const starting = t.session.start();
    t.session.close("stopped");
    await expect(starting).rejects.toThrow();
    expect(t.messages).toEqual([]);
    expect(t.hub.channel("them").closed).toBe(true);
  });

  it("transmite parcial, segmentos e fim de fala com o mesmo utteranceId", async () => {
    const t = await started();
    const them = t.hub.channel("them");
    them.emit({ kind: "partial", text: "hello" });
    them.emit(segment("Hello there.", 0, 0.8, { speechFinal: true }));
    expect(t.messages.filter((m) => m.type !== "session.started" && m.type !== "sentence.ready")).toMatchObject([
      { type: "transcript.partial", channel: "them", utteranceId: "them-1", text: "hello", seq: 1, sessionId: t.session.id },
      { type: "transcript.segment", channel: "them", utteranceId: "them-1", segmentIdx: 0, text: "Hello there." },
      { type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: false },
    ]);
  });

  it("gera frases só para o canal dos participantes", async () => {
    const t = await started();
    t.hub.channel("me").emit(segment("Sure, sounds good.", 0, 1, { speechFinal: true }));
    t.hub.channel("them").emit(segment("Hello there.", 0, 0.8));
    expect(t.of("sentence.ready")).toMatchObject([{ channel: "them", utteranceId: "them-1", sentenceIdx: 0, text: "Hello there." }]);
  });

  it("ao parar, pede Finalize e entrega a fala e a frase antes de encerrar", async () => {
    const t = await started();
    const them = t.hub.channel("them");
    t.session.acceptPcm("them", pcm());
    them.emit({ kind: "partial", text: "almost do" });
    them.onFinalize = () => them.emit(segment("almost done", 0, 0.9, { fromFinalize: true }));
    t.session.beginStop();
    await t.session.drain();
    t.session.close("stopped");
    expect(them.finalizes).toBe(1);
    expect(t.types().filter((type) => type !== "session.started" && type !== "transcript.partial")).toEqual([
      "transcript.segment",
      "utterance.end",
      "sentence.ready",
      "session.ended",
    ]);
    expect(t.messages.at(-1)).toEqual({ v: 1, type: "session.ended", sessionId: t.session.id, reason: "stopped" });
    expect(them.closed).toBe(true);
  });

  it("ignora o áudio depois do início do Parar", async () => {
    const t = await started();
    t.session.beginStop();
    t.session.acceptPcm("them", pcm());
    expect(t.hub.channel("them").writes).toBe(0);
  });

  it("sem áudio enviado, parar não pede Finalize", async () => {
    const t = await started();
    await t.session.drain();
    expect(t.hub.channel("them").finalizes).toBe(0);
    expect(t.hub.channel("me").finalizes).toBe(0);
  });

  it("numera os frames de cada canal e conta o que foi ao Deepgram", async () => {
    const t = await started();
    t.session.acceptPcm("them", pcm());
    t.session.acceptPcm("them", pcm());
    t.session.acceptPcm("me", pcm());
    expect(t.hub.channel("them").writes).toBe(2);
    expect(t.session.stats()).toEqual({ them: { sentFrames: 2, droppedFrames: 0 }, me: { sentFrames: 1, droppedFrames: 0 } });
  });

  it("microfone que não conecta entra em reconexão sem derrubar a sessão", async () => {
    const t = create();
    const starting = t.session.start();
    t.hub.channel("them").open();
    await starting;
    t.hub.channel("me").fail();
    expect(t.of("stt.status")).toMatchObject([{ channel: "me", state: "reconnecting" }]);
    t.session.close("stopped");
  });

  it("pergunta do participante gera sugestão automática", async () => {
    const t = await started();
    t.hub.channel("them").emit(finalSegment("Tell me about yourself."));
    await vi.waitFor(() => expect(t.of("suggestion.done")).toHaveLength(1));
    expect(t.of("suggestion.done")[0]).toMatchObject({ en: "OK.", pt: "Certo." });
    expect(t.of("suggestion.started")[0]).toMatchObject({ trigger: "auto", basedOnUtteranceId: "them-1" });
  });

  it("requestSuggestion com a pergunta escolhida responde a ela", async () => {
    const r = recordingSuggester();
    const t = await started(r.suggester);
    t.session.requestSuggestion("r1", { utteranceId: "them-7", text: "Why this company?" });
    await vi.waitFor(() => expect(t.of("suggestion.done")).toHaveLength(1));
    expect(t.of("suggestion.started")[0]).toMatchObject({ requestId: "r1", trigger: "manual", basedOnUtteranceId: "them-7" });
    expect(r.calls[0]?.[1]?.content).toContain("QUESTION TO ANSWER:\nWhy this company?");
  });

  it("update muda o currículo usado nas próximas sugestões", async () => {
    const r = recordingSuggester();
    const t = await started(r.suggester);
    t.session.update({ profile: "Kafka expert at Nubank" });
    t.session.requestSuggestion("r1");
    await vi.waitFor(() => expect(r.calls).toHaveLength(1));
    const prompt = r.calls[0]?.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain("Kafka expert at Nubank");
    expect(prompt).not.toContain("Primeira versão");
  });

  it("fechar cancela a sugestão em andamento e session.ended é a última mensagem", async () => {
    const t = await started(recordingSuggester(hanging).suggester);
    t.session.requestSuggestion("r1");
    expect(t.of("suggestion.started")).toHaveLength(1);
    t.session.close("stopped");
    expect(t.of("suggestion.error")).toMatchObject([{ requestId: "r1", code: "cancelled" }]);
    expect(t.types().at(-1)).toBe("session.ended");
  });

  it("uma pergunta finalizada durante o Parar não gera sugestão", async () => {
    const r = recordingSuggester();
    const t = await started(r.suggester);
    const them = t.hub.channel("them");
    t.session.acceptPcm("them", pcm());
    them.emit({ kind: "partial", text: "tell me about" });
    them.onFinalize = () => them.emit(segment("Tell me about yourself.", 0, 1, { fromFinalize: true }));
    t.session.beginStop();
    await t.session.drain();
    expect(t.types()).not.toContain("suggestion.started");
    expect(r.calls).toHaveLength(0);
  });

  it("sem suggester, não há sugestão automática nem a pedido", async () => {
    const t = await started(null);
    t.hub.channel("them").emit(finalSegment("Tell me about yourself."));
    t.session.requestSuggestion("r1");
    expect(t.types().filter((type) => type.startsWith("suggestion."))).toEqual([]);
  });
});
