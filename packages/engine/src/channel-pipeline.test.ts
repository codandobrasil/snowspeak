import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEventBody } from "@snowspeak/shared";
import { ChannelPipeline, STT_RECONNECT_DELAYS_MS } from "./channel-pipeline";
import { LatencyStats } from "./latency";
import { createScriptedSttHub } from "./test-support/scripted-stt";

const frame = (frameSeq: number) => ({ channel: "them" as const, frameSeq, sampleOffset: frameSeq * 1600, pcm: new Uint8Array(3200) });

function setup(options: { retryBeforeFirstOpen?: boolean } = {}) {
  const hub = createScriptedSttHub();
  const events: ServerEventBody[] = [];
  const pipeline = new ChannelPipeline({
    channel: "them",
    sttFactory: hub.factory,
    splitSentences: false,
    emit: (body) => events.push(body),
    sttLatency: new LatencyStats(),
    now: () => Date.now(),
    retryBeforeFirstOpen: options.retryBeforeFirstOpen ?? false,
  });
  return { hub, events, pipeline };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChannelPipeline", () => {
  it("drain pede Finalize e fecha a fala aberta como interrompida", async () => {
    const { hub, events, pipeline } = setup();
    const them = hub.channel("them");
    them.open();
    pipeline.acceptFrame(frame(0));
    them.emit({ kind: "partial", text: "hel" });
    await pipeline.drain();
    expect(them.finalizes).toBe(1);
    expect(events.at(-1)).toEqual({ type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: true });
  });

  it("firstOpen resolve na primeira abertura", async () => {
    const { hub, pipeline } = setup();
    hub.channel("them").open();
    await expect(pipeline.firstOpen).resolves.toBeUndefined();
  });

  it("falha antes da primeira abertura sem retryBeforeFirstOpen: rejeita firstOpen e não tenta de novo", async () => {
    vi.useFakeTimers();
    const { hub, events, pipeline } = setup({ retryBeforeFirstOpen: false });
    hub.channel("them").fail();
    await expect(pipeline.firstOpen).rejects.toThrow("falha roteirizada");
    vi.advanceTimersByTime(60_000);
    expect(hub.streamsCreated("them")).toBe(1);
    expect(events).toEqual([]);
  });

  it("com retryBeforeFirstOpen, a falha inicial entra em reconexão", () => {
    vi.useFakeTimers();
    const { hub, events } = setup({ retryBeforeFirstOpen: true });
    hub.channel("them").fail();
    expect(events).toEqual([{ type: "stt.status", channel: "them", state: "reconnecting" }]);
    vi.advanceTimersByTime(STT_RECONNECT_DELAYS_MS[0]!);
    expect(hub.streamsCreated("them")).toBe(2);
  });

  it("queda com o stream aberto: fecha a fala, avisa, reabre com espera crescente e volta a transcrever", () => {
    vi.useFakeTimers();
    const { hub, events, pipeline } = setup();
    const first = hub.channel("them");
    first.open();
    first.emit({ kind: "partial", text: "and then" });
    first.fail();
    expect(events.slice(-2)).toEqual([
      { type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: true },
      { type: "stt.status", channel: "them", state: "reconnecting" },
    ]);
    // 100 ms de áudio chegam durante a queda e se perdem.
    pipeline.acceptFrame(frame(0));
    vi.advanceTimersByTime(499);
    expect(hub.streamsCreated("them")).toBe(1);
    vi.advanceTimersByTime(1);
    expect(hub.streamsCreated("them")).toBe(2);
    // A segunda tentativa também falha: a próxima vem 1 s depois.
    hub.channel("them").fail();
    vi.advanceTimersByTime(1_000);
    expect(hub.streamsCreated("them")).toBe(3);
    const fresh = hub.channel("them");
    fresh.open();
    expect(events.slice(-2)).toEqual([
      { type: "audio.gap", channel: "them", durationMs: 100, reason: "stt_unavailable" },
      { type: "stt.status", channel: "them", state: "ok" },
    ]);
    pipeline.acceptFrame(frame(1));
    expect(fresh.writes).toBe(1);
    fresh.emit({ kind: "segment", text: "Again", start: 0.1, end: 0.5, speechFinal: false, fromFinalize: false });
    fresh.emit({ kind: "utteranceEnd", lastWordEnd: 0.5 });
    expect(events.slice(-2)).toEqual([
      { type: "transcript.segment", channel: "them", utteranceId: "them-2", segmentIdx: 0, text: "Again" },
      { type: "utterance.end", channel: "them", utteranceId: "them-2", interrupted: false },
    ]);
  });

  it("cada queda gera um aviso e cada volta um ok", () => {
    vi.useFakeTimers();
    const { hub, events } = setup();
    hub.channel("them").open();
    for (let i = 0; i < 2; i++) {
      hub.channel("them").fail();
      vi.advanceTimersByTime(STT_RECONNECT_DELAYS_MS[0]!);
      hub.channel("them").open();
    }
    expect(events.filter((e) => e.type === "stt.status")).toEqual([
      { type: "stt.status", channel: "them", state: "reconnecting" },
      { type: "stt.status", channel: "them", state: "ok" },
      { type: "stt.status", channel: "them", state: "reconnecting" },
      { type: "stt.status", channel: "them", state: "ok" },
    ]);
  });

  it("desiste 60 s depois da queda e avisa que a transcrição parou", () => {
    vi.useFakeTimers();
    const { hub, events } = setup();
    hub.channel("them").open();
    hub.channel("them").fail();
    // 0,5 + 1 + 2 + 4 + 8 + 10 × 4 = 55,5 s; a próxima espera passaria de 60 s.
    for (const wait of [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000]) {
      vi.advanceTimersByTime(wait);
      hub.channel("them").fail();
    }
    expect(events.at(-1)).toEqual({
      type: "error",
      scope: "stt",
      code: "stt_connection_lost",
      retryable: false,
      channel: "them",
      message: "A transcrição dos participantes parou: não foi possível reconectar ao Deepgram.",
    });
    vi.advanceTimersByTime(60_000);
    expect(hub.streamsCreated("them")).toBe(10);
  });

  it("close cancela a reconexão pendente", () => {
    vi.useFakeTimers();
    const { hub, pipeline } = setup();
    hub.channel("them").open();
    hub.channel("them").fail();
    pipeline.close();
    vi.advanceTimersByTime(60_000);
    expect(hub.streamsCreated("them")).toBe(1);
  });

  it("ignora resultados atrasados do stream que caiu", () => {
    vi.useFakeTimers();
    const { hub, events } = setup();
    const old = hub.channel("them");
    old.open();
    old.fail();
    vi.advanceTimersByTime(STT_RECONNECT_DELAYS_MS[0]!);
    hub.channel("them").open();
    const before = events.length;
    old.emit({ kind: "segment", text: "Late words.", start: 44, end: 45, speechFinal: true, fromFinalize: false });
    expect(events.length).toBe(before);
  });

  it("conta frames enviados ao STT e descartados durante a queda", () => {
    vi.useFakeTimers();
    const { hub, pipeline } = setup();
    hub.channel("them").open();
    pipeline.acceptFrame(frame(0));
    hub.channel("them").fail();
    pipeline.acceptFrame(frame(1));
    expect(pipeline.stats()).toEqual({ sentFrames: 1, droppedFrames: 1 });
  });
});
