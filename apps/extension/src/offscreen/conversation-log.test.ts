import { describe, expect, it } from "vitest";
import type { EngineMessage } from "@snowspeak/shared";
import { ConversationLog } from "./conversation-log";
import { MAX_CAPTIONS, initialState, reduce, type SessionState, type StoreAction } from "./session-store";

const started: EngineMessage = { v: 1, type: "session.started", sessionId: "s1" };
const event = (seq: number, body: Record<string, unknown>): StoreAction => ({
  type: "engine",
  message: { v: 1, sessionId: "s1", seq, ts: seq * 1_000, ...body } as EngineMessage,
});
const segment = (seq: number, utteranceId: string, text: string): StoreAction =>
  event(seq, { type: "transcript.segment", channel: "them", utteranceId, segmentIdx: 0, text });

/** Aplica as ações ao store e mostra cada estado ao registro, como o offscreen faz. */
function play(log: ConversationLog, actions: StoreAction[], now = 0, from: SessionState = initialState()): SessionState {
  let state = from;
  for (const action of actions) {
    state = reduce(state, action);
    log.observe(state, now);
  }
  return state;
}

describe("ConversationLog", () => {
  it("guarda as falas que já saíram da tela", () => {
    const log = new ConversationLog();
    const actions: StoreAction[] = [{ type: "starting", suggestionsEnabled: true, suggestionsOn: true }, { type: "engine", message: started }];
    for (let i = 1; i <= MAX_CAPTIONS + 5; i++) actions.push(segment(i, `them-${i}`, `Line ${i}.`));
    const state = play(log, actions);
    expect(state.captions).toHaveLength(MAX_CAPTIONS);
    const captions = log.snapshot().captions;
    expect(captions).toHaveLength(MAX_CAPTIONS + 5);
    expect(captions[0]).toMatchObject({ utteranceId: "them-1", segments: ["Line 1."] });
  });

  it("guarda a versão mais recente de cada fala", () => {
    const log = new ConversationLog();
    play(log, [
      { type: "engine", message: started },
      event(1, { type: "transcript.partial", channel: "them", utteranceId: "them-1", text: "hel" }),
      segment(2, "them-1", "Hello there."),
    ]);
    expect(log.snapshot().captions).toMatchObject([{ utteranceId: "them-1", segments: ["Hello there."], partial: "" }]);
  });

  it("guarda cada sugestão concluída, mesmo depois de outra tomar o lugar dela", () => {
    const log = new ConversationLog();
    play(log, [
      { type: "engine", message: started },
      event(1, { type: "suggestion.started", requestId: "r1", trigger: "manual", basedOnUtteranceId: "them-1" }),
      event(2, { type: "suggestion.done", requestId: "r1", en: "First.", pt: "Primeira." }),
      event(3, { type: "suggestion.started", requestId: "r2", trigger: "manual", basedOnUtteranceId: "them-2" }),
      event(4, { type: "suggestion.error", requestId: "r2", code: "timeout" }),
      event(5, { type: "suggestion.started", requestId: "r3", trigger: "manual", basedOnUtteranceId: "them-2" }),
      event(6, { type: "suggestion.done", requestId: "r3", en: "Third.", pt: "Terceira." }),
    ]);
    expect(log.snapshot().suggestions).toMatchObject([
      { requestId: "r1", en: "First.", pt: "Primeira.", basedOnUtteranceId: "them-1" },
      { requestId: "r3", en: "Third.", pt: "Terceira.", basedOnUtteranceId: "them-2" },
    ]);
  });

  it("o Limpar só apaga a tela; o registro continua", () => {
    const log = new ConversationLog();
    const state = play(log, [{ type: "engine", message: started }, segment(1, "them-1", "Hi."), event(2, { type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: false })]);
    play(log, [{ type: "clear" }], 0, state);
    expect(log.snapshot().captions).toHaveLength(1);
  });

  it("zera no próximo Iniciar", () => {
    const log = new ConversationLog();
    const state = play(log, [{ type: "engine", message: started }, segment(1, "them-1", "Hi.")]);
    play(log, [{ type: "starting", suggestionsEnabled: true, suggestionsOn: true }], 0, state);
    expect(log.snapshot()).toEqual({ startedAt: null, endedAt: null, captions: [], suggestions: [] });
  });

  it("registra quando a sessão começou e terminou", () => {
    const log = new ConversationLog();
    const running = play(log, [{ type: "starting", suggestionsEnabled: true, suggestionsOn: true }, { type: "engine", message: started }], 100);
    expect(log.snapshot()).toMatchObject({ startedAt: 100, endedAt: null });
    play(log, [{ type: "stopped" }], 500, running);
    expect(log.snapshot()).toMatchObject({ startedAt: 100, endedAt: 500 });
  });
});
