export class LatencyStats {
  private readonly samples: number[] = [];

  add(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.samples.push(ms);
  }

  summary(): { count: number; p50: number | null; p95: number | null } {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (p: number): number | null =>
      sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null);
    return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
  }
}

export function formatLatency(label: string, stats: LatencyStats): string {
  const { count, p50, p95 } = stats.summary();
  if (count === 0 || p50 === null || p95 === null) return `${label}: sem amostras`;
  return `${label} p50 ${Math.round(p50)} ms · p95 ${Math.round(p95)} ms (n=${count})`;
}
