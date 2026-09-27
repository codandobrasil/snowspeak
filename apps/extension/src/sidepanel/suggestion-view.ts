import type { SuggestionErrorCode } from "@snowspeak/shared";
import type { SuggestionState } from "../offscreen/session-store";

export interface SuggestionCard {
  visible: boolean;
  label: string;
  en: string;
  pt: string;
  pending: boolean;
  error: string | null;
  /** Aviso curto de pedido recusado (ex.: Alt+S repetido). */
  notice: string | null;
}

const ERROR_MESSAGES: Record<SuggestionErrorCode, string> = {
  timeout: "A sugestão demorou demais. Tente de novo (Alt+S).",
  provider: "Não foi possível gerar a sugestão agora (serviço de IA indisponível).",
  unauthorized: "O OpenRouter recusou a chave. Confira em Configurações.",
  invalid_output: "A IA respondeu fora do formato. Tente de novo (Alt+S).",
  cancelled: "Sugestão cancelada.",
  busy: "Aguarde a sugestão atual terminar.",
  rate_limited: "Espere um instante para pedir outra sugestão.",
};

export const SUGGESTIONS_DISABLED_NOTICE = "Sugestões desligadas: informe a chave do OpenRouter.";

export function suggestionCard(suggestion: SuggestionState | null, notice: string | null, suggestionsEnabled = true): SuggestionCard {
  if (!suggestionsEnabled) return { visible: true, label: "", en: "", pt: "", pending: false, error: null, notice: SUGGESTIONS_DISABLED_NOTICE };
  if (!suggestion) return { visible: notice !== null, label: "", en: "", pt: "", pending: false, error: null, notice };
  const failed = suggestion.status === "error";
  return {
    visible: true,
    label: suggestion.trigger === "auto" ? "Sugestão para a pergunta" : "Sugestão a pedido",
    // Texto parcial de uma sugestão que falhou pode estar quebrado: não é exibido.
    en: failed ? "" : suggestion.en,
    pt: failed ? "" : suggestion.pt,
    pending: suggestion.status === "streaming",
    error: failed && suggestion.errorCode ? ERROR_MESSAGES[suggestion.errorCode] : null,
    notice,
  };
}
