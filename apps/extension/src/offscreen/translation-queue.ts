import type { EngineMessage } from "@snowspeak/shared";
import type { SessionStore } from "./session-store";

export interface SentenceTranslator {
  translate(text: string): Promise<string>;
  destroy(): void;
}

export const TRANSLATOR_UNAVAILABLE_NOTICE = "Tradução indisponível neste Chrome. As falas continuam em inglês.";
export const TRANSLATOR_RETRY_NOTICE =
  "O tradutor do Chrome ainda não está pronto: as frases ficam em inglês e a tradução volta assim que ele estiver disponível.";
export const MAX_PENDING_TRANSLATIONS = 20;
// Depois de uma falha ao criar o tradutor (ex.: modelo ainda baixando), tenta de novo após este intervalo.
export const TRANSLATOR_RETRY_MS = 10_000;

interface SessionTranslations {
  sessionId: string;
  translator: Promise<SentenceTranslator> | null;
  retryAt: number;
  unavailable: boolean;
  pending: number;
}

export interface TranslationQueueOptions {
  now?: () => number;
}

// Traduz cada frase que o motor marca como pronta e grava o resultado no store.
// Cada trabalho pertence a uma sessão: resultados de sessões anteriores são descartados.
export class TranslationQueue {
  private current: SessionTranslations | null = null;
  private readonly now: () => number;

  constructor(
    private readonly provide: () => Promise<SentenceTranslator>,
    private readonly store: SessionStore,
    options: TranslationQueueOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  handle(message: EngineMessage): void {
    if (message.type === "session.started") {
      this.release();
      this.current = { sessionId: message.sessionId, translator: null, retryAt: 0, unavailable: false, pending: 0 };
      return;
    }
    if (message.type !== "sentence.ready") return;
    const session = this.current;
    if (!session || message.sessionId !== session.sessionId) return;

    const job = { sessionId: session.sessionId, utteranceId: message.utteranceId, sentenceIdx: message.sentenceIdx };
    const translator = session.pending < MAX_PENDING_TRANSLATIONS ? this.translatorFor(session) : null;
    if (!translator) {
      this.store.dispatch({ type: "sentence-translation-failed", ...job });
      return;
    }
    session.pending += 1;
    translator
      .then((t) => t.translate(message.text))
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

  /** O tradutor da sessão; null enquanto uma falha recente ainda não permite nova tentativa. */
  private translatorFor(session: SessionTranslations): Promise<SentenceTranslator> | null {
    if (session.translator) return session.translator;
    if (this.now() < session.retryAt) return null;
    session.translator = this.provide().then(
      (translator) => {
        if (session.unavailable && this.current === session) {
          session.unavailable = false;
          this.store.dispatch({ type: "clear-notice", message: TRANSLATOR_RETRY_NOTICE });
        }
        return translator;
      },
      (error: unknown) => {
        // Não guarda a falha: a próxima frase depois do intervalo tenta criar o tradutor de novo.
        session.translator = null;
        session.retryAt = this.now() + TRANSLATOR_RETRY_MS;
        if (!session.unavailable && this.current === session) {
          session.unavailable = true;
          this.store.dispatch({ type: "notice", message: TRANSLATOR_RETRY_NOTICE });
        }
        throw error;
      },
    );
    return session.translator;
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
