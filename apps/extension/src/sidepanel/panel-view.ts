import type { Channel } from "@snowspeak/shared";
import type { Caption, SessionStatus } from "../offscreen/session-store";
import type { CaptionView } from "./caption-view";

/** Durante a captura o painel esconde configurações e medidores para sobrar espaço à legenda. */
export function isCaptureMode(status: SessionStatus, pendingStart: boolean): boolean {
  return pendingStart || status === "starting" || status === "running" || status === "stopping";
}

export type CaptionEmphasis = "current" | "previous";

/** A fala mais recente fica em destaque; as anteriores, menores e esmaecidas. */
export function captionEmphasis(captions: readonly Caption[], index: number): CaptionEmphasis {
  return index === captions.length - 1 ? "current" : "previous";
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
