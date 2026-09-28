import type { Caption, SessionState, SuggestionState } from "./session-store";

export interface ConversationSnapshot {
  /** Quando a sessão começou a capturar (ms); null antes do primeiro Iniciar. */
  startedAt: number | null;
  /** Quando parou; null enquanto a sessão está rodando. */
  endedAt: number | null;
  /** Todas as falas da sessão, na ordem, inclusive as que já saíram do painel. */
  captions: Caption[];
  /** As sugestões concluídas, na ordem em que foram pedidas. */
  suggestions: SuggestionState[];
}

function emptySnapshot(): ConversationSnapshot {
  return { startedAt: null, endedAt: null, captions: [], suggestions: [] };
}

// A conversa inteira da sessão, para o PDF. O painel mostra só as falas recentes e a sugestão atual;
// aqui fica tudo, até o próximo Iniciar (o Limpar só apaga a tela).
export class ConversationLog {
  private current = emptySnapshot();
  private readonly captions = new Map<string, Caption>();
  private readonly suggestions = new Map<string, SuggestionState>();

  observe(state: SessionState, now: number = Date.now()): void {
    if (state.status === "starting") {
      this.reset();
      return;
    }
    if (state.status === "running" && this.current.startedAt === null) this.current.startedAt = now;
    if (state.status === "running") this.current.endedAt = null;
    else if (this.current.startedAt !== null && this.current.endedAt === null && (state.status === "idle" || state.status === "error")) {
      this.current.endedAt = now;
    }
    // Map preserva a ordem de entrada: cada fala fica na posição em que apareceu pela primeira vez.
    for (const caption of state.captions) this.captions.set(caption.utteranceId, caption);
    if (state.suggestion?.status === "done") this.suggestions.set(state.suggestion.requestId, state.suggestion);
  }

  snapshot(): ConversationSnapshot {
    return { ...this.current, captions: [...this.captions.values()], suggestions: [...this.suggestions.values()] };
  }

  private reset(): void {
    this.current = emptySnapshot();
    this.captions.clear();
    this.suggestions.clear();
  }
}
