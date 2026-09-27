import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineEventBody, ResponseLength } from "@snowspeak/shared";
import type { ChatMessage } from "./prompt";
import { SuggesterAuthError, type Suggester } from "./openrouter";
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

function setup(script: Script, options: { now?: () => number; timeoutMs?: number; responseLength?: ResponseLength } = {}) {
  const events: EngineEventBody[] = [];
  const suggester = scripted(script);
  const engine = new SuggestionEngine({
    suggester,
    emit: (body) => events.push(body),
    settings: () => ({ mode: "interview", context: "", profile: "Node dev at Nubank", job: "Backend", responseLength: options.responseLength ?? "medium" }),
    now: options.now,
    timeoutMs: options.timeoutMs,
  });
  const types = () => events.map((e) => e.type);
  const of = (requestId: string) => events.filter((e) => "requestId" in e && e.requestId === requestId);
  return { engine, events, suggester, types, of };
}

describe("SuggestionEngine", () => {
  it("chave recusada pelo OpenRouter vira erro unauthorized", async () => {
    const t = setup(async function* () {
      throw new SuggesterAuthError(401);
    });
    t.engine.request("r1");
    await settle();
    expect(t.of("r1").at(-1)).toEqual({ type: "suggestion.error", requestId: "r1", code: "unauthorized" });
  });

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

  it("pergunta do participante não gera sugestão sozinha", async () => {
    const t = setup(answer("I build APIs.", "Eu construo APIs."));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-2", text: "Tell me about yourself.", interrupted: false });
    await settle();
    expect(t.events).toEqual([]);
    expect(t.suggester.calls).toHaveLength(0);
  });

  it("pedido sem pergunta escolhida responde à última fala do participante que não é interjeição", async () => {
    const t = setup(answer("x", "y"));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "Why this company?", interrupted: false });
    t.engine.addUtterance({ channel: "them", utteranceId: "them-2", text: "Uh-huh.", interrupted: false });
    t.engine.request("r1");
    await settle();
    expect(t.of("r1")[0]).toEqual({ type: "suggestion.started", requestId: "r1", trigger: "manual", basedOnUtteranceId: "them-1" });
  });

  it("interjeições ficam fora da conversa enviada à IA", async () => {
    const t = setup(answer("x", "y"));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "Why this company?", interrupted: false });
    t.engine.addUtterance({ channel: "me", utteranceId: "me-1", text: "Hmmm.", interrupted: false });
    t.engine.addUtterance({ channel: "them", utteranceId: "them-2", text: "Yeah, sure.", interrupted: false });
    t.engine.request("r1");
    await settle();
    const user = t.suggester.calls[0]?.[1]?.content ?? "";
    expect(user).toContain("THEM: Why this company?");
    expect(user).not.toContain("Hmmm");
    expect(user).not.toContain("Yeah, sure");
  });

  it("usa o tamanho de resposta das configurações", async () => {
    const t = setup(answer("x", "y"), { responseLength: "short" });
    t.engine.request("r1");
    await settle();
    expect(t.suggester.calls[0]?.[0]?.content).toContain("exactly 1 short sentence");
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
