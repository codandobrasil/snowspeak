export const SENTENCE_MAX_WAIT_MS = 2_500;
export const SENTENCE_MAX_WORDS = 30;

export interface SentenceReady {
  utteranceId: string;
  sentenceIdx: number;
  text: string;
}

// Fim de frase: . ? ! (e aspas/parênteses de fechamento) seguido de espaço ou do fim do texto.
const SENTENCE_END = /[.?!]+["')\]]*(?=\s|$)/g;

function splitComplete(text: string): { complete: string; rest: string } {
  let cut = -1;
  for (const match of text.matchAll(SENTENCE_END)) cut = match.index + match[0].length;
  if (cut < 0) return { complete: "", rest: text };
  return { complete: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// Decide quando um trecho do canal them está pronto para tradução, sem esperar o fim de falas longas.
export class SentenceSplitter {
  private utteranceId: string | null = null;
  private pending = "";
  private nextIdx = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onSentence: (sentence: SentenceReady) => void) {}

  addSegment(utteranceId: string, text: string): void {
    if (this.utteranceId !== utteranceId) {
      this.flush();
      this.utteranceId = utteranceId;
      this.nextIdx = 0;
    }
    this.pending = this.pending ? `${this.pending} ${text}` : text;

    const { complete, rest } = splitComplete(this.pending);
    if (complete) {
      this.pending = rest;
      this.clearTimer();
      this.emit(complete);
    }
    if (!this.pending) return;
    if (wordCount(this.pending) >= SENTENCE_MAX_WORDS) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SENTENCE_MAX_WAIT_MS);
  }

  endUtterance(utteranceId: string): void {
    if (this.utteranceId !== utteranceId) return;
    this.flush();
    this.utteranceId = null;
  }

  dispose(): void {
    this.clearTimer();
    this.pending = "";
  }

  private flush(): void {
    this.clearTimer();
    const text = this.pending.trim();
    this.pending = "";
    if (text) this.emit(text);
  }

  private emit(text: string): void {
    if (this.utteranceId === null) return;
    this.onSentence({ utteranceId: this.utteranceId, sentenceIdx: this.nextIdx, text });
    this.nextIdx += 1;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
