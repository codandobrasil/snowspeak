import type { Channel, Mode } from "@snowspeak/shared";
import type { Caption, SessionStatus } from "../offscreen/session-store";
import type { SuggestionQuestion } from "../offscreen/session-controller";
import type { CaptionView } from "./caption-view";

/** Durante a captura o painel esconde configurações e medidores para sobrar espaço à legenda. */
export function isCaptureMode(status: SessionStatus, pendingStart: boolean): boolean {
  return pendingStart || status === "starting" || status === "running" || status === "reconnecting" || status === "stopping";
}

export type CaptionEmphasis = "current" | "previous" | "normal";

/**
 * A última fala dos participantes fica em destaque (é a pergunta a responder, mesmo enquanto o usuário fala);
 * as anteriores ficam menores e esmaecidas; as falas do usuário, em tamanho normal.
 */
export function captionEmphasis(captions: readonly Caption[], index: number): CaptionEmphasis {
  if (captions[index]?.channel === "me") return "normal";
  const later = captions.slice(index + 1);
  return later.some((c) => c.channel === "them") ? "previous" : "current";
}

export type TimelineItem = { kind: "caption"; caption: Caption } | { kind: "suggestion" };

/** Ordem da legenda: a sugestão entra logo abaixo da pergunta em que se baseia, ou no fim. */
export function timeline(captions: readonly Caption[], suggestion: { basedOnUtteranceId: string | null } | null): TimelineItem[] {
  const items: TimelineItem[] = captions.map((caption) => ({ kind: "caption", caption }));
  if (!suggestion) return items;
  const base = captions.findIndex((c) => c.utteranceId === suggestion.basedOnUtteranceId);
  items.splice(base >= 0 ? base + 1 : items.length, 0, { kind: "suggestion" });
  return items;
}

/** Fala dos participantes que o usuário pode clicar para pedir a resposta: só depois de terminada. */
export function selectableQuestion(caption: Caption): SuggestionQuestion | null {
  if (caption.channel !== "them" || !caption.ended) return null;
  const text = caption.segments.filter(Boolean).join(" ").trim();
  return text ? { utteranceId: caption.utteranceId, text } : null;
}

export function columnTitles(mode: Mode): Record<Channel, string> {
  return { them: mode === "interview" ? "Entrevistador" : "Participantes", me: "Você" };
}

export interface CaptionLines {
  showEnglish: boolean;
  /** Inglês exibido só enquanto a tradução não chega (modo só português). */
  englishIsPlaceholder: boolean;
  showPortuguese: boolean;
}

export function captionLines(view: CaptionView, channel: Channel, portugueseOnly: boolean): CaptionLines {
  const showPortuguese = channel === "them" && (view.portuguese !== "" || view.translating || view.translationFailed);
  if (!portugueseOnly || channel === "me") return { showEnglish: true, englishIsPlaceholder: false, showPortuguese };
  const translated = view.portuguese !== "";
  return { showEnglish: !translated, englishIsPlaceholder: !translated, showPortuguese };
}
