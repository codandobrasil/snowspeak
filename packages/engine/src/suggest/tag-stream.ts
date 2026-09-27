export type SuggestionLang = "en" | "pt";

const OPEN = { en: "<en>", pt: "<pt>" } as const;
const CLOSE = { en: "</en>", pt: "</pt>" } as const;

// Lê <en>…</en><pt>…</pt> em pedaços arbitrários e devolve o texto de cada idioma assim que é seguro.
export class TagStreamParser {
  private buffer = "";
  private current: SuggestionLang | null = null;
  private readonly text = { en: "", pt: "" };
  // Só blocos fechados contam como resposta (ex.: cortado por max_tokens dentro de <pt> não vale).
  private readonly completed = { en: "", pt: "" };

  push(chunk: string): Array<{ lang: SuggestionLang; text: string }> {
    this.buffer += chunk;
    const deltas: Array<{ lang: SuggestionLang; text: string }> = [];
    for (;;) {
      if (this.current === null) {
        const en = this.buffer.indexOf(OPEN.en);
        const pt = this.buffer.indexOf(OPEN.pt);
        const next = [en, pt].filter((i) => i >= 0).sort((a, b) => a - b)[0];
        if (next === undefined) {
          // Guarda só o que ainda pode ser o começo de uma tag.
          const lt = this.buffer.lastIndexOf("<");
          this.buffer = lt >= 0 && this.buffer.length - lt < OPEN.en.length ? this.buffer.slice(lt) : "";
          return deltas;
        }
        this.current = next === en ? "en" : "pt";
        this.buffer = this.buffer.slice(next + OPEN[this.current].length);
        continue;
      }
      const close = CLOSE[this.current];
      const end = this.buffer.indexOf(close);
      if (end >= 0) {
        this.emit(deltas, this.buffer.slice(0, end));
        this.completed[this.current] = this.text[this.current];
        this.buffer = this.buffer.slice(end + close.length);
        this.current = null;
        continue;
      }
      // Segura o sufixo que pode ser o começo da tag de fechamento.
      const lt = this.buffer.lastIndexOf("<");
      const hold = lt >= 0 && close.startsWith(this.buffer.slice(lt)) ? lt : this.buffer.length;
      this.emit(deltas, this.buffer.slice(0, hold));
      this.buffer = this.buffer.slice(hold);
      return deltas;
    }
  }

  result(): { en: string; pt: string } {
    return { en: this.completed.en.trim(), pt: this.completed.pt.trim() };
  }

  private emit(deltas: Array<{ lang: SuggestionLang; text: string }>, text: string): void {
    if (!text || this.current === null) return;
    this.text[this.current] += text;
    deltas.push({ lang: this.current, text });
  }
}
