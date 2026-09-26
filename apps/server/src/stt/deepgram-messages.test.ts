import { describe, expect, it } from "vitest";
import { parseDeepgramMessage } from "./deepgram-messages";

function results(overrides: Record<string, unknown>, alternative: Record<string, unknown>): string {
  return JSON.stringify({ type: "Results", start: 1.5, duration: 1, channel: { alternatives: [alternative] }, ...overrides });
}

describe("parseDeepgramMessage", () => {
  it("resultado provisório vira parcial; provisório vazio é ignorado", () => {
    expect(parseDeepgramMessage(results({ is_final: false }, { transcript: " hello the " }))).toEqual({ kind: "partial", text: "hello the" });
    expect(parseDeepgramMessage(results({ is_final: false }, { transcript: "" }))).toBeNull();
  });

  it("resultado final vira segmento com os tempos das palavras", () => {
    const raw = results(
      { is_final: true, speech_final: true },
      { transcript: "Hello there.", words: [{ word: "hello", start: 1.6, end: 1.9 }, { word: "there", start: 2, end: 2.3 }] },
    );
    expect(parseDeepgramMessage(raw)).toEqual({ kind: "segment", text: "Hello there.", start: 1.6, end: 2.3, speechFinal: true, fromFinalize: false });
  });

  it("sem palavras usa start e duration do resultado; marca from_finalize", () => {
    const raw = results({ is_final: true, from_finalize: true }, { transcript: "" });
    expect(parseDeepgramMessage(raw)).toEqual({ kind: "segment", text: "", start: 1.5, end: 2.5, speechFinal: false, fromFinalize: true });
  });

  it("UtteranceEnd informa o fim da última palavra", () => {
    expect(parseDeepgramMessage('{"type":"UtteranceEnd","channel":[0,1],"last_word_end":2.3}')).toEqual({ kind: "utteranceEnd", lastWordEnd: 2.3 });
  });

  it("ignora outros tipos, formatos inesperados e JSON inválido", () => {
    expect(parseDeepgramMessage('{"type":"SpeechStarted","channel":[0],"timestamp":1}')).toBeNull();
    expect(parseDeepgramMessage('{"type":"Metadata"}')).toBeNull();
    expect(parseDeepgramMessage('{"type":"Results","is_final":true,"channel":{}}')).toBeNull();
    expect(parseDeepgramMessage('{"type":"UtteranceEnd"}')).toBeNull();
    expect(parseDeepgramMessage("nope")).toBeNull();
  });
});
