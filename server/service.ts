import type { Config, FailureKind, PayEvent, ProviderInfo, Stats, Status } from "../shared/types.ts";
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
  private stats = { payments: 0, captured: 0, failed: 0, unknown: 0, replays: 0 };
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
  }

  pay(key: string, amount: number): Promise<Outcome> {
    const existing = this.byKey.get(key);
    if (existing) {
      this.stats.replays++;
      this.emit({ type: "replayed", id: this.nextId++ });
      return existing; // same key: share the original result (in flight or finished)
    }
    const run = this.run(key, amount);
    this.byKey.set(key, run);
    if (this.byKey.size > MAX_KEYS) this.byKey.delete(this.byKey.keys().next().value!);
    return run;
  }

  private async run(key: string, amount: number): Promise<Outcome> {
    const id = this.nextId++;
    this.stats.payments++;
    const failedOver = new Set<number>();
    let locked: MockProvider | undefined; // set after a timeout: the outcome is unknown
    let attempts = 0;

    for (let a = 0; a < MAX_ATTEMPTS; a++) {
      const provider = locked ?? this.providerById.get(this.router.pick(failedOver) ?? -1);
      if (!provider) break;
      attempts++;
      this.emit({ type: "routed", id, provider: provider.id, attempt: a });
      const started = performance.now();
      try {
        await withTimeout(provider.charge(key, amount), this.timeoutMs);
        const ms = Math.round(performance.now() - started);
        this.router.health.get(provider.id)!.record(true, ms);
        this.stats.captured++;
        this.emit({ type: "settled", id, provider: provider.id, ms });
        return { id, key, status: "captured", provider: provider.id, attempts };
      } catch (e) {
        const kind: FailureKind = e instanceof ProviderError ? e.kind : "error";
        this.router.health.get(provider.id)!.record(false, performance.now() - started);
        this.emit({ type: "attemptFailed", id, provider: provider.id, kind });
        if (kind === "timeout" || locked) locked = provider;
        else failedOver.add(provider.id);
      }
    }

    if (locked) {
      this.stats.unknown++;
      this.emit({ type: "unknown", id });
      return { id, key, status: "unknown", provider: locked.id, attempts };
    }
    this.stats.failed++;
    this.emit({ type: "failed", id });
    return { id, key, status: "failed", attempts };
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
    return this.providers.map((p) => {
      const h = this.router.health.get(p.id)!;
      h.refresh();
      return {
        id: p.id,
        name: p.name,
        score: Math.round(h.score * 1000) / 1000,
        successRate: Math.round(h.ewmaOk * 1000) / 1000,
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
    return this.pay(key, 100 + Math.floor(Math.random() * 49900));
  }
}
