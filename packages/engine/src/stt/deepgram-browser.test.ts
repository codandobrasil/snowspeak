import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeepgramSttFactory, type BrowserSocket, type DeepgramOptions } from "./deepgram-browser";
import type { SttResult } from "./types";

class FakeSocket implements BrowserSocket {
  static created: FakeSocket[] = [];
  binaryType: BinaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: unknown[] = [];
  /** Código passado a close(); "none" quando chamado sem código. */
  closeCode: number | "none" | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.created.push(this);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(typeof data === "string" ? data : Array.from(data as Uint8Array));
  }
  close(code?: number): void {
    this.closeCode = code ?? "none";
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  receive(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

function collect() {
  const state = { results: [] as SttResult[], errors: [] as Error[], opens: 0 };
  const callbacks = {
    onOpen: () => {
      state.opens += 1;
    },
    onResult: (result: SttResult) => {
      state.results.push(result);
    },
    onError: (error: Error) => {
      state.errors.push(error);
    },
  };
  return { state, callbacks };
}

const factory = (overrides: Partial<DeepgramOptions> = {}) => createDeepgramSttFactory({ apiKey: "dg-key", socketImpl: FakeSocket, ...overrides });
const last = (): FakeSocket => {
  const socket = FakeSocket.created.at(-1);
  if (!socket) throw new Error("nenhum socket criado");
  return socket;
};

afterEach(() => {
  FakeSocket.created = [];
  vi.useRealTimers();
});

describe("Deepgram no navegador", () => {
  it("conecta com a chave no subprotocolo e os parâmetros de cada canal, sem a chave na URL", () => {
    const f = factory();
    f("them", collect().callbacks);
    f("me", collect().callbacks);
    const [them, me] = FakeSocket.created;
    expect(them!.protocols).toEqual(["token", "dg-key"]);
    expect(them!.binaryType).toBe("arraybuffer");
    expect(them!.url).not.toContain("dg-key");
    const url = new URL(them!.url);
    expect(`${url.origin}${url.pathname}`).toBe("wss://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
    });
    expect(new URL(me!.url).searchParams.get("language")).toBe("multi");
  });

  it("guarda o áudio até a conexão abrir, envia na ordem e avisa a abertura", () => {
    const c = collect();
    const stream = factory()("them", c.callbacks);
    stream.write(new Uint8Array([1, 2]));
    expect(last().sent).toEqual([]);
    last().open();
    stream.write(new Uint8Array([3, 4]));
    expect(last().sent).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(c.state.opens).toBe(1);
  });

  it("guarda no máximo 10 frames enquanto abre e conta os descartados", () => {
    const stream = factory()("them", collect().callbacks);
    for (let i = 0; i < 12; i++) stream.write(new Uint8Array([i, i]));
    last().open();
    expect(last().sent).toHaveLength(10);
    expect(last().sent[0]).toEqual([2, 2]);
    expect(stream.droppedFrames).toBe(2);
  });

  it("entrega os resultados interpretados", () => {
    const c = collect();
    factory()("them", c.callbacks);
    last().open();
    last().receive(JSON.stringify({ type: "Results", is_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: "hello" }] } }));
    expect(c.state.results).toEqual([{ kind: "partial", text: "hello" }]);
  });

  it("envia Finalize e, ao fechar, CloseStream e fechamento normal, sem reportar erro", () => {
    const c = collect();
    const stream = factory()("them", c.callbacks);
    const socket = last();
    socket.open();
    stream.finalize();
    stream.close();
    expect(socket.sent).toEqual(['{"type":"Finalize"}', '{"type":"CloseStream"}']);
    expect(socket.closeCode).toBe(1000);
    socket.drop(1000);
    expect(c.state.errors).toEqual([]);
  });

  it("fechar antes de abrir não envia nada nem reporta erro", () => {
    const c = collect();
    const stream = factory()("them", c.callbacks);
    stream.write(new Uint8Array([1, 2]));
    stream.close();
    expect(last().closeCode).toBe("none");
    last().drop(1006);
    expect(last().sent).toEqual([]);
    expect(c.state.errors).toEqual([]);
  });

  it("avisa uma única vez quando a conexão cai", () => {
    const c = collect();
    factory()("them", c.callbacks);
    last().open();
    last().drop(1006);
    last().drop(1006);
    expect(c.state.errors.map((e) => e.message)).toEqual(["Deepgram encerrou a conexão (código 1006)"]);
  });

  it("avisa quando a conexão é recusada antes de abrir (chave errada ou rede fora)", () => {
    const c = collect();
    factory()("them", c.callbacks);
    last().drop(1006);
    expect(c.state.errors).toHaveLength(1);
    expect(c.state.opens).toBe(0);
  });

  it("desiste quando a conexão não abre no prazo", () => {
    vi.useFakeTimers();
    const c = collect();
    factory({ openTimeoutMs: 100 })("them", c.callbacks);
    vi.advanceTimersByTime(100);
    expect(c.state.errors[0]?.message).toContain("prazo");
    expect(last().closeCode).toBe("none");
  });

  it("descarta e conta o áudio quando a conexão congestiona", () => {
    const stream = factory({ maxBufferedBytes: 1_000 })("them", collect().callbacks);
    last().open();
    last().bufferedAmount = 1_001;
    stream.write(new Uint8Array(3_200));
    expect(stream.droppedFrames).toBe(1);
    expect(last().sent).toEqual([]);
  });

  it("mantém a conexão viva com KeepAlive quando o canal fica sem áudio", () => {
    vi.useFakeTimers();
    factory({ keepAliveMs: 50 })("me", collect().callbacks);
    last().open();
    vi.advanceTimersByTime(50);
    expect(last().sent).toContain('{"type":"KeepAlive"}');
  });

  it("não envia KeepAlive enquanto o áudio flui", () => {
    vi.useFakeTimers();
    const stream = factory({ keepAliveMs: 80 })("them", collect().callbacks);
    last().open();
    for (let i = 0; i < 10; i++) {
      stream.write(new Uint8Array(4));
      vi.advanceTimersByTime(20);
    }
    expect(last().sent).not.toContain('{"type":"KeepAlive"}');
  });
});
