import { describe, expect, it } from "vitest";
import { MAX_CONTEXT_CHARS, isServerEvent, parseClientMessage, parseServerMessage, type ServerMessage } from "./messages";

describe("parseClientMessage", () => {
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
  it("distingue eventos (com seq) de mensagens de controle", () => {
    const control: ServerMessage = { v: 1, type: "session.started", sessionId: "s", resumeToken: "r" };
    const event: ServerMessage = { v: 1, type: "transcript.partial", sessionId: "s", seq: 1, ts: 0, channel: "them", text: "hi" };
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
    const partial = { v: 1, type: "transcript.partial", sessionId: "s", seq: 1, ts: 0, channel: "them", text: "hi" };
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
});
