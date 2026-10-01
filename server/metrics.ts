const WINDOW_S = 60;
const MAX_LATENCIES = 200;

interface Bucket {
  ok: number;
  fail: number;
  routed: number;
}

export interface MetricsSnapshot {
  p50: number | null;
  p95: number | null;
  inflight: number;
  routed: number;
  spark: (number | null)[];
}

/** Rolling per-provider numbers for the last minute: success per second, latency percentiles, in-flight. */
export class ProviderMetrics {
  inflight = 0;
  private buckets = new Map<number, Bucket>();
  private latencies: number[] = [];

  constructor(private now: () => number = () => Date.now()) {}

  private bucket(): Bucket {
    const s = Math.floor(this.now() / 1000);
    let b = this.buckets.get(s);
    if (!b) {
      b = { ok: 0, fail: 0, routed: 0 };
      this.buckets.set(s, b);
      for (const k of this.buckets.keys()) if (k < s - WINDOW_S) this.buckets.delete(k);
    }
    return b;
  }

  routed() {
    this.bucket().routed++;
    this.inflight++;
  }

  done(ok: boolean, ms: number) {
    this.inflight = Math.max(0, this.inflight - 1);
    const b = this.bucket();
    if (ok) {
      b.ok++;
      this.latencies.push(ms);
      if (this.latencies.length > MAX_LATENCIES) this.latencies.shift();
    } else b.fail++;
  }

  snapshot(): MetricsSnapshot {
    const nowS = Math.floor(this.now() / 1000);
    const spark: (number | null)[] = [];
    let routed = 0;
    for (let i = WINDOW_S - 1; i >= 0; i--) {
      const b = this.buckets.get(nowS - i);
      if (b) routed += b.routed;
      spark.push(b && b.ok + b.fail > 0 ? b.ok / (b.ok + b.fail) : null);
    }
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pick = (q: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!) : null);
    return { p50: pick(0.5), p95: pick(0.95), inflight: this.inflight, routed, spark };
  }
}
