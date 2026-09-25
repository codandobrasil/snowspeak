import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@snowspeak/shared";
import { SessionStore, initialState, reduce, type SessionState, type StoreAction } from "./session-store";

const started: ServerMessage = { v: 1, type: "session.started", sessionId: "s1", resumeToken: "r1" };
const partial = (seq: number, text: string): ServerMessage => ({
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
    const state = run({ type: "starting" }, { type: "server", message: started });
    expect(state.status).toBe("running");
    expect(state.sessionId).toBe("s1");
  });

  it("aplica o texto parcial e ignora eventos com seq repetido ou antigo", () => {
    const state = run(
      { type: "starting" },
      { type: "server", message: started },
      { type: "server", message: partial(1, "um") },
      { type: "server", message: partial(2, "dois") },
      { type: "server", message: partial(2, "repetido") },
      { type: "server", message: partial(1, "antigo") },
    );
    expect(state.channels.them.lastPartial).toBe("dois");
    expect(state.lastSeq).toBe(2);
  });

  it("soma a duração das lacunas de áudio por canal", () => {
    const gap = (seq: number, durationMs: number): ServerMessage => ({
      v: 1,
      type: "audio.gap",
      sessionId: "s1",
      seq,
      ts: 0,
      channel: "me",
      durationMs,
      reason: "client_drop",
    });
    const state = run({ type: "server", message: started }, { type: "server", message: gap(1, 100) }, { type: "server", message: gap(2, 250) });
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

    const restarted = reduce(failed, { type: "starting" });
    expect(restarted.errorMessage).toBeNull();
    expect(restarted.status).toBe("starting");
  });

  it("session.ended e stopped levam ao estado parado mantendo o último texto", () => {
    const ended = run(
      { type: "starting" },
      { type: "server", message: started },
      { type: "server", message: partial(1, "último") },
      { type: "server", message: { v: 1, type: "session.ended", sessionId: "s1", reason: "stopped" } },
    );
    expect(ended.status).toBe("idle");
    expect(ended.channels.them.lastPartial).toBe("último");
    expect(reduce(ended, { type: "stopped" }).status).toBe("idle");
  });
});

describe("SessionStore", () => {
  it("snapshot devolve o estado atual para um painel reaberto", () => {
    const store = new SessionStore();
    store.dispatch({ type: "starting" });
    store.dispatch({ type: "server", message: started });
    store.dispatch({ type: "server", message: partial(1, "olá") });
    expect(store.snapshot()).toMatchObject({ status: "running", channels: { them: { lastPartial: "olá" } } });
  });

  it("notifica assinantes e permite cancelar a assinatura", () => {
    const store = new SessionStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((state) => seen.push(state.status));
    store.dispatch({ type: "starting" });
    unsubscribe();
    store.dispatch({ type: "stopped" });
    expect(seen).toEqual(["starting"]);
  });
});
