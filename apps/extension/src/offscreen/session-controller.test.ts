import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelStats } from "@snowspeak/engine";
import type { Channel, EngineMessage, SessionEndReason } from "@snowspeak/shared";
import {
  DEEPGRAM_UNAVAILABLE_MESSAGE,
  MIC_CAPTURE_TIMEOUT_MS,
  STATS_INTERVAL_MS,
  STOP_TIMEOUT_MS,
  TAB_CAPTURE_ENDED_MESSAGE,
  SessionController,
  type CaptureCallbacks,
  type ChannelCapture,
  type ControllerDeps,
  type EngineSession,
  type SessionSettingsChanges,
  type StartParams,
  type SuggestionQuestion,
} from "./session-controller";
import { SessionStore } from "./session-store";

class FakeSession implements EngineSession {
  readonly pcm: Array<[Channel, number]> = [];
  readonly updates: SessionSettingsChanges[] = [];
  readonly requests: Array<[string, SuggestionQuestion | undefined]> = [];
  stopping = false;
  closedWith: SessionEndReason | null = null;
  private opened = false;
  private settleStart: { resolve(): void; reject(error: Error): void } | null = null;
  private finishDrain: (() => void) | null = null;

  constructor(
    readonly params: StartParams,
    private readonly onMessage: (message: EngineMessage) => void,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settleStart = { resolve, reject };
    });
  }
  /** O Deepgram dos participantes abriu. */
  open(): void {
    this.opened = true;
    this.onMessage({ v: 1, type: "session.started", sessionId: "s1" });
    this.settleStart?.resolve();
  }
  /** O Deepgram recusou a primeira conexão (ou a sessão fechou antes de abrir). */
  refuse(): void {
    this.settleStart?.reject(new Error("Deepgram encerrou a conexão (código 1006)"));
  }
  emit(message: EngineMessage): void {
    this.onMessage(message);
  }
  acceptPcm(channel: Channel, pcm: Uint8Array): void {
    this.pcm.push([channel, pcm.byteLength]);
  }
  stats(): Record<Channel, ChannelStats> {
    return { them: { sentFrames: 3, droppedFrames: 1 }, me: { sentFrames: 2, droppedFrames: 0 } };
  }
  update(changes: SessionSettingsChanges): void {
    this.updates.push(changes);
  }
  requestSuggestion(requestId: string, question?: SuggestionQuestion): void {
    this.requests.push([requestId, question]);
  }
  beginStop(): void {
    this.stopping = true;
  }
  drain(): Promise<void> {
    return new Promise((resolve) => {
      this.finishDrain = resolve;
    });
  }
  drained(): void {
    this.finishDrain?.();
  }
  close(reason: SessionEndReason): void {
    if (this.closedWith) return;
    this.closedWith = reason;
    if (this.opened) this.onMessage({ v: 1, type: "session.ended", sessionId: "s1", reason });
  }
}

interface FakeCapture extends ChannelCapture {
  stopped: boolean;
}

function fakeCapture(): FakeCapture {
  const capture: FakeCapture = {
    stopped: false,
    stop() {
      capture.stopped = true;
    },
  };
  return capture;
}

const params: StartParams = {
  streamId: "stream-1",
  deepgramKey: "dg-key",
  openRouterKey: "or-key",
  suggestionModel: "anthropic/claude-haiku-4.5",
  responseLength: "medium",
  suggestionsOn: true,
  mode: "work",
  context: "",
  profile: "Node dev",
  job: "Backend",
};

// Deixa as capturas (promessas já resolvidas) andarem até a criação da sessão; funciona com timers falsos.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface SetupOverrides {
  tab?: () => Promise<ChannelCapture>;
  mic?: () => Promise<ChannelCapture>;
}

function setup(overrides: SetupOverrides = {}) {
  const store = new SessionStore();
  const sessions: FakeSession[] = [];
  const tab = fakeCapture();
  const mic = fakeCapture();
  let callbacks: CaptureCallbacks | null = null;
  let requestIds = 0;
  const onEngineMessage = vi.fn((_message: EngineMessage): void => undefined);

  const deps: ControllerDeps = {
    store,
    captureTab: vi.fn((_streamId: string, cb: CaptureCallbacks) => {
      callbacks = cb;
      return overrides.tab ? overrides.tab() : Promise.resolve(tab);
    }),
    captureMic: vi.fn(() => (overrides.mic ? overrides.mic() : Promise.resolve(mic))),
    createSession: (sessionParams, onMessage) => {
      const session = new FakeSession(sessionParams, onMessage);
      sessions.push(session);
      return session;
    },
    onEngineMessage,
    newRequestId: () => `req-${++requestIds}`,
  };

  return {
    controller: new SessionController(deps),
    store,
    sessions,
    tab,
    mic,
    onEngineMessage,
    session(): FakeSession {
      const session = sessions.at(-1);
      if (!session) throw new Error("nenhuma sessão criada");
      return session;
    },
    emitFrame(channel: Channel) {
      callbacks?.onFrame(channel, new ArrayBuffer(3200));
    },
    emitLevel(channel: Channel, rms: number) {
      callbacks?.onLevel(channel, rms);
    },
    emitEnded(channel: Channel) {
      callbacks?.onEnded(channel);
    },
  };
}

async function startRunning(t: ReturnType<typeof setup>): Promise<FakeSession> {
  const starting = t.controller.start(params);
  await settle();
  t.session().open();
  await starting;
  return t.session();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionController", () => {
  it("cria a sessão com as chaves depois de capturar aba e microfone e fica rodando quando o Deepgram abre", async () => {
    const t = setup();
    const session = await startRunning(t);
    expect(session.params).toEqual(params);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "active", sessionId: "s1", suggestionsEnabled: true });
  });

  it("sem chave do OpenRouter, a sessão começa com as sugestões desligadas", async () => {
    const t = setup();
    const starting = t.controller.start({ ...params, openRouterKey: "" });
    expect(t.store.snapshot().suggestionsEnabled).toBe(false);
    await settle();
    t.session().open();
    await starting;
  });

  it("só entrega áudio depois que o Deepgram abriu", async () => {
    const t = setup();
    const starting = t.controller.start(params);
    await settle();
    t.emitFrame("them");
    expect(t.session().pcm).toEqual([]);
    t.session().open();
    await starting;
    t.emitFrame("them");
    t.emitFrame("me");
    expect(t.session().pcm).toEqual([
      ["them", 3200],
      ["me", 3200],
    ]);
  });

  it("falha com a mensagem do Deepgram e libera as capturas quando a primeira conexão é recusada", async () => {
    const t = setup();
    const starting = t.controller.start(params);
    await settle();
    t.session().refuse();
    await starting;
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: DEEPGRAM_UNAVAILABLE_MESSAGE });
    expect(t.tab.stopped).toBe(true);
    expect(t.mic.stopped).toBe(true);
    expect(t.session().closedWith).toBe("error");
  });

  it("segue só com a aba quando o microfone é negado", async () => {
    const t = setup({ mic: () => Promise.reject(new Error("denied")) });
    await startRunning(t);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "denied" });
  });

  it("segue sem microfone quando o pedido do microfone não responde", async () => {
    vi.useFakeTimers();
    const t = setup({ mic: () => new Promise<ChannelCapture>(() => undefined) });
    const starting = t.controller.start(params);
    await vi.advanceTimersByTimeAsync(MIC_CAPTURE_TIMEOUT_MS);
    t.session().open();
    await starting;
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "denied" });
  });

  it("falha sem criar sessão quando a captura da aba falha", async () => {
    const t = setup({ tab: () => Promise.reject(new Error("sem permissão")) });
    await t.controller.start(params);
    expect(t.sessions).toEqual([]);
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: "Não foi possível capturar o áudio da aba: sem permissão" });
  });

  it("ignora um segundo start enquanto o primeiro está em andamento", async () => {
    const t = setup();
    const first = t.controller.start(params);
    await t.controller.start(params);
    await settle();
    expect(t.sessions).toHaveLength(1);
    t.session().open();
    await first;
  });

  it("stop espera as últimas falas do Deepgram e depois encerra", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.stop();
    expect(t.tab.stopped).toBe(true);
    expect(session.stopping).toBe(true);
    expect(t.store.snapshot().status).toBe("stopping");
    expect(session.closedWith).toBeNull();
    session.drained();
    await settle();
    expect(session.closedWith).toBe("stopped");
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("stop desiste de esperar depois do prazo de segurança", async () => {
    vi.useFakeTimers();
    const t = setup();
    const session = await startRunning(t);
    t.controller.stop();
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    expect(session.closedWith).toBe("stopped");
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("stop antes de o Deepgram abrir libera tudo na hora", async () => {
    const t = setup();
    const starting = t.controller.start(params);
    await settle();
    t.controller.stop();
    expect(t.store.snapshot().status).toBe("idle");
    expect(t.tab.stopped).toBe(true);
    expect(t.session().closedWith).toBe("stopped");
    // A sessão real rejeita o start pendente ao fechar; isso não pode virar erro na tela.
    t.session().refuse();
    await starting;
    expect(t.store.snapshot()).toMatchObject({ status: "idle", errorMessage: null });
  });

  it("stop durante a captura da aba descarta a captura atrasada", async () => {
    let resolveTab: (capture: ChannelCapture) => void = () => undefined;
    const t = setup({
      tab: () =>
        new Promise<ChannelCapture>((resolve) => {
          resolveTab = resolve;
        }),
    });
    const starting = t.controller.start(params);
    t.controller.stop();
    resolveTab(t.tab);
    await starting;
    expect(t.tab.stopped).toBe(true);
    expect(t.sessions).toEqual([]);
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("encerra a sessão quando a captura da aba termina", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.emitEnded("them");
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: TAB_CAPTURE_ENDED_MESSAGE });
    expect(session.closedWith).toBe("error");
    expect(t.mic.stopped).toBe(true);
  });

  it("ignora o fim da captura da aba enquanto finaliza", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.stop();
    t.emitEnded("them");
    expect(t.store.snapshot().status).toBe("stopping");
    session.drained();
    await settle();
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("segue só com a aba quando o microfone deixa de funcionar", async () => {
    const t = setup();
    await startRunning(t);
    t.emitEnded("me");
    expect(t.mic.stopped).toBe(true);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "denied" });
  });

  it("aplica as mensagens do motor ao store e depois as repassa ao gancho", async () => {
    const t = setup();
    const session = await startRunning(t);
    const partial: EngineMessage = { v: 1, type: "transcript.partial", sessionId: "s1", seq: 1, ts: 0, channel: "them", utteranceId: "them-1", text: "hi" };
    t.onEngineMessage.mockImplementation((): void => {
      expect(t.store.snapshot().captions[0]?.partial).toBe("hi");
    });
    session.emit(partial);
    expect(t.onEngineMessage).toHaveBeenLastCalledWith(partial);
  });

  it("publica estatísticas de frames periodicamente", async () => {
    vi.useFakeTimers();
    const t = setup();
    await startRunning(t);
    vi.advanceTimersByTime(STATS_INTERVAL_MS);
    expect(t.store.snapshot().channels.them).toMatchObject({ sentFrames: 3, droppedFrames: 1 });
  });

  it("pede sugestão com um requestId novo, com ou sem pergunta escolhida", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.requestSuggestion();
    t.controller.requestSuggestion({ utteranceId: "them-3", text: "Why us?" });
    expect(session.requests).toEqual([
      ["req-1", undefined],
      ["req-2", { utteranceId: "them-3", text: "Why us?" }],
    ]);
  });

  it("não pede sugestão nem repassa mudanças antes de o Deepgram abrir", async () => {
    const t = setup();
    const starting = t.controller.start(params);
    await settle();
    t.controller.requestSuggestion();
    t.controller.update({ mode: "interview" });
    expect(t.session().requests).toEqual([]);
    expect(t.session().updates).toEqual([]);
    t.session().open();
    await starting;
  });

  it("com as sugestões desligadas, pedidos não chegam à sessão; religando, voltam", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.setSuggestionsOn(false);
    expect(t.store.snapshot().suggestionsOn).toBe(false);
    t.controller.requestSuggestion();
    expect(session.requests).toEqual([]);
    t.controller.setSuggestionsOn(true);
    t.controller.requestSuggestion();
    expect(session.requests).toHaveLength(1);
  });

  it("sessão iniciada com as sugestões desligadas não pede sugestão", async () => {
    const t = setup();
    const starting = t.controller.start({ ...params, suggestionsOn: false });
    await settle();
    t.session().open();
    await starting;
    expect(t.store.snapshot().suggestionsOn).toBe(false);
    t.controller.requestSuggestion();
    expect(t.session().requests).toEqual([]);
  });

  it("repassa o tamanho da resposta durante a sessão", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.update({ responseLength: "long" });
    expect(session.updates).toEqual([{ responseLength: "long" }]);
  });

  it("repassa mudanças de contexto durante a sessão", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.update({ profile: "Kafka" });
    expect(session.updates).toEqual([{ profile: "Kafka" }]);
  });
});

describe("microfone desligado", () => {
  it("não entrega o áudio do microfone enquanto desligado e volta a entregar ao religar", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.setMicMuted(true);
    t.emitFrame("me");
    t.emitFrame("them");
    expect(session.pcm).toEqual([["them", 3200]]);
    expect(t.store.snapshot().micMuted).toBe(true);
    t.controller.setMicMuted(false);
    t.emitFrame("me");
    expect(session.pcm).toEqual([
      ["them", 3200],
      ["me", 3200],
    ]);
  });

  it("zera o nível do microfone e ignora o nível enquanto desligado", async () => {
    const t = setup();
    await startRunning(t);
    t.emitLevel("me", 0.5);
    t.controller.setMicMuted(true);
    expect(t.store.snapshot().channels.me.level).toBe(0);
    t.emitLevel("me", 0.7);
    expect(t.store.snapshot().channels.me.level).toBe(0);
  });

  it("sem sessão, não faz nada; nova sessão começa com o microfone ligado", async () => {
    const t = setup();
    t.controller.setMicMuted(true);
    expect(t.store.snapshot().micMuted).toBe(false);
    const first = await startRunning(t);
    t.controller.setMicMuted(true);
    t.controller.stop();
    first.drained();
    await settle();
    const second = await startRunning(t);
    t.emitFrame("me");
    expect(second.pcm).toEqual([["me", 3200]]);
    expect(t.store.snapshot().micMuted).toBe(false);
  });
});
