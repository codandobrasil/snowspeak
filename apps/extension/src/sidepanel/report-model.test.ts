import { describe, expect, it } from "vitest";
import type { ConversationSnapshot } from "../offscreen/conversation-log";
import type { Caption, SuggestionState } from "../offscreen/session-store";
import { buildReport, type ReportMeta } from "./report-model";

const at = (hour: number, minute: number): number => new Date(2026, 8, 28, hour, minute).getTime();

const said = (utteranceId: string, channel: "them" | "me", text: string, overrides: Partial<Caption> = {}): Caption => ({
  utteranceId,
  channel,
  segments: [text],
  partial: "",
  ended: true,
  interrupted: false,
  sentences: {},
  startedAt: at(14, 31),
  ...overrides,
});

const suggestion = (requestId: string, basedOnUtteranceId: string | null, en: string, pt: string): SuggestionState => ({
  requestId,
  trigger: "manual",
  status: "done",
  en,
  pt,
  basedOnUtteranceId,
  errorCode: null,
});

const meta: ReportMeta = { mode: "interview", context: "", job: "", now: at(16, 0) };

function conversation(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return { startedAt: at(14, 30), endedAt: at(15, 35), captions: [], suggestions: [], ...overrides };
}

describe("buildReport", () => {
  it("põe cada sugestão logo abaixo da pergunta a que respondeu, na ordem da conversa", () => {
    const report = buildReport(
      conversation({
        captions: [said("them-1", "them", "Why this company?"), said("me-1", "me", "Because of the product."), said("them-2", "them", "Any questions?")],
        suggestions: [suggestion("r1", "them-1", "I love the product.", "Adoro o produto."), suggestion("r2", "them-2", "Yes, one.", "Sim, uma.")],
      }),
      meta,
    );
    expect(report.items.map((item) => (item.kind === "utterance" ? item.english : `sugestão: ${item.en}`))).toEqual([
      "Why this company?",
      "sugestão: I love the product.",
      "Because of the product.",
      "Any questions?",
      "sugestão: Yes, one.",
    ]);
  });

  it("sugestão sem pergunta encontrada vai para o fim", () => {
    const report = buildReport(
      conversation({ captions: [said("them-1", "them", "Hello.")], suggestions: [suggestion("r1", null, "Hi.", "Oi.")] }),
      meta,
    );
    expect(report.items.at(-1)).toEqual({ kind: "suggestion", en: "Hi.", pt: "Oi." });
  });

  it("deixa as interjeições de fora", () => {
    const report = buildReport(
      conversation({ captions: [said("them-1", "them", "Why this company?"), said("me-1", "me", "Hmmm."), said("them-2", "them", "Uh-huh.")] }),
      meta,
    );
    expect(report.items).toHaveLength(1);
  });

  it("mostra quem falou, o horário, a tradução e se a fala foi interrompida", () => {
    const them = said("them-1", "them", "Hi. How are you?", {
      startedAt: at(14, 32),
      interrupted: true,
      sentences: { 0: { source: "Hi.", translation: "Oi.", failed: false }, 1: { source: "How are you?", translation: "Como vai?", failed: false } },
    });
    const me = said("me-1", "me", "Fine.", { startedAt: undefined });
    const report = buildReport(conversation({ captions: [them, me] }), meta);
    expect(report.items).toEqual([
      { kind: "utterance", channel: "them", speaker: "Entrevistador", time: "14:32", english: "Hi. How are you?", portuguese: "Oi. Como vai?", interrupted: true },
      { kind: "utterance", channel: "me", speaker: "Você", time: null, english: "Fine.", portuguese: "", interrupted: false },
    ]);
  });

  it("inclui o que ainda estava sendo falado", () => {
    const report = buildReport(conversation({ captions: [said("them-1", "them", "So tell me", { partial: "about you", ended: false })] }), meta);
    expect(report.items[0]).toMatchObject({ english: "So tell me about you" });
  });

  it("monta o cabeçalho: título do arquivo, data, horários, duração, modo, contexto e vaga", () => {
    const report = buildReport(conversation(), { ...meta, context: "  Entrevista na Acme ", job: "Senior Backend" });
    expect(report).toMatchObject({
      title: "SnowSpeak – Entrevista – 28-09-2026 14h30",
      modeLabel: "Entrevista",
      date: "28/09/2026",
      start: "14:30",
      end: "15:35",
      duration: "1 h 05 min",
      context: "Entrevista na Acme",
      job: "Senior Backend",
    });
  });

  it("sessão ainda em andamento: fim marcado e duração até agora; contexto vazio some", () => {
    const report = buildReport(conversation({ endedAt: null }), { ...meta, mode: "work", now: at(14, 42) });
    expect(report).toMatchObject({ end: "em andamento", duration: "12 min", modeLabel: "Trabalho", context: null, job: null });
    expect(report.items).toEqual([]);
  });

  it("duração curta aparece como menos de 1 min", () => {
    expect(buildReport(conversation({ endedAt: at(14, 30) + 20_000 }), meta).duration).toBe("menos de 1 min");
  });

  it("sem início registrado, usa o momento do download no título", () => {
    const report = buildReport(conversation({ startedAt: null, endedAt: null }), { ...meta, now: at(9, 5) });
    expect(report).toMatchObject({ title: "SnowSpeak – Entrevista – 28-09-2026 09h05", start: "—", duration: "—" });
  });
});
