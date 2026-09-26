import { describe, expect, it } from "vitest";
import { MAX_CONTEXT_CHARS, MAX_PROFILE_CHARS, MAX_QUESTION_CHARS, isServerEvent, parseClientMessage, parseServerMessage, type ServerMessage } from "./messages";

describe("parseClientMessage", () => {
  it("aceita session.resume válido e recusa lastSeq negativo ou campos vazios", () => {
    const resume = { type: "session.resume", token: "k", sessionId: "s1", resumeToken: "r1", lastSeq: 12 };
    expect(parseClientMessage(JSON.stringify(resume))).toEqual(resume);
    expect(parseClientMessage(JSON.stringify({ ...resume, lastSeq: -1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...resume, lastSeq: 1.5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...resume, sessionId: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...resume, resumeToken: "" }))).toBeNull();
  });

  it("aceita session.start válido", () => {
    const raw = JSON.stringify({ type: "session.start", token: "k", mode: "interview", context: "dev backend" });
    expect(parseClientMessage(raw)).toEqual({ type: "session.start", token: "k", mode: "interview", context: "dev backend" });
  });

  it("aceita session.stop", () => {
    expect(parseClientMessage('{"type":"session.stop"}')).toEqual({ type: "session.stop" });
  });

  it("rejeita contexto acima de 2.000 caracteres", () => {
    const raw = JSON.stringify({ type: "session.start", token: "k", mode: "work", context: "x".repeat(MAX_CONTEXT_CHARS + 1) });
    expect(parseClientMessage(raw)).toBeNull();
  });

  it("rejeita modo desconhecido, token vazio, tipo desconhecido e JSON inválido", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.start", token: "k", mode: "party", context: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "session.start", token: "", mode: "work", context: "" }))).toBeNull();
    expect(parseClientMessage('{"type":"session.explode"}')).toBeNull();
    expect(parseClientMessage("{not json")).toBeNull();
  });
});

describe("mensagens do servidor", () => {
  it("aceita as mensagens de controle da retomada, sem seq", () => {
    const resumed = { v: 1, type: "session.resumed", sessionId: "s1", throughSeq: 40 };
    const superseded = { v: 1, type: "session.superseded", sessionId: "s1" };
    const heartbeat = { v: 1, type: "heartbeat", sessionId: "s1" };
    for (const message of [resumed, superseded, heartbeat]) {
      const parsed = parseServerMessage(JSON.stringify(message));
      expect(parsed).toEqual(message);
      expect(parsed && isServerEvent(parsed)).toBe(false);
    }
    expect(parseServerMessage(JSON.stringify({ ...resumed, throughSeq: -1 }))).toBeNull();
  });

  it("distingue eventos (com seq) de mensagens de controle", () => {
    const control: ServerMessage = { v: 1, type: "session.started", sessionId: "s", resumeToken: "r" };
    const event: ServerMessage = { v: 1, type: "transcript.partial", sessionId: "s", seq: 1, ts: 0, channel: "them", utteranceId: "them-1", text: "hi" };
    expect(isServerEvent(control)).toBe(false);
    expect(isServerEvent(event)).toBe(true);
  });

  it("aceita mensagens de controle e eventos completos", () => {
    expect(parseServerMessage('{"v":1,"type":"session.ended","sessionId":"s","reason":"stopped"}')).toEqual({
      v: 1,
      type: "session.ended",
      sessionId: "s",
      reason: "stopped",
    });
    const gap = { v: 1, type: "audio.gap", sessionId: "s", seq: 3, ts: 10, channel: "me", durationMs: 100, reason: "client_drop" };
    expect(parseServerMessage(JSON.stringify(gap))).toEqual(gap);
  });

  it("rejeita versão errada, JSON inválido e formatos que não são objeto", () => {
    expect(parseServerMessage('{"v":2,"type":"session.ended","sessionId":"s","reason":"stopped"}')).toBeNull();
    expect(parseServerMessage("[]")).toBeNull();
    expect(parseServerMessage("nope")).toBeNull();
  });

  it("rejeita evento sem seq, com seq inválido ou canal desconhecido", () => {
    const partial = { v: 1, type: "transcript.partial", sessionId: "s", seq: 1, ts: 0, channel: "them", utteranceId: "them-1", text: "hi" };
    const { seq: _seq, ...withoutSeq } = partial;
    expect(parseServerMessage(JSON.stringify(withoutSeq))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...partial, seq: 0 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...partial, seq: 1.5 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...partial, channel: "all" }))).toBeNull();
  });

  it("rejeita controle sem sessionId e motivo de encerramento desconhecido", () => {
    expect(parseServerMessage('{"v":1,"type":"session.started","resumeToken":"r"}')).toBeNull();
    expect(parseServerMessage('{"v":1,"type":"session.ended","sessionId":"s","reason":"bored"}')).toBeNull();
  });
  it("aceita os eventos de transcrição e de frase pronta", () => {
    const base = { v: 1, sessionId: "s", seq: 1, ts: 0, channel: "them", utteranceId: "them-1" };
    const events = [
      { ...base, type: "transcript.partial", text: "hel" },
      { ...base, type: "transcript.segment", segmentIdx: 0, text: "Hello." },
      { ...base, type: "utterance.end", interrupted: false },
      { ...base, type: "sentence.ready", sentenceIdx: 0, text: "Hello." },
    ];
    for (const event of events) expect(parseServerMessage(JSON.stringify(event))).toEqual(event);
  });

  it("aceita evento de erro com e sem canal", () => {
    const error = { v: 1, sessionId: "s", seq: 2, ts: 0, type: "error", scope: "stt", code: "stt_connection_lost", retryable: false, message: "caiu" };
    expect(parseServerMessage(JSON.stringify(error))).toEqual(error);
    expect(parseServerMessage(JSON.stringify({ ...error, channel: "me" }))).toEqual({ ...error, channel: "me" });
    expect(parseServerMessage(JSON.stringify({ ...error, scope: "universe" }))).toBeNull();
  });

  it("rejeita eventos de fala sem utteranceId ou com índice inválido", () => {
    const base = { v: 1, sessionId: "s", seq: 1, ts: 0, channel: "them" };
    expect(parseServerMessage(JSON.stringify({ ...base, type: "transcript.partial", text: "x" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...base, utteranceId: "them-1", type: "transcript.segment", segmentIdx: -1, text: "x" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...base, utteranceId: "them-1", type: "sentence.ready", sentenceIdx: 0.5, text: "b" }))).toBeNull();
  });
});

describe("mensagens de sugestão", () => {
  it("session.start aceita currículo e vaga opcionais, com limite", () => {
    const start = { type: "session.start", token: "k", mode: "interview", context: "", profile: "Dev backend 8 anos", job: "Senior Backend" };
    expect(parseClientMessage(JSON.stringify(start))).toEqual(start);
    expect(parseClientMessage(JSON.stringify({ ...start, profile: "x".repeat(MAX_PROFILE_CHARS + 1) }))).toBeNull();
  });

  it("aceita session.update parcial e suggest.request", () => {
    expect(parseClientMessage('{"type":"session.update","job":"Nova vaga"}')).toEqual({ type: "session.update", job: "Nova vaga" });
    expect(parseClientMessage('{"type":"suggest.request","requestId":"abc"}')).toEqual({ type: "suggest.request", requestId: "abc" });
    expect(parseClientMessage('{"type":"suggest.request","requestId":""}')).toBeNull();
  });

  it("aceita suggest.request com a pergunta escolhida e recusa pergunta inválida", () => {
    const question = { utteranceId: "them-3", text: "Why fintech?" };
    expect(parseClientMessage(JSON.stringify({ type: "suggest.request", requestId: "a", question }))).toEqual({ type: "suggest.request", requestId: "a", question });
    expect(parseClientMessage(JSON.stringify({ type: "suggest.request", requestId: "a", question: { utteranceId: "", text: "x" } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "suggest.request", requestId: "a", question: { utteranceId: "them-3", text: "" } }))).toBeNull();
    const tooLong = "x".repeat(MAX_QUESTION_CHARS + 1);
    expect(parseClientMessage(JSON.stringify({ type: "suggest.request", requestId: "a", question: { utteranceId: "them-3", text: tooLong } }))).toBeNull();
  });

  it("aceita os eventos de sugestão", () => {
    const base = { v: 1, sessionId: "s", seq: 1, ts: 0, requestId: "r1" };
    const events = [
      { ...base, type: "suggestion.started", trigger: "auto", basedOnUtteranceId: "them-3" },
      { ...base, type: "suggestion.started", trigger: "manual", basedOnUtteranceId: null },
      { ...base, type: "suggestion.delta", lang: "en", text: "Sure" },
      { ...base, type: "suggestion.done", en: "Sure.", pt: "Claro." },
      { ...base, type: "suggestion.error", code: "busy" },
    ];
    for (const event of events) expect(parseServerMessage(JSON.stringify(event))).toEqual(event);
    expect(parseServerMessage(JSON.stringify({ ...base, type: "suggestion.error", code: "exploded" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...base, type: "suggestion.delta", lang: "es", text: "x" }))).toBeNull();
  });
});
