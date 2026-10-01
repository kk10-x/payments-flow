import type { Circuit } from "../shared/types.ts";

const ALPHA = 0.25; // EWMA smoothing: higher reacts faster, lower is steadier
const TRIP_AFTER = 4; // consecutive failures before the breaker opens
const COOLDOWN_MS = 3000; // how long an open breaker rejects traffic before one probe is allowed

/** Rolling health for one provider, plus a circuit breaker. */
export class Health {
  ewmaOk = 1;
  ewmaMs = 100;
  consecutiveFailures = 0;
  state: Circuit = "closed";
  private openedAt = 0;
  probing = false;

  constructor(private now: () => number = () => Date.now()) {}

  record(ok: boolean, ms: number) {
    this.ewmaOk += ALPHA * ((ok ? 1 : 0) - this.ewmaOk);
    this.ewmaMs += ALPHA * (ms - this.ewmaMs);
    this.probing = false;
    if (ok) {
      this.consecutiveFailures = 0;
      this.state = "closed";
      return;
    }
    this.consecutiveFailures++;
    if (this.state === "half-open" || this.consecutiveFailures >= TRIP_AFTER) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  /** Move open -> half-open once the cooldown has passed. */
  refresh() {
    if (this.state === "open" && this.now() - this.openedAt >= COOLDOWN_MS) {
      this.state = "half-open";
      this.probing = false;
    }
  }

  /** Higher is better: success rate dominates, latency breaks ties. */
  get score() {
    return (this.ewmaOk * this.ewmaOk) / (1 + this.ewmaMs / 300);
  }
}

/**
 * Picks a provider with probability proportional to score^3 (with a small floor so a degraded provider is still sampled), so traffic shifts smoothly toward
 * healthy providers instead of flipping all at once. Open breakers get nothing; a half-open
 * breaker lets exactly one probe request through.
 */
export class HealthRouter {
  readonly health = new Map<number, Health>();

  constructor(
    ids: number[],
    private rand: () => number = Math.random,
    now: () => number = () => Date.now(),
  ) {
    for (const id of ids) this.health.set(id, new Health(now));
  }

  pick(exclude: ReadonlySet<number> = new Set()): number | undefined {
    const candidates: { id: number; weight: number }[] = [];
    for (const [id, h] of this.health) {
      if (exclude.has(id)) continue;
      h.refresh();
      if (h.state === "open") continue;
      if (h.state === "half-open") {
        if (!h.probing) candidates.push({ id, weight: 0.05 });
        continue;
      }
      // Floor keeps a degraded provider sampled, so its health stays fresh and it can recover.
      candidates.push({ id, weight: Math.max(h.score ** 3, 0.03) });
    }
    if (candidates.length === 0) return undefined;
    const total = candidates.reduce((s, c) => s + c.weight, 0);
    let r = this.rand() * total;
    let chosen = candidates[candidates.length - 1]!;
    for (const c of candidates) {
      r -= c.weight;
      if (r <= 0) {
        chosen = c;
        break;
      }
    }
    const h = this.health.get(chosen.id)!;
    if (h.state === "half-open") h.probing = true;
    return chosen.id;
  }
}
