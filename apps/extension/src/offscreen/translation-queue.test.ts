import { describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@snowspeak/shared";
import { SessionStore } from "./session-store";
import {
  MAX_PENDING_TRANSLATIONS,
  TRANSLATOR_RETRY_MS,
  TRANSLATOR_RETRY_NOTICE,
  TranslationQueue,
  type SentenceTranslator,
} from "./translation-queue";

let seq = 0;
const started = (sessionId: string): ServerMessage => ({ v: 1, type: "session.started", sessionId, resumeToken: "r" });
const segment = (sessionId: string, text: string): ServerMessage => ({
  v: 1,
  sessionId,
  seq: ++seq,
  ts: 0,
  type: "transcript.segment",
  channel: "them",
  utteranceId: "them-1",
  segmentIdx: 0,
  text,
});
const sentence = (sessionId: string, sentenceIdx: number, text: string): ServerMessage => ({
  v: 1,
  sessionId,
  seq: ++seq,
  ts: 0,
  type: "sentence.ready",
  channel: "them",
  utteranceId: "them-1",
  sentenceIdx,
  text,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function translatorOf(translate: (text: string) => Promise<string>) {
  const destroy = vi.fn(() => undefined);
  return { translate, destroy } satisfies SentenceTranslator;
}

function setup(provide: () => Promise<SentenceTranslator>, now: () => number = () => 0) {
  seq = 0;
  const store = new SessionStore();
  const queue = new TranslationQueue(provide, store, { now });
  // No offscreen, o controlador aplica a mensagem ao store e depois a repassa à fila.
  const deliver = (message: ServerMessage) => {
    store.dispatch({ type: "server", message });
    queue.handle(message);
  };
  deliver(started("s1"));
  deliver(segment("s1", "Hi. Bye."));
  return { store, deliver, sentences: () => store.snapshot().captions[0]?.sentences };
}

describe("TranslationQueue", () => {
  it("traduz cada frase pronta e grava no store", async () => {
    const t = setup(async () => translatorOf(async (text) => `pt:${text}`));
    t.deliver(sentence("s1", 0, "Hi."));
    t.deliver(sentence("s1", 1, "Bye."));
    await flush();
    expect(t.sentences()).toEqual({
      0: { source: "Hi.", translation: "pt:Hi.", failed: false },
      1: { source: "Bye.", translation: "pt:Bye.", failed: false },
    });
  });

  it("cria o tradutor uma vez por sessão e libera o da sessão anterior", async () => {
    const first = translatorOf(async (text) => `pt:${text}`);
    const provide = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(translatorOf(async (text) => `pt2:${text}`));
    const t = setup(provide);
    t.deliver(sentence("s1", 0, "Hi."));
    t.deliver(sentence("s1", 1, "Bye."));
    await flush();
    expect(provide).toHaveBeenCalledTimes(1);
    t.deliver(started("s2"));
    await flush();
    expect(first.destroy).toHaveBeenCalledTimes(1);
    t.deliver(segment("s2", "Again."));
    t.deliver(sentence("s2", 0, "Again."));
    await flush();
    expect(provide).toHaveBeenCalledTimes(2);
  });

  it("descarta a tradução atrasada da sessão anterior", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const translator = translatorOf(() => new Promise<string>((resolve) => resolvers.push(resolve)));
    const t = setup(async () => translator);
    t.deliver(sentence("s1", 0, "Old."));
    await flush();
    t.deliver(started("s2"));
    t.deliver(segment("s2", "New."));
    t.deliver(sentence("s2", 0, "New."));
    await flush();
    resolvers[0]?.("velha");
    await flush();
    expect(t.sentences()?.[0]).toEqual({ source: "New.", translation: null, failed: false });
    resolvers[1]?.("nova");
    await flush();
    expect(t.sentences()?.[0]?.translation).toBe("nova");
  });

  it("sem tradutor: um aviso só e as frases ficam em inglês marcadas como falha", async () => {
    const t = setup(() => Promise.reject(new Error("NotSupportedError")));
    const notices: Array<string | null> = [];
    t.store.subscribe((state) => notices.push(state.notice));
    t.deliver(sentence("s1", 0, "Hi."));
    t.deliver(sentence("s1", 1, "Bye."));
    await flush();
    expect(t.store.snapshot().notice).toBe(TRANSLATOR_RETRY_NOTICE);
    expect(notices.filter((n) => n === TRANSLATOR_RETRY_NOTICE).length).toBeGreaterThan(0);
    expect(t.sentences()).toMatchObject({ 0: { failed: true }, 1: { failed: true } });
  });

  it("uma frase que falha não afeta as outras nem gera aviso", async () => {
    const t = setup(async () => translatorOf((text) => (text === "Hi." ? Promise.reject(new Error("x")) : Promise.resolve(`pt:${text}`))));
    t.deliver(sentence("s1", 0, "Hi."));
    t.deliver(sentence("s1", 1, "Bye."));
    await flush();
    expect(t.sentences()).toMatchObject({ 0: { failed: true }, 1: { translation: "pt:Bye." } });
    expect(t.store.snapshot().notice).toBeNull();
  });

  it("limita os trabalhos pendentes e marca o excedente como falha", async () => {
    const t = setup(async () => translatorOf(() => new Promise<string>(() => {})));
    for (let i = 0; i <= MAX_PENDING_TRANSLATIONS; i++) t.deliver(sentence("s1", i, `S${i}.`));
    await flush();
    const sentences = t.sentences() ?? {};
    expect(sentences[MAX_PENDING_TRANSLATIONS]).toMatchObject({ failed: true });
    expect(sentences[0]).toMatchObject({ failed: false, translation: null });
  });

  it("ignora as demais mensagens do servidor", async () => {
    const provide = vi.fn(async () => translatorOf(async (text) => text));
    const t = setup(provide);
    t.deliver(segment("s1", "Hello"));
    await flush();
    expect(provide).not.toHaveBeenCalled();
  });
  it("tenta criar o tradutor de novo depois do intervalo e volta a traduzir", async () => {
    let now = 0;
    const provide = vi
      .fn<() => Promise<SentenceTranslator>>()
      .mockRejectedValueOnce(new Error("NotAllowedError"))
      .mockResolvedValue(translatorOf(async (text) => `pt:${text}`));
    const t = setup(provide, () => now);
    t.deliver(sentence("s1", 0, "Hi."));
    await flush();
    expect(t.store.snapshot().notice).toBe(TRANSLATOR_RETRY_NOTICE);

    now = TRANSLATOR_RETRY_MS - 1;
    t.deliver(sentence("s1", 1, "Still."));
    await flush();
    expect(provide).toHaveBeenCalledTimes(1);
    expect(t.sentences()?.[1]).toMatchObject({ failed: true });

    now = TRANSLATOR_RETRY_MS;
    t.deliver(sentence("s1", 2, "Now."));
    await flush();
    expect(provide).toHaveBeenCalledTimes(2);
    expect(t.sentences()?.[2]).toMatchObject({ translation: "pt:Now.", failed: false });
    expect(t.store.snapshot().notice).toBeNull();
  });

  it("ao voltar a traduzir, não apaga um aviso de outra origem", async () => {
    let now = 0;
    const provide = vi
      .fn<() => Promise<SentenceTranslator>>()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue(translatorOf(async (text) => text));
    const t = setup(provide, () => now);
    t.deliver(sentence("s1", 0, "Hi."));
    await flush();
    t.store.dispatch({ type: "notice", message: "A transcrição da sua voz parou." });
    now = TRANSLATOR_RETRY_MS;
    t.deliver(sentence("s1", 1, "Bye."));
    await flush();
    expect(t.store.snapshot().notice).toBe("A transcrição da sua voz parou.");
  });
});
