import { CLOSE_CODES, type Channel, type ClientMessage, type Mode, type ServerMessage } from "@snowspeak/shared";
import { FrameSender, type FrameSink } from "./frame-sender";
import type { SessionStore } from "./session-store";

export const STATS_INTERVAL_MS = 500;
export const SESSION_START_TIMEOUT_MS = 5_000;
// O offscreen não exibe pedido de permissão; se o getUserMedia do microfone ficar pendente, segue sem ele.
export const MIC_CAPTURE_TIMEOUT_MS = 3_000;
// Parar espera o servidor entregar as últimas falas; depois disso fecha mesmo assim.
export const STOP_TIMEOUT_MS = 3_000;

export interface StartParams {
  streamId: string;
  serverUrl: string;
  token: string;
  mode: Mode;
  context: string;
}

export interface ChannelCapture {
  stop(): void;
}

export interface CaptureCallbacks {
  onFrame(channel: Channel, pcm: ArrayBuffer): void;
  onLevel(channel: Channel, rms: number): void;
  /** A trilha terminou por fora (aba fechada, compartilhamento encerrado, microfone desconectado). */
  onEnded(channel: Channel): void;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  onClose(code: number, reason: string): void;
}

export interface ControllerSocket extends FrameSink {
  sendJson(message: ClientMessage): void;
  close(): void;
}

export interface ControllerDeps {
  store: SessionStore;
  captureTab(streamId: string, cb: CaptureCallbacks): Promise<ChannelCapture>;
  captureMic(cb: CaptureCallbacks): Promise<ChannelCapture>;
  /** Pode lançar de forma síncrona (ex.: URL inválida). */
  openSocket(url: string, handlers: SocketHandlers): ControllerSocket;
  /** Recebe cada mensagem do servidor depois que ela foi aplicada ao store (ex.: fila de tradução). */
  onServerMessage?: (message: ServerMessage) => void;
}

interface Run {
  tab: ChannelCapture | null;
  mic: ChannelCapture | null;
  socket: ControllerSocket | null;
  sender: FrameSender | null;
  wasOpen: boolean;
  statsTimer: ReturnType<typeof setInterval> | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

/** Rejeita após `ms`; uma captura que chegue depois do prazo é parada imediatamente. */
function captureWithTimeout(capture: Promise<ChannelCapture>, ms: number): Promise<ChannelCapture> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("tempo esgotado"));
    }, ms);
    capture.then(
      (result) => {
        if (settled) {
          result.stop();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeClose(code: number, wasOpen: boolean): string {
  if (!wasOpen) return "Não foi possível conectar ao servidor.";
  if (code === CLOSE_CODES.unauthorized) return "Chave de acesso inválida.";
  return `Conexão com o servidor encerrada (código ${code}).`;
}

export class SessionController {
  private running: Run | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  async start(params: StartParams): Promise<void> {
    if (this.running) return;
    const run: Run = { tab: null, mic: null, socket: null, sender: null, wasOpen: false, statsTimer: null, startTimer: null, stopping: false, stopTimer: null };
    this.running = run;
    this.deps.store.dispatch({ type: "starting" });

    const callbacks: CaptureCallbacks = {
      onFrame: (channel, pcm) => run.sender?.push(channel, pcm),
      onLevel: (channel, rms) => {
        if (this.running === run) this.deps.store.dispatch({ type: "level", channel, rms });
      },
      onEnded: (channel) => this.onCaptureEnded(run, channel),
    };

    let tab: ChannelCapture;
    try {
      tab = await this.deps.captureTab(params.streamId, callbacks);
    } catch (error) {
      if (this.running === run) this.fail(run, `Não foi possível capturar o áudio da aba: ${errorText(error)}`);
      return;
    }
    if (this.running !== run) {
      tab.stop();
      return;
    }
    run.tab = tab;

    let mic: ChannelCapture | null = null;
    try {
      mic = await captureWithTimeout(this.deps.captureMic(callbacks), MIC_CAPTURE_TIMEOUT_MS);
    } catch {
      mic = null;
    }
    if (this.running !== run) {
      mic?.stop();
      return;
    }
    run.mic = mic;
    this.deps.store.dispatch({ type: "mic", status: mic ? "active" : "denied" });

    let socket: ControllerSocket;
    try {
      socket = this.deps.openSocket(params.serverUrl, {
        onOpen: () => {
          run.wasOpen = true;
          socket.sendJson({ type: "session.start", token: params.token, mode: params.mode, context: params.context });
        },
        onMessage: (message) => this.onServerMessage(run, message),
        onClose: (code) => this.onSocketClose(run, code),
      });
    } catch {
      this.fail(run, "Endereço do servidor inválido.");
      return;
    }
    run.socket = socket;
    run.startTimer = setTimeout(() => {
      if (this.running === run) this.fail(run, "O servidor não respondeu a tempo.");
    }, SESSION_START_TIMEOUT_MS);
    run.statsTimer = setInterval(() => {
      if (run.sender) this.deps.store.dispatch({ type: "stats", stats: run.sender.stats() });
    }, STATS_INTERVAL_MS);
  }

  stop(): void {
    const run = this.running;
    if (!run || run.stopping) return;
    if (!run.sender || !run.socket?.isOpen) {
      // A sessão ainda não começou: não há o que finalizar no servidor.
      run.socket?.sendJson({ type: "session.stop" });
      this.release(run);
      this.deps.store.dispatch({ type: "stopped" });
      return;
    }
    // Para de capturar, mas continua recebendo as últimas falas até o servidor encerrar.
    run.stopping = true;
    this.releaseCaptures(run);
    run.socket.sendJson({ type: "session.stop" });
    this.deps.store.dispatch({ type: "stopping" });
    run.stopTimer = setTimeout(() => {
      if (this.running !== run) return;
      this.release(run);
      this.deps.store.dispatch({ type: "stopped" });
    }, STOP_TIMEOUT_MS);
  }

  private onServerMessage(run: Run, message: ServerMessage): void {
    if (this.running !== run) return;
    if (message.type === "session.started" && run.socket) {
      if (run.startTimer) clearTimeout(run.startTimer);
      run.startTimer = null;
      // Frames só depois de session.started: antes disso o servidor fecharia com 4400.
      run.sender = new FrameSender(run.socket);
    }
    this.deps.store.dispatch({ type: "server", message });
    this.deps.onServerMessage?.(message);
  }

  private onSocketClose(run: Run, code: number): void {
    if (this.running !== run) return;
    this.release(run);
    if (run.stopping || code === CLOSE_CODES.sessionEnded) this.deps.store.dispatch({ type: "stopped" });
    else this.deps.store.dispatch({ type: "failed", message: describeClose(code, run.wasOpen) });
  }

  private onCaptureEnded(run: Run, channel: Channel): void {
    if (this.running !== run || run.stopping) return;
    if (channel === "them") {
      run.socket?.sendJson({ type: "session.stop" });
      this.fail(run, "A captura da aba terminou (aba fechada ou compartilhamento encerrado).");
      return;
    }
    run.mic?.stop();
    run.mic = null;
    this.deps.store.dispatch({ type: "mic", status: "denied" });
  }

  private fail(run: Run, message: string): void {
    this.release(run);
    this.deps.store.dispatch({ type: "failed", message });
  }

  private releaseCaptures(run: Run): void {
    if (run.statsTimer) clearInterval(run.statsTimer);
    run.statsTimer = null;
    run.tab?.stop();
    run.tab = null;
    run.mic?.stop();
    run.mic = null;
    run.sender = null;
  }

  private release(run: Run): void {
    if (this.running === run) this.running = null;
    if (run.startTimer) clearTimeout(run.startTimer);
    run.startTimer = null;
    if (run.stopTimer) clearTimeout(run.stopTimer);
    run.stopTimer = null;
    this.releaseCaptures(run);
    run.socket?.close();
    run.socket = null;
  }
}
