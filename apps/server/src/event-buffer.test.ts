import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@snowspeak/shared";
import { EventBuffer } from "./event-buffer";

const segment = (seq: number): ServerEvent => ({
  v: 1,
  sessionId: "s1",
  seq,
  ts: 0,
  type: "transcript.segment",
  channel: "them",
  utteranceId: "them-1",
  segmentIdx: seq,
  text: `t${seq}`,
});
const partial = (seq: number): ServerEvent => ({
  v: 1,
  sessionId: "s1",
  seq,
  ts: 0,
  type: "transcript.partial",
  channel: "them",
  utteranceId: "them-1",
  text: "…",
});

describe("EventBuffer", () => {
  it("devolve os eventos depois de lastSeq, em ordem, sem parciais", () => {
    const buffer = new EventBuffer();
    [segment(1), partial(2), segment(3), partial(4), segment(5)].forEach((e) => buffer.add(e));
    expect(buffer.since(1).map((e) => e.seq)).toEqual([3, 5]);
    expect(buffer.since(5)).toEqual([]);
  });

  it("guarda só os últimos eventos e sabe se ainda dá para repor", () => {
    const buffer = new EventBuffer(2);
    [segment(1), segment(2), segment(3)].forEach((e) => buffer.add(e));
    expect(buffer.since(0).map((e) => e.seq)).toEqual([2, 3]);
    expect(buffer.canReplayFrom(0)).toBe(false); // o 1 saiu do buffer
    expect(buffer.canReplayFrom(1)).toBe(true);
    expect(buffer.canReplayFrom(3)).toBe(true);
  });

  it("parciais não ocupam espaço nem tornam a reposição impossível", () => {
    const buffer = new EventBuffer(2);
    [segment(1), partial(2), partial(3), partial(4), segment(5)].forEach((e) => buffer.add(e));
    expect(buffer.canReplayFrom(0)).toBe(true);
    expect(buffer.since(0).map((e) => e.seq)).toEqual([1, 5]);
  });
});
