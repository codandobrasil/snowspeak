import { CLOSE_CODES, type Channel, type ClientMessage, type Mode, type ServerMessage, type SessionEndReason } from "@snowspeak/shared";
import { FrameSender, type FrameSink } from "./frame-sender";
import type { SessionStore } from "./session-store";

export const STATS_INTERVAL_MS = 500;
export const SESSION_START_TIMEOUT_MS = 5_000;
// O offscreen não exibe pedido de permissão; se o getUserMedia do microfone ficar pendente, segue sem ele.
export const MIC_CAPTURE_TIMEOUT_MS = 3_000;
// Parar espera o servidor entregar as últimas falas; depois disso fecha mesmo assim.
export const STOP_TIMEOUT_MS = 3_000;
// Reconexão depois de uma queda: espera crescente, até 60 s contados da queda.
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
export const RESUME_WINDOW_MS = 60_000;
// O servidor manda heartbeat a cada 5 s; sem nenhuma mensagem por 15 s, a conexão está morta.
export const SERVER_SILENCE_TIMEOUT_MS = 15_000;

export const SESSION_EXPIRED_MESSAGE = "A conexão ficou fora por muito tempo e a sessão foi encerrada.";
export const SESSION_SUPERSEDED_MESSAGE = "Sessão aberta em outro lugar.";
export const SESSION_REPLACED_MESSAGE = "Sessão encerrada: foi iniciada em outro lugar.";

export interface StartParams {
  streamId: string;
  serverUrl: string;
  token: string;
  mode: Mode;
  context: string;
  profile: string;
  job: string;
}

/** Campos que podem mudar durante a sessão (valem para as próximas sugestões). */
/** Pergunta que o usuário escolheu no painel. */
export interface SuggestionQuestion {
  utteranceId: string;
  text: string;
}

export type SessionSettingsChanges = Partial<Pick<StartParams, "mode" | "context" | "profile" | "job">>;

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
  /** Gera o requestId de cada pedido de sugestão (padrão: crypto.randomUUID). */
  newRequestId?: () => string;
}

interface Reconnect {
  since: number;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Run {
  params: StartParams;
  tab: ChannelCapture | null;
  mic: ChannelCapture | null;
  socket: ControllerSocket | null;
  sender: FrameSender | null;
  wasOpen: boolean;
  /** Sessão iniciada ou retomada neste socket: frames e pedidos podem ir ao servidor. */
  live: boolean;
  sessionId: string | null;
  resumeToken: string | null;
  endedReason: SessionEndReason | null;
  reconnect: Reconnect | null;
  statsTimer: ReturnType<typeof setInterval> | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** Microfone desligado pelo usuário: nada do canal "me" é enviado. */
  micMuted: boolean;
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

function isApplicationClose(code: number): boolean {
  return code >= 4400 && code <= 4499;
}

export class SessionController {
  private running: Run | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  async start(params: StartParams): Promise<void> {
    if (this.running) return;
    const run: Run = {
      params,
      tab: null,
      mic: null,
      socket: null,
      sender: null,
      wasOpen: false,
      live: false,
      sessionId: null,
      resumeToken: null,
      endedReason: null,
      reconnect: null,
      statsTimer: null,
      startTimer: null,
      silenceTimer: null,
      stopping: false,
      stopTimer: null,
      micMuted: false,
    };
    this.running = run;
    this.deps.store.dispatch({ type: "starting" });

    const callbacks: CaptureCallbacks = {
      onFrame: (channel, pcm) => {
        if (channel === "me" && run.micMuted) return;
        run.sender?.push(channel, pcm);
      },
      onLevel: (channel, rms) => {
        if (channel === "me" && run.micMuted) return;
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

    const startMessage: ClientMessage = {
      type: "session.start",
      token: params.token,
      mode: params.mode,
      context: params.context,
      profile: params.profile,
      job: params.job,
    };
    if (!this.connect(run, () => startMessage)) {
      this.fail(run, "Endereço do servidor inválido.");
      return;
    }
    run.statsTimer = setInterval(() => {
      if (run.sender) this.deps.store.dispatch({ type: "stats", stats: run.sender.stats() });
    }, STATS_INTERVAL_MS);
  }

  /** Pede uma sugestão de resposta (para a pergunta escolhida, se houver); sem sessão iniciada, não faz nada. */
  requestSuggestion(question?: SuggestionQuestion): void {
    const run = this.running;
    if (!run?.live || run.stopping || !run.socket?.isOpen) return;
    const requestId = (this.deps.newRequestId ?? (() => crypto.randomUUID()))();
    run.socket.sendJson(question ? { type: "suggest.request", requestId, question } : { type: "suggest.request", requestId });
  }

  /** Liga ou desliga o envio do microfone; o microfone continua aberto para religar na hora. */
  setMicMuted(muted: boolean): void {
    const run = this.running;
    if (!run || run.stopping) return;
    run.micMuted = muted;
    this.deps.store.dispatch({ type: "mic-muted", muted });
  }

  /** Mudanças de modo, contexto, currículo ou vaga durante a sessão. */
  update(changes: SessionSettingsChanges): void {
    const run = this.running;
    if (!run?.live || run.stopping || !run.socket?.isOpen) return;
    run.socket.sendJson({ type: "session.update", ...changes });
  }

  stop(): void {
    const run = this.running;
    if (!run || run.stopping) return;
    if (!run.live || !run.socket?.isOpen) {
      // Sessão ainda não começou ou está reconectando: não há o que finalizar agora.
      if (!run.reconnect) run.socket?.sendJson({ type: "session.stop" });
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

  /** Abre um socket para esta execução; `first` é a primeira mensagem (início ou retomada). */
  private connect(run: Run, first: () => ClientMessage): boolean {
    let socket: ControllerSocket;
    try {
      socket = this.deps.openSocket(run.params.serverUrl, {
        onOpen: () => {
          if (run.socket !== socket) return;
          run.wasOpen = true;
          socket.sendJson(first());
        },
        onMessage: (message) => {
          if (run.socket === socket) this.onServerMessage(run, message);
        },
        onClose: (code) => {
          if (run.socket === socket) this.onSocketClose(run, code);
        },
      });
    } catch {
      return false;
    }
    run.socket = socket;
    run.startTimer = setTimeout(() => {
      if (this.running !== run || run.socket !== socket) return;
      if (run.reconnect) this.onConnectionLost(run);
      else this.fail(run, "O servidor não respondeu a tempo.");
    }, SESSION_START_TIMEOUT_MS);
    return true;
  }

  private onServerMessage(run: Run, message: ServerMessage): void {
    if (this.running !== run) return;
    if (message.type === "session.started" || message.type === "session.resumed") {
      if (run.startTimer) clearTimeout(run.startTimer);
      run.startTimer = null;
      if (message.type === "session.started") {
        run.sessionId = message.sessionId;
        run.resumeToken = message.resumeToken;
      }
      if (run.reconnect?.timer) clearTimeout(run.reconnect.timer);
      run.reconnect = null;
      run.live = true;
      // Frames só com a sessão viva; os contadores sobrevivem às reconexões.
      run.sender ??= new FrameSender({
        get bufferedAmount() {
          return run.socket?.bufferedAmount ?? 0;
        },
        get isOpen() {
          return run.live && (run.socket?.isOpen ?? false);
        },
        send: (data) => run.socket?.send(data),
      });
    }
    if (message.type === "session.ended") run.endedReason = message.reason;
    if (run.live) this.watchSilence(run);
    this.deps.store.dispatch({ type: "server", message });
    this.deps.onServerMessage?.(message);
  }

  private watchSilence(run: Run): void {
    if (run.silenceTimer) clearTimeout(run.silenceTimer);
    run.silenceTimer = setTimeout(() => {
      if (this.running === run && run.live && !run.stopping) this.onConnectionLost(run);
    }, SERVER_SILENCE_TIMEOUT_MS);
  }

  private onSocketClose(run: Run, code: number): void {
    if (this.running !== run) return;
    if (run.stopping || (code === CLOSE_CODES.sessionEnded && run.endedReason !== "replaced")) {
      this.release(run);
      this.deps.store.dispatch({ type: "stopped" });
      return;
    }
    if (code === CLOSE_CODES.sessionEnded) return this.fail(run, SESSION_REPLACED_MESSAGE);
    if (code === CLOSE_CODES.superseded) return this.fail(run, SESSION_SUPERSEDED_MESSAGE);
    if (run.sessionId && (code === CLOSE_CODES.sessionNotFound || code === CLOSE_CODES.protocolError)) {
      return this.fail(run, SESSION_EXPIRED_MESSAGE);
    }
    // Sem sessão iniciada (ainda não há o que retomar) ou recusa do servidor: encerra como hoje.
    if (!run.sessionId || isApplicationClose(code)) return this.fail(run, describeClose(code, run.wasOpen));
    this.onConnectionLost(run);
  }

  /** Queda (ou conexão morta): a captura continua e o controlador tenta retomar a sessão. */
  private onConnectionLost(run: Run): void {
    run.live = false;
    if (run.silenceTimer) clearTimeout(run.silenceTimer);
    run.silenceTimer = null;
    if (run.startTimer) clearTimeout(run.startTimer);
    run.startTimer = null;
    const socket = run.socket;
    run.socket = null;
    socket?.close();
    if (!run.reconnect) {
      run.reconnect = { since: Date.now(), attempt: 0, timer: null };
      this.deps.store.dispatch({ type: "reconnecting" });
    }
    this.scheduleReconnect(run, run.reconnect);
  }

  private scheduleReconnect(run: Run, reconnect: Reconnect): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnect.attempt, RECONNECT_DELAYS_MS.length - 1)] ?? RECONNECT_DELAYS_MS[0]!;
    if (Date.now() + delay - reconnect.since > RESUME_WINDOW_MS) {
      this.fail(run, SESSION_EXPIRED_MESSAGE);
      return;
    }
    reconnect.attempt += 1;
    reconnect.timer = setTimeout(() => {
      reconnect.timer = null;
      if (this.running !== run || run.reconnect !== reconnect || !run.sessionId || !run.resumeToken) return;
      const { sessionId, resumeToken } = run;
      const connected = this.connect(run, () => ({
        type: "session.resume",
        token: run.params.token,
        sessionId,
        resumeToken,
        // Lido na hora do envio: eventos aplicados até ali não são pedidos de novo.
        lastSeq: this.deps.store.snapshot().lastSeq,
      }));
      if (!connected) this.fail(run, "Endereço do servidor inválido.");
    }, delay);
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
    if (run.silenceTimer) clearTimeout(run.silenceTimer);
    run.silenceTimer = null;
    if (run.reconnect?.timer) clearTimeout(run.reconnect.timer);
    run.reconnect = null;
    run.live = false;
    this.releaseCaptures(run);
    run.socket?.close();
    run.socket = null;
  }
}
