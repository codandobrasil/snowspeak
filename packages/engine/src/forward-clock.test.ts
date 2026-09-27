import { describe, expect, it } from "vitest";
import { ForwardClock } from "./forward-clock";

describe("ForwardClock", () => {
  it("informa quando cada trecho de áudio foi encaminhado ao STT", () => {
    const clock = new ForwardClock();
    clock.record(1600, 1_000);
    clock.record(1600, 1_100);
    clock.record(1600, 1_250);
    expect(clock.forwardedAt(1)).toBe(1_000);
    expect(clock.forwardedAt(1600)).toBe(1_000);
    expect(clock.forwardedAt(1601)).toBe(1_100);
    expect(clock.forwardedAt(4800)).toBe(1_250);
  });

  it("não inventa horário para áudio ainda não encaminhado", () => {
    const clock = new ForwardClock();
    clock.record(1600, 1_000);
    expect(clock.forwardedAt(1601)).toBeNull();
  });

  it("esquece marcas antigas além da capacidade", () => {
    const clock = new ForwardClock(2);
    clock.record(1600, 1_000);
    clock.record(1600, 1_100);
    clock.record(1600, 1_200);
    expect(clock.forwardedAt(100)).toBeNull();
    expect(clock.forwardedAt(2000)).toBe(1_100);
  });
});
