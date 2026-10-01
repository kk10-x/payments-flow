import type {
  Attempt,
  Config,
  FailureKind,
  PayEvent,
  PaymentRecord,
  ProviderInfo,
  Stats,
  Status,
} from "../shared/types.ts";
import { ProviderMetrics } from "./metrics.ts";
import { MockProvider, ProviderError } from "./provider.ts";
import { HealthRouter } from "./router.ts";

export interface Outcome {
  id: number;
  key: string;
  status: Status;
  provider?: number;
  attempts: number;
}

const MAX_ATTEMPTS = 4;
const MAX_KEYS = 6000; // bounded memory for the demo; oldest keys are forgotten first
const MAX_RECORDS = 400;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProviderError("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * The payment pipeline: idempotency, health-scored routing, and retries.
 *
 * The retry rule that matters: a definite failure (declined, 5xx) means nothing was charged, so
 * the next attempt may go to a different provider. A timeout is an UNKNOWN outcome: the provider
 * may already have charged. After a timeout we only retry the same provider with the same
 * idempotency key (it dedupes), and never fail over, because failing over could charge twice.
 */
export class PaymentService {
  readonly router: HealthRouter;
  readonly config: Config = { rps: 0, duplicateRate: 0.1 };
  private byKey = new Map<string, Promise<Outcome>>();
  private idByKey = new Map<string, number>();
  private records = new Map<number, PaymentRecord>();
  private metrics = new Map<number, ProviderMetrics>();
  private stats = { payments: 0, captured: 0, capturedAmount: 0, failed: 0, unknown: 0, replays: 0 };
  private nextId = 1;
  private recentKeys: string[] = [];
  private providerById: Map<number, MockProvider>;

  constructor(
    readonly providers: MockProvider[],
    private emit: (e: PayEvent) => void,
    private timeoutMs = 600,
    rand: () => number = Math.random,
  ) {
    this.router = new HealthRouter(providers.map((p) => p.id), rand);
    this.providerById = new Map(providers.map((p) => [p.id, p]));
    for (const p of providers) this.metrics.set(p.id, new ProviderMetrics());
  }

  pay(key: string, amount: number): Promise<Outcome> {
    const existing = this.byKey.get(key);
    if (existing) {
      this.stats.replays++;
      const id = this.idByKey.get(key);
      if (id !== undefined) {
        const rec = this.records.get(id);
        if (rec) rec.replays++;
        this.emit({ type: "replayed", id });
      }
      return existing; // same key: share the original result (in flight or finished)
    }
    const run = this.run(key, amount);
    this.byKey.set(key, run);
    if (this.byKey.size > MAX_KEYS) {
      const oldest = this.byKey.keys().next().value!;
      this.byKey.delete(oldest);
      this.idByKey.delete(oldest);
    }
    return run;
  }

  private async run(key: string, amount: number): Promise<Outcome> {
    const id = this.nextId++;
    this.idByKey.set(key, id);
    this.stats.payments++;
    const record: PaymentRecord = {
      id,
      key,
      amount,
      status: "pending",
      attempts: [],
      replays: 0,
      createdAt: Date.now(),
      summary: "In progress.",
    };
    this.records.set(id, record);
    if (this.records.size > MAX_RECORDS) this.records.delete(this.records.keys().next().value!);

    const failedOver = new Set<number>();
    let locked: MockProvider | undefined; // set after a timeout: the outcome is unknown
    let attempts = 0;

    for (let a = 0; a < MAX_ATTEMPTS; a++) {
      const provider = locked ?? this.providerById.get(this.router.pick(failedOver) ?? -1);
      if (!provider) break;
      attempts++;
      const m = this.metrics.get(provider.id)!;
      m.routed();
      this.emit({ type: "routed", id, provider: provider.id, attempt: a });
      const started = performance.now();
      try {
        await withTimeout(provider.charge(key, amount), this.timeoutMs);
        const ms = Math.round(performance.now() - started);
        m.done(true, ms);
        this.router.health.get(provider.id)!.record(true, ms);
        this.stats.captured++;
        this.stats.capturedAmount += amount;
        const note = locked
          ? "Same key: the provider returned the charge it had already made. No second charge."
          : failedOver.size > 0
            ? "Charged here after the earlier provider declined (nothing was charged there)."
            : "Charged.";
        record.attempts.push({ n: attempts, provider: provider.id, ok: true, ms, note });
        record.status = "captured";
        record.provider = provider.id;
        record.summary = `Captured by ${provider.name} after ${attempts} attempt${attempts === 1 ? "" : "s"}.`;
        this.emit({ type: "settled", id, provider: provider.id, ms, amount });
        return { id, key, status: "captured", provider: provider.id, attempts };
      } catch (e) {
        const kind: FailureKind = e instanceof ProviderError ? e.kind : "error";
        const ms = Math.round(performance.now() - started);
        m.done(false, ms);
        this.router.health.get(provider.id)!.record(false, ms);
        const attempt: Attempt = {
          n: attempts,
          provider: provider.id,
          ok: false,
          kind,
          ms,
          note: noteFor(kind, !!locked),
        };
        record.attempts.push(attempt);
        this.emit({ type: "attemptFailed", id, provider: provider.id, kind });
        if (kind === "timeout" || locked) locked = provider;
        else failedOver.add(provider.id);
      }
    }

    if (locked) {
      this.stats.unknown++;
      record.status = "unknown";
      record.provider = locked.id;
      record.summary = `Unknown. ${locked.name} may have charged, and retries could not confirm it. Needs reconciliation.`;
      this.emit({ type: "unknown", id });
      return { id, key, status: "unknown", provider: locked.id, attempts };
    }
    this.stats.failed++;
    record.status = "failed";
    record.summary = "Failed. Every available provider failed before charging, so nothing was charged.";
    this.emit({ type: "failed", id });
    return { id, key, status: "failed", attempts };
  }

  getRecord(id: number): PaymentRecord | undefined {
    return this.records.get(id);
  }

  recentRecords(limit = 20): PaymentRecord[] {
    return [...this.records.values()].slice(-limit).reverse();
  }

  /** Keys that more than one provider has charged. The invariant under test: this is 0. */
  doubleCharges(): number {
    const seen = new Map<string, number>();
    for (const p of this.providers) for (const k of p.charges.keys()) seen.set(k, (seen.get(k) ?? 0) + 1);
    let n = 0;
    for (const c of seen.values()) if (c > 1) n++;
    return n;
  }

  chargesFor(key: string): number {
    return this.providers.filter((p) => p.charges.has(key)).length;
  }

  snapshotStats(): Stats {
    return { ...this.stats, doubleCharges: this.doubleCharges() };
  }

  snapshotProviders(): ProviderInfo[] {
    const snaps = new Map(this.providers.map((p) => [p.id, this.metrics.get(p.id)!.snapshot()]));
    const totalRouted = [...snaps.values()].reduce((s, x) => s + x.routed, 0);
    return this.providers.map((p) => {
      const h = this.router.health.get(p.id)!;
      h.refresh();
      const m = snaps.get(p.id)!;
      return {
        id: p.id,
        name: p.name,
        score: Math.round(h.score * 1000) / 1000,
        successRate: Math.round(h.ewmaOk * 1000) / 1000,
        p50: m.p50,
        p95: m.p95,
        inflight: m.inflight,
        share: totalRouted > 0 ? Math.round((m.routed / totalRouted) * 1000) / 1000 : 0,
        spark: m.spark,
        circuit: h.state,
        charges: p.charges.size,
        tuning: { ...p.tuning },
      };
    });
  }

  /** Synthetic client traffic: some requests reuse a recent key, like a client retrying. */
  syntheticPayment(): Promise<Outcome> {
    let key: string;
    if (this.recentKeys.length > 5 && Math.random() < this.config.duplicateRate) {
      key = this.recentKeys[Math.floor(Math.random() * this.recentKeys.length)]!;
    } else {
      key = `pay_${Math.random().toString(36).slice(2, 10)}`;
      this.recentKeys.push(key);
      if (this.recentKeys.length > 40) this.recentKeys.shift();
    }
    // Amounts in paise: mostly small (₹100 to ₹2,000) with an occasional large one (up to ₹50,000).
    const big = Math.random() < 0.1;
    const amount = big ? 200_000 + Math.floor(Math.random() * 4_800_000) : 10_000 + Math.floor(Math.random() * 190_000);
    return this.pay(key, Math.round(amount / 100) * 100);
  }
}

function noteFor(kind: FailureKind, alreadyLocked: boolean): string {
  switch (kind) {
    case "declined":
      return "Declined. Nothing was charged, so it is safe to fail over to another provider.";
    case "error":
      return alreadyLocked
        ? "Provider error while confirming an earlier timeout. Outcome still unknown; retrying the same provider."
        : "Provider error. Nothing was charged, so it is safe to fail over to another provider.";
    case "timeout":
      return "No reply in time. The provider may have charged, so the gateway retries this provider with the same key and does not fail over.";
  }
}
