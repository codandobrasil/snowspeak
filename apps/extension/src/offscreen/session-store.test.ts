import { describe, expect, it } from "vitest";
import type { EngineMessage } from "@snowspeak/shared";
import { BUSY_SUGGESTION_NOTICE, MAX_CAPTIONS, RATE_LIMITED_SUGGESTION_NOTICE, STT_RECONNECTING_NOTICE, SessionStore, initialState, reduce, type SessionState, type StoreAction } from "./session-store";

const started: EngineMessage = { v: 1, type: "session.started", sessionId: "s1" };
const partial = (seq: number, text: string): EngineMessage => ({
  v: 1,
  type: "transcript.partial",
  sessionId: "s1",
  seq,
  ts: 0,
  channel: "them",
  utteranceId: "them-1",
  text,
});

function run(...actions: StoreAction[]): SessionState {
  return actions.reduce(reduce, initialState());
}

describe("reduce", () => {
  it("vai de starting para running com o sessionId", () => {
    const state = run({ type: "starting", suggestionsEnabled: true }, { type: "engine", message: started });
    expect(state.status).toBe("running");
    expect(state.sessionId).toBe("s1");
  });

  it("aplica o texto parcial e ignora eventos com seq repetido ou antigo", () => {
    const state = run(
      { type: "starting", suggestionsEnabled: true },
      { type: "engine", message: started },
      { type: "engine", message: partial(1, "um") },
      { type: "engine", message: partial(2, "dois") },
      { type: "engine", message: partial(2, "repetido") },
      { type: "engine", message: partial(1, "antigo") },
    );
    expect(state.captions[0]?.partial).toBe("dois");
    expect(state.lastSeq).toBe(2);
  });

  it("soma a duração das lacunas de áudio por canal", () => {
    const gap = (seq: number, durationMs: number): EngineMessage => ({
      v: 1,
      type: "audio.gap",
      sessionId: "s1",
      seq,
      ts: 0,
      channel: "me",
      durationMs,
      reason: "client_drop",
    });
    const state = run({ type: "engine", message: started }, { type: "engine", message: gap(1, 100) }, { type: "engine", message: gap(2, 250) });
    expect(state.channels.me.lostMs).toBe(350);
    expect(state.channels.them.lostMs).toBe(0);
  });

  it("registra microfone negado", () => {
    expect(run({ type: "mic", status: "denied" }).mic).toBe("denied");
  });

  it("registra nível e estatísticas por canal", () => {
    const state = run(
      { type: "level", channel: "me", rms: 0.3 },
      { type: "stats", stats: { them: { sentFrames: 5, droppedFrames: 1 }, me: { sentFrames: 4, droppedFrames: 0 } } },
    );
    expect(state.channels.me).toMatchObject({ level: 0.3, sentFrames: 4, droppedFrames: 0 });
    expect(state.channels.them).toMatchObject({ sentFrames: 5, droppedFrames: 1 });
  });

  it("failed mostra o erro e zera os níveis; starting limpa o erro anterior", () => {
    const failed = run({ type: "level", channel: "them", rms: 0.8 }, { type: "failed", message: "Chave de acesso inválida." });
    expect(failed.status).toBe("error");
    expect(failed.errorMessage).toBe("Chave de acesso inválida.");
    expect(failed.channels.them.level).toBe(0);

    const restarted = reduce(failed, { type: "starting", suggestionsEnabled: true });
    expect(restarted.errorMessage).toBeNull();
    expect(restarted.status).toBe("starting");
  });

  it("session.ended e stopped levam ao estado parado mantendo o último texto", () => {
    const ended = run(
      { type: "starting", suggestionsEnabled: true },
      { type: "engine", message: started },
      { type: "engine", message: partial(1, "último") },
      { type: "engine", message: { v: 1, type: "session.ended", sessionId: "s1", reason: "stopped" } },
    );
    expect(ended.status).toBe("idle");
    expect(ended.captions[0]?.partial).toBe("último");
    expect(reduce(ended, { type: "stopped" }).status).toBe("idle");
  });

  it("mostra o aviso de reconexão do Deepgram enquanto algum canal reconecta", () => {
    const status = (seq: number, channel: "them" | "me", state: "reconnecting" | "ok"): StoreAction => ({
      type: "engine",
      message: { v: 1, sessionId: "s1", seq, ts: 0, type: "stt.status", channel, state },
    });
    const state = run({ type: "engine", message: started }, status(1, "them", "reconnecting"), status(2, "me", "reconnecting"), status(3, "them", "ok"));
    expect(state.notice).toBe(STT_RECONNECTING_NOTICE);
    expect(state.sttReconnecting).toEqual({ them: false, me: true });
    expect(reduce(state, status(4, "me", "ok")).notice).toBeNull();
  });

  it("a volta do Deepgram não apaga um aviso de outra origem", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: { v: 1, sessionId: "s1", seq: 1, ts: 0, type: "stt.status", channel: "them", state: "reconnecting" } },
      { type: "notice", message: "Tradução indisponível." },
      { type: "engine", message: { v: 1, sessionId: "s1", seq: 2, ts: 0, type: "stt.status", channel: "them", state: "ok" } },
    );
    expect(state.notice).toBe("Tradução indisponível.");
  });

  it("starting guarda se esta sessão tem sugestões", () => {
    expect(initialState().suggestionsEnabled).toBe(true);
    expect(run({ type: "starting", suggestionsEnabled: false }).suggestionsEnabled).toBe(false);
  });
});

describe("SessionStore", () => {
  it("snapshot devolve o estado atual para um painel reaberto", () => {
    const store = new SessionStore();
    store.dispatch({ type: "starting", suggestionsEnabled: true });
    store.dispatch({ type: "engine", message: started });
    store.dispatch({ type: "engine", message: partial(1, "olá") });
    expect(store.snapshot()).toMatchObject({ status: "running", captions: [{ partial: "olá" }] });
  });

  it("notifica assinantes e permite cancelar a assinatura", () => {
    const store = new SessionStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((state) => seen.push(state.status));
    store.dispatch({ type: "starting", suggestionsEnabled: true });
    unsubscribe();
    store.dispatch({ type: "stopped" });
    expect(seen).toEqual(["starting"]);
  });
});

const event = (seq: number, body: Record<string, unknown>): EngineMessage =>
  ({ v: 1, sessionId: "s1", seq, ts: 0, channel: "them", utteranceId: "them-1", ...body }) as EngineMessage;

describe("falas", () => {
  it("monta a fala com parcial, segmentos estáveis e fim", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: event(1, { type: "transcript.partial", text: "hel" }) },
      { type: "engine", message: event(2, { type: "transcript.segment", segmentIdx: 0, text: "Hello there." }) },
      { type: "engine", message: event(3, { type: "transcript.partial", text: "how" }) },
      { type: "engine", message: event(4, { type: "utterance.end", interrupted: false }) },
    );
    expect(state.captions).toEqual([
      { utteranceId: "them-1", channel: "them", segments: ["Hello there."], partial: "", ended: true, interrupted: false, sentences: {} },
    ]);
  });

  it("registra frases prontas, traduções e falhas", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: event(1, { type: "transcript.segment", segmentIdx: 0, text: "Hi. Bye." }) },
      { type: "engine", message: event(2, { type: "sentence.ready", sentenceIdx: 0, text: "Hi." }) },
      { type: "engine", message: event(3, { type: "sentence.ready", sentenceIdx: 1, text: "Bye." }) },
      { type: "sentence-translated", sessionId: "s1", utteranceId: "them-1", sentenceIdx: 1, text: "Tchau." },
      { type: "sentence-translation-failed", sessionId: "s1", utteranceId: "them-1", sentenceIdx: 0 },
    );
    expect(state.captions[0]?.sentences).toEqual({
      0: { source: "Hi.", translation: null, failed: true },
      1: { source: "Bye.", translation: "Tchau.", failed: false },
    });
  });

  it("ignora tradução de uma fala que já saiu da legenda", () => {
    const before = run({ type: "engine", message: started });
    expect(reduce(before, { type: "sentence-translated", sessionId: "s1", utteranceId: "them-9", sentenceIdx: 0, text: "x" })).toBe(before);
  });

  it("remove a fala encerrada sem nenhum segmento estável", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: event(1, { type: "transcript.partial", text: "uh" }) },
      { type: "engine", message: event(2, { type: "utterance.end", interrupted: true }) },
    );
    expect(state.captions).toEqual([]);
  });

  it("mantém as falas dos dois canais na ordem em que começaram", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: event(1, { type: "transcript.partial", text: "a" }) },
      { type: "engine", message: event(2, { type: "transcript.partial", channel: "me", utteranceId: "me-1", text: "b" }) },
      { type: "engine", message: event(3, { type: "transcript.segment", segmentIdx: 0, text: "A." }) },
    );
    expect(state.captions.map((c) => c.utteranceId)).toEqual(["them-1", "me-1"]);
  });

  it("guarda no máximo as 200 falas mais recentes", () => {
    const actions: StoreAction[] = [{ type: "engine", message: started }];
    for (let i = 1; i <= 205; i++) {
      actions.push({ type: "engine", message: event(i, { type: "transcript.partial", utteranceId: `them-${i}`, text: `t${i}` }) });
    }
    const state = run(...actions);
    expect(state.captions).toHaveLength(MAX_CAPTIONS);
    expect(state.captions[0]?.utteranceId).toBe("them-6");
  });

  it("evento de erro e aviso local viram aviso sem encerrar a sessão", () => {
    const state = run(
      { type: "starting", suggestionsEnabled: true },
      { type: "engine", message: started },
      {
        type: "engine",
        message: { v: 1, sessionId: "s1", seq: 1, ts: 0, type: "error", scope: "stt", code: "stt_connection_lost", retryable: false, channel: "them", message: "A transcrição parou." },
      },
    );
    expect(state).toMatchObject({ status: "running", notice: "A transcrição parou." });
    expect(reduce(state, { type: "notice", message: "Tradução indisponível." }).notice).toBe("Tradução indisponível.");
  });

  it("um novo início limpa falas e avisos anteriores", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: event(1, { type: "transcript.partial", text: "old" }) },
      { type: "notice", message: "aviso" },
      { type: "starting", suggestionsEnabled: true },
    );
    expect(state.captions).toEqual([]);
    expect(state.notice).toBeNull();
  });
  it("ignora tradução de outra sessão, mesmo com o mesmo utteranceId", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: event(1, { type: "transcript.segment", segmentIdx: 0, text: "Hi." }) },
      { type: "engine", message: event(2, { type: "sentence.ready", sentenceIdx: 0, text: "Hi." }) },
    );
    expect(reduce(state, { type: "sentence-translated", sessionId: "s0", utteranceId: "them-1", sentenceIdx: 0, text: "velha" })).toBe(state);
  });

  it("stopping mostra que a sessão está finalizando e zera os níveis", () => {
    const state = run({ type: "engine", message: started }, { type: "level", channel: "them", rms: 0.5 }, { type: "stopping" });
    expect(state.status).toBe("stopping");
    expect(state.channels.them.level).toBe(0);
  });
  it("clear-notice apaga só o aviso indicado", () => {
    const state = run({ type: "notice", message: "A" });
    expect(reduce(state, { type: "clear-notice", message: "A" }).notice).toBeNull();
    expect(reduce(state, { type: "clear-notice", message: "B" })).toBe(state);
  });
});

const suggestionEvent = (seq: number, body: Record<string, unknown>): EngineMessage =>
  ({ v: 1, sessionId: "s1", seq, ts: 0, ...body }) as EngineMessage;

describe("sugestão", () => {
  it("monta a sugestão com started, deltas e done", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: suggestionEvent(1, { type: "suggestion.started", requestId: "auto-1", trigger: "auto", basedOnUtteranceId: "them-2" }) },
      { type: "engine", message: suggestionEvent(2, { type: "suggestion.delta", requestId: "auto-1", lang: "en", text: "Sure, " }) },
      { type: "engine", message: suggestionEvent(3, { type: "suggestion.delta", requestId: "auto-1", lang: "en", text: "I can." }) },
      { type: "engine", message: suggestionEvent(4, { type: "suggestion.delta", requestId: "auto-1", lang: "pt", text: "Claro." }) },
    );
    expect(state.suggestion).toEqual({
      requestId: "auto-1",
      trigger: "auto",
      status: "streaming",
      en: "Sure, I can.",
      pt: "Claro.",
      basedOnUtteranceId: "them-2",
      errorCode: null,
    });
    const done = reduce(state, { type: "engine", message: suggestionEvent(5, { type: "suggestion.done", requestId: "auto-1", en: "Sure, I can.", pt: "Claro, posso." }) });
    expect(done.suggestion).toMatchObject({ status: "done", en: "Sure, I can.", pt: "Claro, posso." });
  });

  it("ignora deltas de outra sugestão e uma nova substitui a atual", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: suggestionEvent(1, { type: "suggestion.started", requestId: "a", trigger: "auto", basedOnUtteranceId: null }) },
      { type: "engine", message: suggestionEvent(2, { type: "suggestion.started", requestId: "b", trigger: "manual", basedOnUtteranceId: null }) },
      { type: "engine", message: suggestionEvent(3, { type: "suggestion.delta", requestId: "a", lang: "en", text: "old" }) },
      { type: "engine", message: suggestionEvent(4, { type: "suggestion.error", requestId: "a", code: "cancelled" }) },
    );
    expect(state.suggestion).toMatchObject({ requestId: "b", status: "streaming", en: "" });
  });

  it("pedido recusado vira aviso curto sem apagar a sugestão atual", () => {
    const base = run(
      { type: "engine", message: started },
      { type: "engine", message: suggestionEvent(1, { type: "suggestion.started", requestId: "a", trigger: "manual", basedOnUtteranceId: null }) },
    );
    const busy = reduce(base, { type: "engine", message: suggestionEvent(2, { type: "suggestion.error", requestId: "b", code: "busy" }) });
    expect(busy.suggestionNotice).toBe(BUSY_SUGGESTION_NOTICE);
    expect(busy.suggestion?.requestId).toBe("a");
    const rate = reduce(base, { type: "engine", message: suggestionEvent(2, { type: "suggestion.error", requestId: "c", code: "rate_limited" }) });
    expect(rate.suggestionNotice).toBe(RATE_LIMITED_SUGGESTION_NOTICE);
  });

  it("o aviso de pedido recusado não esconde outros avisos e some quando a sugestão termina", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "notice", message: "A transcrição da sua voz parou." },
      { type: "engine", message: suggestionEvent(1, { type: "suggestion.started", requestId: "a", trigger: "manual", basedOnUtteranceId: null }) },
      { type: "engine", message: suggestionEvent(2, { type: "suggestion.error", requestId: "b", code: "busy" }) },
    );
    expect(state.notice).toBe("A transcrição da sua voz parou.");
    const done = reduce(state, { type: "engine", message: suggestionEvent(3, { type: "suggestion.done", requestId: "a", en: "Hi.", pt: "Oi." }) });
    expect(done.suggestionNotice).toBeNull();
    const next = reduce(state, { type: "engine", message: suggestionEvent(3, { type: "suggestion.started", requestId: "c", trigger: "auto", basedOnUtteranceId: null }) });
    expect(next.suggestionNotice).toBeNull();
  });

  it("erro da sugestão atual marca o estado de erro", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: suggestionEvent(1, { type: "suggestion.started", requestId: "a", trigger: "manual", basedOnUtteranceId: null }) },
      { type: "engine", message: suggestionEvent(2, { type: "suggestion.error", requestId: "a", code: "timeout" }) },
    );
    expect(state.suggestion).toMatchObject({ status: "error", errorCode: "timeout" });
  });

  it("um novo início limpa a sugestão", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: suggestionEvent(1, { type: "suggestion.started", requestId: "a", trigger: "manual", basedOnUtteranceId: null }) },
      { type: "starting", suggestionsEnabled: true },
    );
    expect(state.suggestion).toBeNull();
  });
});

describe("limpar", () => {
  it("apaga as falas terminadas e mantém a fala em andamento", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: event(1, { type: "transcript.segment", segmentIdx: 0, text: "Hello." }) },
      { type: "engine", message: event(2, { type: "utterance.end", interrupted: false }) },
      { type: "engine", message: event(3, { type: "transcript.partial", utteranceId: "them-2", text: "and" }) },
      { type: "clear" },
    );
    expect(state.captions.map((c) => c.utteranceId)).toEqual(["them-2"]);
  });

  it("apaga a sugestão pronta e o aviso de sugestão", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: suggestionEvent(1, { type: "suggestion.started", requestId: "a", trigger: "manual", basedOnUtteranceId: null }) },
      { type: "engine", message: suggestionEvent(2, { type: "suggestion.done", requestId: "a", en: "Hi.", pt: "Oi." }) },
      { type: "engine", message: suggestionEvent(3, { type: "suggestion.error", requestId: "b", code: "busy" }) },
      { type: "clear" },
    );
    expect(state.suggestion).toBeNull();
    expect(state.suggestionNotice).toBeNull();
  });

  it("mantém a sugestão que ainda está sendo gerada", () => {
    const state = run(
      { type: "engine", message: started },
      { type: "engine", message: suggestionEvent(1, { type: "suggestion.started", requestId: "a", trigger: "manual", basedOnUtteranceId: null }) },
      { type: "clear" },
    );
    expect(state.suggestion?.requestId).toBe("a");
  });
});
