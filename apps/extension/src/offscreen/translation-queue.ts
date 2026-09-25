import type { ServerMessage } from "@snowspeak/shared";
import type { SessionStore } from "./session-store";

export interface SentenceTranslator {
  translate(text: string): Promise<string>;
  destroy(): void;
}

export const TRANSLATOR_UNAVAILABLE_NOTICE = "Tradução indisponível neste Chrome. As falas continuam em inglês.";
export const MAX_PENDING_TRANSLATIONS = 20;

interface SessionTranslations {
  sessionId: string;
  translator: Promise<SentenceTranslator> | null;
  pending: number;
}

// Traduz cada frase que o servidor marca como pronta e grava o resultado no store.
// Cada trabalho pertence a uma sessão: resultados de sessões anteriores são descartados.
export class TranslationQueue {
  private current: SessionTranslations | null = null;

  constructor(
    private readonly provide: () => Promise<SentenceTranslator>,
    private readonly store: SessionStore,
  ) {}

  handle(message: ServerMessage): void {
    if (message.type === "session.started") {
      this.release();
      this.current = { sessionId: message.sessionId, translator: null, pending: 0 };
      return;
    }
    if (message.type !== "sentence.ready") return;
    const session = this.current;
    if (!session || message.sessionId !== session.sessionId) return;

    const job = { sessionId: session.sessionId, utteranceId: message.utteranceId, sentenceIdx: message.sentenceIdx };
    if (session.pending >= MAX_PENDING_TRANSLATIONS) {
      this.store.dispatch({ type: "sentence-translation-failed", ...job });
      return;
    }
    session.pending += 1;
    session.translator ??= this.provide().catch((error: unknown) => {
      if (this.current === session) this.store.dispatch({ type: "notice", message: TRANSLATOR_UNAVAILABLE_NOTICE });
      throw error;
    });
    session.translator
      .then((translator) => translator.translate(message.text))
      .then(
        (text) => {
          if (this.current === session) this.store.dispatch({ type: "sentence-translated", ...job, text });
        },
        () => {
          if (this.current === session) this.store.dispatch({ type: "sentence-translation-failed", ...job });
        },
      )
      .finally(() => {
        session.pending -= 1;
      });
  }

  private release(): void {
    const previous = this.current?.translator;
    this.current = null;
    previous?.then(
      (translator) => translator.destroy(),
      () => undefined,
    );
  }
}
