import { describe, expect, it } from "vitest";
import type { ServerEventBody } from "@snowspeak/shared";
import { ChannelPipeline } from "./channel-pipeline";
import { LatencyStats } from "./latency";
import { createScriptedSttHub } from "./test-support/scripted-stt";

const frame = (frameSeq: number) => ({ channel: "them" as const, frameSeq, sampleOffset: frameSeq * 1600, pcm: new Uint8Array(3200) });

function setup() {
  const hub = createScriptedSttHub();
  const events: ServerEventBody[] = [];
  const pipeline = new ChannelPipeline({
    channel: "them",
    sttFactory: hub.factory,
    splitSentences: false,
    emit: (body) => events.push(body),
    sttLatency: new LatencyStats(),
    now: Date.now,
  });
  return { hub, events, pipeline };
}

describe("ChannelPipeline", () => {
  it("suspend pede Finalize, fecha a fala aberta como interrompida e fecha o STT", async () => {
    const { hub, events, pipeline } = setup();
    pipeline.acceptFrame(frame(0));
    const them = hub.channel("them");
    them.emit({ kind: "partial", text: "hel" });
    await pipeline.suspend();
    expect(them.finalizes).toBe(1);
    expect(them.closed).toBe(true);
    expect(events.at(-1)).toEqual({ type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: true });
  });

  it("reopenStt abre um STT novo e as falas continuam numeradas", async () => {
    const { hub, events, pipeline } = setup();
    hub.channel("them").emit({ kind: "segment", text: "Hi.", start: 5, end: 6, speechFinal: true, fromFinalize: false });
    await pipeline.suspend();
    const old = hub.channel("them");
    pipeline.reopenStt();
    const fresh = hub.channel("them");
    expect(fresh).not.toBe(old);
    expect(fresh.closed).toBe(false);
    pipeline.acceptFrame(frame(3));
    expect(fresh.writes).toBe(1);
    fresh.emit({ kind: "segment", text: "Again", start: 0.1, end: 0.5, speechFinal: false, fromFinalize: false });
    fresh.emit({ kind: "utteranceEnd", lastWordEnd: 0.5 });
    expect(events.slice(-2)).toEqual([
      { type: "transcript.segment", channel: "them", utteranceId: "them-2", segmentIdx: 0, text: "Again" },
      { type: "utterance.end", channel: "them", utteranceId: "them-2", interrupted: false },
    ]);
  });

  it("frames aceitos com o STT suspenso não vão a lugar nenhum, e reopenStt depois de close não abre nada", async () => {
    const { hub, pipeline } = setup();
    await pipeline.suspend();
    const suspended = hub.channel("them");
    expect(pipeline.acceptFrame(frame(0))).toBe(true);
    expect(suspended.writes).toBe(0);
    pipeline.close();
    pipeline.reopenStt();
    expect(hub.channel("them")).toBe(suspended);
  });

  it("ignora resultados atrasados do STT antigo depois da suspensão e da retomada", async () => {
    const { hub, events, pipeline } = setup();
    await pipeline.suspend();
    const old = hub.channel("them");
    pipeline.reopenStt();
    const fresh = hub.channel("them");
    const before = events.length;
    // O Deepgram ainda entrega o que tinha no stream fechado, com tempos da linha do tempo antiga.
    old.emit({ kind: "segment", text: "Late words.", start: 44, end: 45, speechFinal: true, fromFinalize: false });
    expect(events.length).toBe(before);
    // A fala nova fecha pelo UtteranceEnd do stream novo, com tempos baixos.
    fresh.emit({ kind: "segment", text: "New", start: 0.1, end: 0.5, speechFinal: false, fromFinalize: false });
    fresh.emit({ kind: "utteranceEnd", lastWordEnd: 0.5 });
    expect(events.at(-1)).toMatchObject({ type: "utterance.end", interrupted: false });
  });
});

