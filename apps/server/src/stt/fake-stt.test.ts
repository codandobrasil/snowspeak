import { describe, expect, it } from "vitest";
import { sinePcm } from "../test-support/sine";
import { createFakeSttFactory } from "./fake-stt";
import type { SttResult } from "./types";

describe("FakeStt", () => {
  it("emite um relatório a cada segundo de áudio recebido", () => {
    const results: SttResult[] = [];
    const stt = createFakeSttFactory()("them", (r) => results.push(r));
    for (let i = 0; i < 9; i++) stt.write(new Uint8Array(3200));
    expect(results).toHaveLength(0);
    stt.write(new Uint8Array(3200));
    expect(results).toEqual([{ kind: "partial", text: "[fake-stt them] 1.0 s · silêncio" }]);
    for (let i = 0; i < 10; i++) stt.write(sinePcm({ frequencyHz: 440, amplitude: 0.5, startSample: i * 1600, samples: 1600 }));
    expect(results.at(-1)).toEqual({ kind: "partial", text: "[fake-stt them] 2.0 s · -9 dBFS · ~440 Hz" });
  });

  it("não emite nada depois de fechado", () => {
    const results: SttResult[] = [];
    const stt = createFakeSttFactory({ reportEveryMs: 100 })("me", (r) => results.push(r));
    stt.close();
    stt.write(new Uint8Array(3200));
    expect(results).toHaveLength(0);
  });
});
