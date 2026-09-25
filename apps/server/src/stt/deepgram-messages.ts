import type { SttResult } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** Converte uma mensagem do WebSocket do Deepgram; devolve null para o que não interessa. */
export function parseDeepgramMessage(raw: string): SttResult | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  if (data.type === "UtteranceEnd") {
    return typeof data.last_word_end === "number" ? { kind: "utteranceEnd", lastWordEnd: data.last_word_end } : null;
  }
  if (data.type !== "Results") return null;

  const channel = isRecord(data.channel) ? data.channel : null;
  const alternatives = channel && Array.isArray(channel.alternatives) ? channel.alternatives : [];
  const alternative = isRecord(alternatives[0]) ? alternatives[0] : null;
  if (!alternative) return null;

  const text = typeof alternative.transcript === "string" ? alternative.transcript.trim() : "";
  if (data.is_final !== true) return text ? { kind: "partial", text } : null;

  const words = Array.isArray(alternative.words) ? alternative.words.filter(isRecord) : [];
  const resultStart = numberOr(data.start, 0);
  const resultEnd = resultStart + numberOr(data.duration, 0);
  return {
    kind: "segment",
    text,
    start: numberOr(words[0]?.start, resultStart),
    end: numberOr(words[words.length - 1]?.end, resultEnd),
    speechFinal: data.speech_final === true,
    fromFinalize: data.from_finalize === true,
  };
}
