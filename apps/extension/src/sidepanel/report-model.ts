import { isFillerOnly, type Channel, type Mode } from "@snowspeak/shared";
import type { ConversationSnapshot } from "../offscreen/conversation-log";
import { captionView } from "./caption-view";
import { columnTitles } from "./panel-view";

/** Onde o painel deixa o relatório para a página de impressão (chrome.storage.session, só nesta sessão do Chrome). */
export const REPORT_STORAGE_KEY = "snowspeakReport";

export interface ReportMeta {
  mode: Mode;
  context: string;
  job: string;
  /** Momento do download (ms). */
  now: number;
}

export type ReportItem =
  | { kind: "utterance"; channel: Channel; speaker: string; time: string | null; english: string; portuguese: string; interrupted: boolean }
  | { kind: "suggestion"; en: string; pt: string };

export interface Report {
  /** Título da página e nome sugerido do arquivo ao salvar como PDF. */
  title: string;
  modeLabel: string;
  date: string;
  start: string;
  end: string;
  duration: string;
  context: string | null;
  job: string | null;
  items: ReportItem[];
}

export const MODE_LABELS: Record<Mode, string> = {
  work: "Trabalho",
  sales: "Vendas",
  interview: "Entrevista",
  relationship: "Relacionamento",
};

const pad = (value: number): string => String(value).padStart(2, "0");
const clock = (ms: number): string => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

/** A conversa inteira, pronta para diagramar: cabeçalho da sessão e falas com as sugestões logo abaixo das perguntas. */
export function buildReport(conversation: ConversationSnapshot, meta: ReportMeta): Report {
  const titles = columnTitles(meta.mode);
  const reference = new Date(conversation.startedAt ?? meta.now);
  const items: ReportItem[] = [];
  const pending = [...conversation.suggestions];

  for (const caption of conversation.captions) {
    const view = captionView(caption);
    const english = [view.english, caption.partial].filter(Boolean).join(" ").trim();
    // Interjeições ("hmm", "uh-huh") ficam fora, como no painel.
    if (!english || isFillerOnly(english)) continue;
    items.push({
      kind: "utterance",
      channel: caption.channel,
      speaker: titles[caption.channel],
      time: caption.startedAt === undefined ? null : clock(caption.startedAt),
      english,
      portuguese: view.portuguese,
      interrupted: caption.interrupted,
    });
    for (const suggestion of pending.filter((s) => s.basedOnUtteranceId === caption.utteranceId)) {
      items.push({ kind: "suggestion", en: suggestion.en, pt: suggestion.pt });
      pending.splice(pending.indexOf(suggestion), 1);
    }
  }
  // Sugestões sem pergunta encontrada (pedido sem fala do participante) vão para o fim.
  for (const suggestion of pending) items.push({ kind: "suggestion", en: suggestion.en, pt: suggestion.pt });

  const modeLabel = MODE_LABELS[meta.mode];
  const started = conversation.startedAt;
  const finished = conversation.endedAt ?? meta.now;
  return {
    title: `SnowSpeak – ${modeLabel} – ${pad(reference.getDate())}-${pad(reference.getMonth() + 1)}-${reference.getFullYear()} ${pad(reference.getHours())}h${pad(reference.getMinutes())}`,
    modeLabel,
    date: `${pad(reference.getDate())}/${pad(reference.getMonth() + 1)}/${reference.getFullYear()}`,
    start: started === null ? "—" : clock(started),
    end: started === null ? "—" : conversation.endedAt === null ? "em andamento" : clock(conversation.endedAt),
    duration: started === null ? "—" : formatDuration(finished - started),
    context: meta.context.trim() || null,
    job: meta.job.trim() || null,
    items,
  };
}
