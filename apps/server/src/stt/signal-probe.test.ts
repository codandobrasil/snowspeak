import { describe, expect, it } from "vitest";
import { sinePcm } from "../test-support/sine";
import { SignalProbe, describeSignal } from "./signal-probe";

describe("SignalProbe", () => {
  it("mede nível e frequência de um seno de 440 Hz com amplitude 0,5", () => {
    const probe = new SignalProbe();
    probe.add(sinePcm({ frequencyHz: 440, amplitude: 0.5, startSample: 0, samples: 16_000 }));
    const report = probe.takeReport();
    expect(report.dbfs).toBeCloseTo(-9.03, 1);
    expect(report.frequencyHz).toBeGreaterThan(438);
    expect(report.frequencyHz).toBeLessThan(442);
  });

  it("reconhece outra frequência e a mesma amplitude em blocos separados", () => {
    const probe = new SignalProbe();
    for (let block = 0; block < 10; block++) {
      probe.add(sinePcm({ frequencyHz: 1000, amplitude: 0.5, startSample: block * 1600, samples: 1600 }));
    }
    const report = probe.takeReport();
    expect(report.frequencyHz).toBeGreaterThan(995);
    expect(report.frequencyHz).toBeLessThan(1005);
  });

  it("informa silêncio sem frequência", () => {
    const probe = new SignalProbe();
    probe.add(new Uint8Array(3200));
    expect(probe.takeReport()).toEqual({ dbfs: null, frequencyHz: null });
  });

  it("cada relatório cobre só o áudio desde o anterior", () => {
    const probe = new SignalProbe();
    probe.add(sinePcm({ frequencyHz: 440, amplitude: 0.5, startSample: 0, samples: 16_000 }));
    probe.takeReport();
    probe.add(new Uint8Array(3200));
    expect(probe.takeReport().dbfs).toBeNull();
  });
});

describe("describeSignal", () => {
  it("formata duração, nível e frequência", () => {
    expect(describeSignal("them", 2, { dbfs: -9.03, frequencyHz: 440.4 })).toBe("[fake-stt them] 2.0 s · -9 dBFS · ~440 Hz");
    expect(describeSignal("me", 1, { dbfs: null, frequencyHz: null })).toBe("[fake-stt me] 1.0 s · silêncio");
  });
});
