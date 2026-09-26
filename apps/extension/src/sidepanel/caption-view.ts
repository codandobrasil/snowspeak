import type { Caption, CaptionSentence } from "../offscreen/session-store";

export interface CaptionView {
  speaker: string;
  english: string;
  partial: string;
  portuguese: string;
  translating: boolean;
  translationFailed: boolean;
  interrupted: boolean;
}

export function captionView(caption: Caption): CaptionView {
  const sentences = Object.keys(caption.sentences)
    .map(Number)
    .sort((a, b) => a - b)
    .map((idx) => caption.sentences[idx])
    .filter((s): s is CaptionSentence => s !== undefined);
  return {
    speaker: caption.channel === "them" ? "Participantes" : "Você",
    english: caption.segments.filter(Boolean).join(" "),
    partial: caption.partial,
    portuguese: sentences
      .map((s) => s.translation)
      .filter((t): t is string => typeof t === "string")
      .join(" "),
    translating: caption.channel === "them" && sentences.some((s) => s.translation === null && !s.failed),
    translationFailed: sentences.some((s) => s.failed),
    interrupted: caption.interrupted,
  };
}
