import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, type Channel, type ClientMessage, type ServerMessage } from "@snowspeak/shared";
import {
  MIC_CAPTURE_TIMEOUT_MS,
  SESSION_START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  STATS_INTERVAL_MS,
  SessionController,
  type CaptureCallbacks,
  type ChannelCapture,
  type ControllerDeps,
  type ControllerSocket,
  type SocketHandlers,
  type StartParams,
} from "./session-controller";
import { SessionStore } from "./session-store";

class FakeSocket implements ControllerSocket {
  bufferedAmount = 0;
  isOpen = false;
  closed = false;
  readonly binary: ArrayBuffer[] = [];
  readonly json: ClientMessage[] = [];

  constructor(
    readonly url: string,
    private readonly handlers: SocketHandlers,
  ) {}

  send(data: ArrayBuffer): void {
    this.binary.push(data);
  }
  sendJson(message: ClientMessage): void {
    if (this.isOpen) this.json.push(message);
  }
  close(): void {
    this.closed = true;
    this.isOpen = false;
  }
  open(): void {
    this.isOpen = true;
    this.handlers.onOpen();
  }
  receive(message: ServerMessage): void {
    this.handlers.onMessage(message);
  }
  serverClose(code: number, reason = ""): void {
    this.isOpen = false;
    this.handlers.onClose(code, reason);
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
  serverUrl: "ws://server/ws",
  token: "key-1",
  mode: "work",
  context: "",
  profile: "Node dev",
  job: "Backend",
};
const started: ServerMessage = { v: 1, type: "session.started", sessionId: "s1", resumeToken: "r1" };

interface SetupOverrides {
  tab?: () => Promise<ChannelCapture>;
  mic?: () => Promise<ChannelCapture>;
  openSocketError?: Error;
}

function setup(overrides: SetupOverrides = {}) {
  const store = new SessionStore();
  const sockets: FakeSocket[] = [];
  const tab = fakeCapture();
  const mic = fakeCapture();
  let callbacks: CaptureCallbacks | null = null;

  const deps: ControllerDeps = {
    store,
    captureTab: vi.fn((_streamId: string, cb: CaptureCallbacks) => {
      callbacks = cb;
      return overrides.tab ? overrides.tab() : Promise.resolve(tab);
    }),
    captureMic: vi.fn(() => (overrides.mic ? overrides.mic() : Promise.resolve(mic))),
    openSocket: (url, handlers) => {
      if (overrides.openSocketError) throw overrides.openSocketError;
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
  };

  return {
    controller: new SessionController(deps),
    deps,
    store,
    sockets,
    tab,
    mic,
    emitFrame(channel: Channel) {
      callbacks?.onFrame(channel, new ArrayBuffer(3200));
    },
    emitEnded(channel: Channel) {
      callbacks?.onEnded(channel);
    },
  };
}

async function startRunning(t: ReturnType<typeof setup>): Promise<FakeSocket> {
  await t.controller.start(params);
  const socket = t.sockets[0]!;
  socket.open();
  socket.receive(started);
  return socket;
}

describe("SessionController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("abre o socket e envia session.start depois de capturar aba e microfone", async () => {
    const t = setup();
    await t.controller.start(params);
    expect(t.deps.captureTab).toHaveBeenCalledWith("stream-1", expect.anything());
    expect(t.sockets).toHaveLength(1);
    t.sockets[0]!.open();
    expect(t.sockets[0]!.json).toEqual([{ type: "session.start", token: "key-1", mode: "work", context: "", profile: "Node dev", job: "Backend" }]);
    t.sockets[0]!.receive(started);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "active" });
  });

  it("só envia frames depois de session.started", async () => {
    const t = setup();
    await t.controller.start(params);
    const socket = t.sockets[0]!;
    socket.open();
    t.emitFrame("them");
    expect(socket.binary).toHaveLength(0);

    socket.receive(started);
    t.emitFrame("them");
    expect(socket.binary).toHaveLength(1);
    const decoded = decodeFrame(new Uint8Array(socket.binary[0]!));
    expect(decoded.ok && [decoded.frame.channel, decoded.frame.frameSeq, decoded.frame.sampleOffset]).toEqual(["them", 0, 0]);
  });

  it("segue só com a aba quando o microfone é negado", async () => {
    const t = setup({ mic: () => Promise.reject(new DOMException("denied", "NotAllowedError")) });
    await startRunning(t);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "denied" });
  });

  it("segue sem microfone quando o pedido do microfone não responde", async () => {
    let resolveMic!: (capture: ChannelCapture) => void;
    const t = setup({ mic: () => new Promise((resolve) => (resolveMic = resolve)) });
    const pending = t.controller.start(params);
    await vi.advanceTimersByTimeAsync(MIC_CAPTURE_TIMEOUT_MS);
    await pending;
    expect(t.sockets).toHaveLength(1);
    expect(t.store.snapshot().mic).toBe("denied");

    const late = fakeCapture();
    resolveMic(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.stopped).toBe(true);
  });

  it("falha sem abrir socket quando a captura da aba falha", async () => {
    const t = setup({ tab: () => Promise.reject(new Error("Permission dismissed")) });
    await t.controller.start(params);
    expect(t.sockets).toHaveLength(0);
    expect(t.deps.captureMic).not.toHaveBeenCalled();
    expect(t.store.snapshot().status).toBe("error");
    expect(t.store.snapshot().errorMessage).toBe("Não foi possível capturar o áudio da aba: Permission dismissed");
  });

  it("libera as capturas quando o socket não pode ser criado", async () => {
    const t = setup({ openSocketError: new SyntaxError("invalid url") });
    await t.controller.start(params);
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: "Endereço do servidor inválido." });
    expect(t.tab.stopped && t.mic.stopped).toBe(true);
    await t.controller.start(params); // um novo início volta a ser possível
    expect(t.deps.captureTab).toHaveBeenCalledTimes(2);
  });

  it("desiste e libera tudo quando session.started não chega no prazo", async () => {
    const t = setup();
    await t.controller.start(params);
    t.sockets[0]!.open();
    vi.advanceTimersByTime(SESSION_START_TIMEOUT_MS);
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: "O servidor não respondeu a tempo." });
    expect(t.sockets[0]!.closed).toBe(true);
    expect(t.tab.stopped && t.mic.stopped).toBe(true);
  });

  it("não aplica o prazo depois que a sessão começou", async () => {
    const t = setup();
    await startRunning(t);
    vi.advanceTimersByTime(SESSION_START_TIMEOUT_MS * 2);
    expect(t.store.snapshot().status).toBe("running");
  });

  it("ignora um segundo start enquanto o primeiro está em andamento", async () => {
    const t = setup();
    const first = t.controller.start(params);
    await t.controller.start(params);
    await first;
    expect(t.deps.captureTab).toHaveBeenCalledTimes(1);
    expect(t.sockets).toHaveLength(1);
  });

  it("mostra erro de conexão e libera capturas quando o servidor não aceita a conexão", async () => {
    const t = setup();
    await t.controller.start(params);
    t.sockets[0]!.serverClose(1006);
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: "Não foi possível conectar ao servidor." });
    expect(t.tab.stopped).toBe(true);
    expect(t.mic.stopped).toBe(true);
  });

  it("mostra chave inválida no fechamento 4401", async () => {
    const t = setup();
    await t.controller.start(params);
    t.sockets[0]!.open();
    t.sockets[0]!.serverClose(4401, "invalid token");
    expect(t.store.snapshot().errorMessage).toBe("Chave de acesso inválida.");
    expect(t.tab.stopped).toBe(true);
  });

  it("vai para parado quando o servidor encerra a sessão com 4410", async () => {
    const t = setup();
    const socket = await startRunning(t);
    socket.receive({ v: 1, type: "session.ended", sessionId: "s1", reason: "stopped" });
    socket.serverClose(4410);
    expect(t.store.snapshot()).toMatchObject({ status: "idle", errorMessage: null });
    expect(t.tab.stopped).toBe(true);
  });

  it("stop para a captura, envia session.stop e continua recebendo até o servidor encerrar", async () => {
    const t = setup();
    const seen: string[] = [];
    const controller = new SessionController({ ...t.deps, onServerMessage: (m) => seen.push(m.type) });
    await controller.start(params);
    const socket = t.sockets[0]!;
    socket.open();
    socket.receive(started);
    controller.stop();
    expect(socket.json.at(-1)).toEqual({ type: "session.stop" });
    expect(socket.closed).toBe(false);
    expect(t.tab.stopped && t.mic.stopped).toBe(true);
    expect(t.store.snapshot().status).toBe("stopping");

    socket.receive({ v: 1, sessionId: "s1", seq: 1, ts: 0, type: "sentence.ready", channel: "them", utteranceId: "them-1", sentenceIdx: 0, text: "Last words." });
    expect(seen).toEqual(["session.started", "sentence.ready"]);

    socket.receive({ v: 1, type: "session.ended", sessionId: "s1", reason: "stopped" });
    socket.serverClose(4410);
    expect(t.store.snapshot()).toMatchObject({ status: "idle", errorMessage: null });
    expect(socket.closed).toBe(true);
  });

  it("stop desiste de esperar o servidor depois do prazo de segurança", async () => {
    const t = setup();
    const socket = await startRunning(t);
    t.controller.stop();
    vi.advanceTimersByTime(STOP_TIMEOUT_MS);
    expect(t.store.snapshot().status).toBe("idle");
    expect(socket.closed).toBe(true);
    socket.serverClose(1006);
    expect(t.store.snapshot()).toMatchObject({ status: "idle", errorMessage: null });
  });

  it("stop antes de a sessão começar libera tudo na hora", async () => {
    const t = setup();
    await t.controller.start(params);
    const socket = t.sockets[0]!;
    socket.open();
    t.controller.stop();
    expect(socket.closed).toBe(true);
    expect(t.tab.stopped && t.mic.stopped).toBe(true);
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("ignora o fim da captura da aba enquanto finaliza", async () => {
    const t = setup();
    await startRunning(t);
    t.controller.stop();
    t.emitEnded("them");
    expect(t.store.snapshot()).toMatchObject({ status: "stopping", errorMessage: null });
  });

  it("repassa as mensagens do servidor ao gancho, depois de aplicá-las ao store", async () => {
    const t = setup();
    const seen: Array<{ type: string; status: string }> = [];
    const controller = new SessionController({ ...t.deps, onServerMessage: (m) => seen.push({ type: m.type, status: t.store.snapshot().status }) });
    await controller.start(params);
    t.sockets[0]!.open();
    t.sockets[0]!.receive(started);
    expect(seen).toEqual([{ type: "session.started", status: "running" }]);
  });

  it("stop durante a captura da aba descarta a captura atrasada", async () => {
    let resolveTab!: (capture: ChannelCapture) => void;
    const t = setup({ tab: () => new Promise((resolve) => (resolveTab = resolve)) });
    const pending = t.controller.start(params);
    t.controller.stop();
    const late = fakeCapture();
    resolveTab(late);
    await pending;
    expect(late.stopped).toBe(true);
    expect(t.sockets).toHaveLength(0);
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("encerra a sessão quando a captura da aba termina", async () => {
    const t = setup();
    const socket = await startRunning(t);
    t.emitEnded("them");
    expect(socket.json.at(-1)).toEqual({ type: "session.stop" });
    expect(socket.closed).toBe(true);
    expect(t.tab.stopped && t.mic.stopped).toBe(true);
    expect(t.store.snapshot()).toMatchObject({
      status: "error",
      errorMessage: "A captura da aba terminou (aba fechada ou compartilhamento encerrado).",
    });
  });

  it("segue só com a aba quando o microfone deixa de funcionar", async () => {
    const t = setup();
    const socket = await startRunning(t);
    t.emitEnded("me");
    expect(t.mic.stopped).toBe(true);
    expect(t.tab.stopped).toBe(false);
    expect(socket.closed).toBe(false);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "denied" });
  });

  it("publica estatísticas de frames periodicamente", async () => {
    const t = setup();
    await startRunning(t);
    t.emitFrame("them");
    t.emitFrame("me");
    vi.advanceTimersByTime(STATS_INTERVAL_MS);
    expect(t.store.snapshot().channels.them.sentFrames).toBe(1);
    expect(t.store.snapshot().channels.me.sentFrames).toBe(1);
  });
  it("pede sugestão ao servidor com um requestId novo", async () => {
    const t = setup();
    const controller = new SessionController({ ...t.deps, newRequestId: () => "req-1" });
    await controller.start(params);
    t.sockets[0]!.open();
    t.sockets[0]!.receive(started);
    controller.requestSuggestion();
    expect(t.sockets[0]!.json.at(-1)).toEqual({ type: "suggest.request", requestId: "req-1" });
  });

  it("pede sugestão para a pergunta escolhida", async () => {
    const t = setup();
    const controller = new SessionController({ ...t.deps, newRequestId: () => "req-2" });
    await controller.start(params);
    t.sockets[0]!.open();
    t.sockets[0]!.receive(started);
    controller.requestSuggestion({ utteranceId: "them-3", text: "Why us?" });
    expect(t.sockets[0]!.json.at(-1)).toEqual({ type: "suggest.request", requestId: "req-2", question: { utteranceId: "them-3", text: "Why us?" } });
  });

  it("não pede sugestão sem sessão iniciada", async () => {
    const t = setup();
    await t.controller.start(params);
    t.sockets[0]!.open();
    t.controller.requestSuggestion();
    expect(t.sockets[0]!.json.map((m) => m.type)).toEqual(["session.start"]);
  });

  it("envia mudanças de contexto durante a sessão", async () => {
    const t = setup();
    const socket = await startRunning(t);
    t.controller.update({ job: "Staff Engineer" });
    expect(socket.json.at(-1)).toEqual({ type: "session.update", job: "Staff Engineer" });
  });
});

describe("microfone desligado", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("não envia o áudio do microfone enquanto desligado e volta a enviar ao religar", async () => {
    const t = setup();
    const socket = await startRunning(t);
    t.controller.setMicMuted(true);
    expect(t.store.snapshot().micMuted).toBe(true);
    t.emitFrame("me");
    t.emitFrame("them");
    expect(socket.binary.map((frame) => decodeFrame(new Uint8Array(frame)))).toMatchObject([{ ok: true, frame: { channel: "them" } }]);
    t.controller.setMicMuted(false);
    t.emitFrame("me");
    expect(socket.binary).toHaveLength(2);
    expect(t.store.snapshot().micMuted).toBe(false);
  });

  it("zera o nível do microfone e ignora o nível enquanto desligado", async () => {
    const t = setup();
    await startRunning(t);
    t.store.dispatch({ type: "level", channel: "me", rms: 0.4 });
    t.controller.setMicMuted(true);
    expect(t.store.snapshot().channels.me.level).toBe(0);
  });

  it("sem sessão, não faz nada; nova sessão começa com o microfone ligado", async () => {
    const t = setup();
    t.controller.setMicMuted(true);
    expect(t.store.snapshot().micMuted).toBe(false);
    const socket = await startRunning(t);
    t.controller.setMicMuted(true);
    socket.serverClose(4410);
    await t.controller.start(params);
    t.sockets[1]!.open();
    t.sockets[1]!.receive(started);
    expect(t.store.snapshot().micMuted).toBe(false);
  });
});

