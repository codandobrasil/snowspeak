import { describe, expect, it } from "vitest";
import { AttemptTracker } from "./attempt-tracker";

describe("AttemptTracker", () => {
  it("identifica a tentativa de início em andamento", () => {
    const tracker = new AttemptTracker();
    const id = tracker.begin();
    expect(id).not.toBeNull();
    expect(tracker.isCurrent(id!)).toBe(true);
  });

  it("recusa um segundo início enquanto o primeiro está pendente", () => {
    const tracker = new AttemptTracker();
    tracker.begin();
    expect(tracker.begin()).toBeNull();
  });

  it("cancel invalida a tentativa pendente em qualquer etapa", () => {
    const tracker = new AttemptTracker();
    const id = tracker.begin()!;
    tracker.cancel();
    expect(tracker.isCurrent(id)).toBe(false);
  });

  it("uma tentativa antiga não finaliza nem se confunde com a nova", () => {
    const tracker = new AttemptTracker();
    const old = tracker.begin()!;
    tracker.cancel();
    const fresh = tracker.begin()!;
    tracker.finish(old);
    expect(tracker.isCurrent(fresh)).toBe(true);
    expect(tracker.isCurrent(old)).toBe(false);
  });

  it("finish libera novos inícios", () => {
    const tracker = new AttemptTracker();
    const id = tracker.begin()!;
    tracker.finish(id);
    expect(tracker.isCurrent(id)).toBe(false);
    expect(tracker.begin()).not.toBeNull();
  });
});
