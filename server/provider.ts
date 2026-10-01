import type { FailureKind, ProviderTuning } from "../shared/types.ts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A definite failure: the provider did NOT charge, so failing over to another provider is safe. */
export class ProviderError extends Error {
  constructor(public kind: FailureKind) {
    super(kind);
  }
}

export interface Charge {
  chargeId: string;
  amount: number;
}

/**
 * A mock payment provider. It is idempotent on the key it is given (a repeat call returns the
 * original charge and never creates a second one), and it can be tuned to fail or to lose
 * responses so the gateway's retry rules have something real to handle.
 */
export class MockProvider {
  readonly charges = new Map<string, Charge>();
  private seq = 0;

  constructor(
    public readonly id: number,
    public readonly name: string,
    public tuning: ProviderTuning,
    /** How long to hold a response that the caller is guaranteed to have given up on. */
    private lostResponseDelayMs = 1500,
  ) {}

  async charge(key: string, amount: number): Promise<Charge> {
    const t = this.tuning;
    await sleep(t.latencyMs * (0.6 + Math.random() * 0.8));

    const existing = this.charges.get(key);
    if (existing) return existing; // idempotent replay: no new charge

    if (Math.random() < t.failureRate) {
      throw new ProviderError(Math.random() < 0.5 ? "declined" : "error");
    }

    const charge: Charge = { chargeId: `ch_${this.id}_${++this.seq}`, amount };
    this.charges.set(key, charge); // the money has moved from here on
    if (Math.random() < t.lostResponseRate) await sleep(this.lostResponseDelayMs);
    return charge;
  }
}
