import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SENTENCE_MAX_WAIT_MS, SentenceSplitter, type SentenceReady } from "./sentence-splitter";

function setup() {
  const sentences: SentenceReady[] = [];
  const splitter = new SentenceSplitter((s) => sentences.push(s));
  return { splitter, sentences, texts: () => sentences.map((s) => s.text) };
}

describe("SentenceSplitter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("envia a frase assim que ela termina com pontuação", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "Hello there.");
    expect(t.sentences).toEqual([{ utteranceId: "them-1", sentenceIdx: 0, text: "Hello there." }]);
  });

  it("junta segmentos até a pontuação", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "How are");
    expect(t.sentences).toEqual([]);
    t.splitter.addSegment("them-1", "you today?");
    expect(t.texts()).toEqual(["How are you today?"]);
  });

  it("separa o que já terminou do resto e numera em ordem", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "Great. I think");
    expect(t.texts()).toEqual(["Great."]);
    t.splitter.addSegment("them-1", "we should start. Then");
    expect(t.sentences.map((s) => [s.sentenceIdx, s.text])).toEqual([
      [0, "Great."],
      [1, "I think we should start."],
    ]);
  });

  it("não corta números decimais nem pontuação no meio de palavras", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "It costs 3.5 dollars at example.com today");
    expect(t.sentences).toEqual([]);
  });

  it("envia depois de 2,5 s sem pontuação", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "so basically what we");
    vi.advanceTimersByTime(SENTENCE_MAX_WAIT_MS - 1);
    expect(t.sentences).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.texts()).toEqual(["so basically what we"]);
  });

  it("o prazo conta a partir do trecho que ficou pendente", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "no pause");
    vi.advanceTimersByTime(2_000);
    t.splitter.addSegment("them-1", "at all. and more");
    vi.advanceTimersByTime(2_000);
    expect(t.texts()).toEqual(["no pause at all."]);
    vi.advanceTimersByTime(500);
    expect(t.texts()).toEqual(["no pause at all.", "and more"]);
  });

  it("envia ao atingir 30 palavras mesmo sem pausa nem pontuação", () => {
    const t = setup();
    t.splitter.addSegment("them-1", Array.from({ length: 29 }, (_, i) => `w${i}`).join(" "));
    expect(t.sentences).toEqual([]);
    t.splitter.addSegment("them-1", "w29");
    expect(t.sentences).toHaveLength(1);
    expect(t.sentences[0]?.text.split(" ")).toHaveLength(30);
  });

  it("fim da fala envia o restante e a próxima fala recomeça do índice 0", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "Hi.");
    t.splitter.addSegment("them-1", "there");
    t.splitter.endUtterance("them-1");
    t.splitter.addSegment("them-2", "Next.");
    expect(t.sentences).toEqual([
      { utteranceId: "them-1", sentenceIdx: 0, text: "Hi." },
      { utteranceId: "them-1", sentenceIdx: 1, text: "there" },
      { utteranceId: "them-2", sentenceIdx: 0, text: "Next." },
    ]);
    vi.advanceTimersByTime(SENTENCE_MAX_WAIT_MS);
    expect(t.sentences).toHaveLength(3);
  });

  it("segmento de outra fala envia o pendente da anterior", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "unfinished");
    t.splitter.addSegment("them-2", "Other.");
    expect(t.sentences.map((s) => [s.utteranceId, s.text])).toEqual([
      ["them-1", "unfinished"],
      ["them-2", "Other."],
    ]);
  });

  it("dispose descarta o pendente e cancela o prazo", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "pending words");
    t.splitter.dispose();
    vi.advanceTimersByTime(SENTENCE_MAX_WAIT_MS);
    expect(t.sentences).toEqual([]);
  });
});
