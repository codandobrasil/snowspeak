import type { SuggestionErrorCode } from "@snowspeak/shared";
import type { SuggestionState } from "../offscreen/session-store";

export interface SuggestionCard {
  visible: boolean;
  label: string;
  en: string;
  pt: string;
  pending: boolean;
  error: string | null;
}

const ERROR_MESSAGES: Record<SuggestionErrorCode, string> = {
  timeout: "A sugestão demorou demais. Tente de novo (Alt+S).",
  provider: "Não foi possível gerar a sugestão agora (serviço de IA indisponível).",
  invalid_output: "A IA respondeu fora do formato. Tente de novo (Alt+S).",
  cancelled: "Sugestão cancelada.",
  busy: "Aguarde a sugestão atual terminar.",
  rate_limited: "Espere um instante para pedir outra sugestão.",
};

export function suggestionCard(suggestion: SuggestionState | null): SuggestionCard {
  if (!suggestion) return { visible: false, label: "", en: "", pt: "", pending: false, error: null };
  return {
    visible: true,
    label: suggestion.trigger === "auto" ? "Sugestão para a pergunta" : "Sugestão a pedido",
    en: suggestion.en,
    pt: suggestion.pt,
    pending: suggestion.status === "streaming",
    error: suggestion.status === "error" && suggestion.errorCode ? ERROR_MESSAGES[suggestion.errorCode] : null,
  };
}
