import { describe, expect, it } from "vitest";
import { LatencyStats, formatLatency } from "./latency";

describe("LatencyStats", () => {
  it("calcula p50 e p95", () => {
    const stats = new LatencyStats();
    for (let ms = 1; ms <= 100; ms++) stats.add(ms);
    expect(stats.summary()).toEqual({ count: 100, p50: 50, p95: 95 });
  });

  it("ignora valores negativos ou inválidos", () => {
    const stats = new LatencyStats();
    stats.add(-5);
    stats.add(Number.NaN);
    stats.add(120);
    expect(stats.summary()).toEqual({ count: 1, p50: 120, p95: 120 });
  });

  it("formata com e sem amostras", () => {
    const stats = new LatencyStats();
    expect(formatLatency("STT", stats)).toBe("STT: sem amostras");
    stats.add(180.4);
    expect(formatLatency("STT", stats)).toBe("STT p50 180 ms · p95 180 ms (n=1)");
  });
});
