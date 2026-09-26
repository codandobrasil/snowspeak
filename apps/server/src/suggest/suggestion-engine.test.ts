import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEventBody } from "@snowspeak/shared";
import type { ChatMessage } from "./prompt";
import type { Suggester } from "./openrouter";
import { MANUAL_MIN_INTERVAL_MS, SuggestionEngine } from "./suggestion-engine";

type Script = (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string>;

function scripted(script: Script): Suggester & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return { calls, stream: (messages, signal) => (calls.push(messages), script(messages, signal)) };
}

const answer = (en: string, pt: string): Script =>
  async function* () {
    yield `<en>${en}</en>`;
    yield `<pt>${pt}</pt>`;
  };

// Só termina quando cancelado.
const hanging: Script = async function* (_m, signal) {
  yield "<en>Partial";
  await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup(script: Script, options: { now?: () => number; timeoutMs?: number } = {}) {
  const events: ServerEventBody[] = [];
  const suggester = scripted(script);
  const engine = new SuggestionEngine({
    suggester,
    emit: (body) => events.push(body),
    settings: () => ({ mode: "interview", context: "", profile: "Node dev at Nubank", job: "Backend" }),
    ...options,
  });
  const types = () => events.map((e) => e.type);
  const of = (requestId: string) => events.filter((e) => "requestId" in e && e.requestId === requestId);
  return { engine, events, suggester, types, of };
}

describe("SuggestionEngine", () => {
  afterEach(() => vi.useRealTimers());

  it("pedido manual: started, deltas e done com inglês e português", async () => {
    const t = setup(answer("Sure.", "Claro."));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "Nice to meet you.", interrupted: false });
    t.engine.request("r1");
    await settle();
    expect(t.of("r1")).toEqual([
      { type: "suggestion.started", requestId: "r1", trigger: "manual", basedOnUtteranceId: "them-1" },
      { type: "suggestion.delta", requestId: "r1", lang: "en", text: "Sure." },
      { type: "suggestion.delta", requestId: "r1", lang: "pt", text: "Claro." },
      { type: "suggestion.done", requestId: "r1", en: "Sure.", pt: "Claro." },
    ]);
  });

  it("responde à pergunta escolhida, com a conversa só até ela", async () => {
    const t = setup(answer("Sure.", "Claro."));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "Why fintech", interrupted: false });
    t.engine.addUtterance({ channel: "me", utteranceId: "me-1", text: "Because payments matter.", interrupted: false });
    t.engine.addUtterance({ channel: "them", utteranceId: "them-2", text: "Great, next topic", interrupted: false });
    t.engine.request("r1", { utteranceId: "them-1", text: "Why fintech" });
    await settle();
    expect(t.of("r1")[0]).toEqual({ type: "suggestion.started", requestId: "r1", trigger: "manual", basedOnUtteranceId: "them-1" });
    const user = t.suggester.calls[0]?.[1]?.content ?? "";
    expect(user).toContain("QUESTION TO ANSWER:\nWhy fintech");
    expect(user).toContain("THEM: Why fintech");
    expect(user).not.toContain("Because payments matter.");
    expect(user).not.toContain("next topic");
  });

  it("pergunta escolhida fora da janela: usa o texto enviado e a conversa recente", async () => {
    const t = setup(answer("Sure.", "Claro."));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-9", text: "Recent line", interrupted: false });
    t.engine.request("r1", { utteranceId: "them-1", text: "An old question?" });
    await settle();
    expect(t.of("r1")[0]).toMatchObject({ basedOnUtteranceId: "them-1" });
    const user = t.suggester.calls[0]?.[1]?.content ?? "";
    expect(user).toContain("QUESTION TO ANSWER:\nAn old question?");
    expect(user).toContain("THEM: Recent line");
  });

  it("gera sozinho quando o participante termina uma pergunta", async () => {
    const t = setup(answer("I build APIs.", "Eu construo APIs."));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-2", text: "Tell me about yourself.", interrupted: false });
    await settle();
    expect(t.events[0]).toEqual({ type: "suggestion.started", requestId: "auto-1", trigger: "auto", basedOnUtteranceId: "them-2" });
    expect(t.types()).toContain("suggestion.done");
  });

  it("não gera sozinho para afirmações, falas do usuário ou falas interrompidas", async () => {
    const t = setup(answer("x", "y"));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "That sounds great, thanks.", interrupted: false });
    t.engine.addUtterance({ channel: "me", utteranceId: "me-1", text: "What do you mean by that?", interrupted: false });
    t.engine.addUtterance({ channel: "them", utteranceId: "them-2", text: "What would you do if", interrupted: true });
    await settle();
    expect(t.events).toEqual([]);
  });

  it("uma pergunta nova cancela a sugestão automática em andamento", async () => {
    const t = setup(hanging);
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "How was your weekend?", interrupted: false });
    await settle();
    t.suggester.stream = answer("Second.", "Segunda.");
    t.engine.addUtterance({ channel: "them", utteranceId: "them-2", text: "What is your biggest strength?", interrupted: false });
    await settle();
    expect(t.of("auto-1").at(-1)).toEqual({ type: "suggestion.error", requestId: "auto-1", code: "cancelled" });
    expect(t.of("auto-2").at(-1)).toEqual({ type: "suggestion.done", requestId: "auto-2", en: "Second.", pt: "Segunda." });
  });

  it("pedido manual recusado enquanto outro manual está em andamento", async () => {
    let now = 0;
    const t = setup(hanging, { now: () => now });
    t.engine.request("r1");
    now = MANUAL_MIN_INTERVAL_MS + 1;
    t.engine.request("r2");
    await settle();
    expect(t.of("r2")).toEqual([{ type: "suggestion.error", requestId: "r2", code: "busy" }]);
  });

  it("sugestão automática não atrapalha um pedido manual em andamento", async () => {
    const t = setup(hanging);
    t.engine.request("r1");
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "Why do you want this job?", interrupted: false });
    await settle();
    expect(t.events.filter((e) => e.type === "suggestion.started")).toHaveLength(1);
  });

  it("recusa pedidos manuais muito próximos e ignora requestId repetido", async () => {
    let now = 0;
    const t = setup(answer("x", "y"), { now: () => now });
    t.engine.request("r1");
    await settle();
    now = MANUAL_MIN_INTERVAL_MS - 1;
    t.engine.request("r2");
    t.engine.request("r1");
    await settle();
    expect(t.of("r2")).toEqual([{ type: "suggestion.error", requestId: "r2", code: "rate_limited" }]);
    expect(t.of("r1").filter((e) => e.type === "suggestion.started")).toHaveLength(1);
  });

  it("resposta sem os dois blocos vira invalid_output", async () => {
    const t = setup(async function* () {
      yield "<en>Only English.</en>";
    });
    t.engine.request("r1");
    await settle();
    expect(t.of("r1").at(-1)).toEqual({ type: "suggestion.error", requestId: "r1", code: "invalid_output" });
  });

  it("falha do provedor vira provider", async () => {
    const t = setup(async function* () {
      throw new Error("HTTP 402");
    });
    t.engine.request("r1");
    await settle();
    expect(t.of("r1").at(-1)).toEqual({ type: "suggestion.error", requestId: "r1", code: "provider" });
  });

  it("estoura o prazo", async () => {
    const t = setup(hanging, { timeoutMs: 20 });
    t.engine.request("r1");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.of("r1").at(-1)).toEqual({ type: "suggestion.error", requestId: "r1", code: "timeout" });
  });

  it("close cancela a geração em andamento", async () => {
    const t = setup(hanging);
    t.engine.request("r1");
    await settle();
    t.engine.close();
    await settle();
    expect(t.of("r1").at(-1)).toEqual({ type: "suggestion.error", requestId: "r1", code: "cancelled" });
    t.engine.request("r3");
    await settle();
    expect(t.of("r3")).toEqual([]);
  });

  it("congela o contexto e a conversa no instante do pedido", async () => {
    const t = setup(answer("x", "y"));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "Nice to meet you.", interrupted: false });
    t.engine.addUtterance({ channel: "me", utteranceId: "me-1", text: "Likewise.", interrupted: false });
    t.engine.request("r1");
    await settle();
    const user = t.suggester.calls[0]?.[1]?.content ?? "";
    expect(user).toContain("Nubank");
    expect(user).toContain("THEM: Nice to meet you.\nME: Likewise.");
  });
  it("depois de stopAccepting, perguntas e pedidos não geram novas sugestões", async () => {
    const t = setup(answer("x", "y"));
    t.engine.stopAccepting();
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "Tell me about yourself.", interrupted: false });
    t.engine.request("r1");
    await settle();
    expect(t.events).toEqual([]);
    expect(t.suggester.calls).toHaveLength(0);
  });
});
