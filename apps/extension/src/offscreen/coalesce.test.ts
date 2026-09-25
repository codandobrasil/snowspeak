import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescer } from "./coalesce";

describe("createCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("agrupa vários pedidos num único envio após o intervalo", () => {
    const flush = vi.fn();
    const schedule = createCoalescer(flush, 50);
    schedule();
    schedule();
    schedule();
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("um pedido depois do envio agenda um novo", () => {
    const flush = vi.fn();
    const schedule = createCoalescer(flush, 50);
    schedule();
    vi.advanceTimersByTime(50);
    schedule();
    vi.advanceTimersByTime(50);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
