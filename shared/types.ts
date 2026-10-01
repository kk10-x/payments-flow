export type Circuit = "closed" | "open" | "half-open";
export type FailureKind = "declined" | "error" | "timeout";
export type Status = "captured" | "failed" | "unknown";

export interface ProviderTuning {
  /** Probability a call fails before anything is charged (declined or 5xx). */
  failureRate: number;
  /** Probability the provider charges but its response arrives after the caller's timeout. */
  lostResponseRate: number;
  latencyMs: number;
}

export interface ProviderInfo {
  id: number;
  name: string;
  score: number;
  /** Rolling success rate, 0 to 1. */
  successRate: number;
  circuit: Circuit;
  charges: number;
  tuning: ProviderTuning;
}

export interface Config {
  rps: number;
  /** Share of synthetic requests that reuse a recent idempotency key (a client retrying). */
  duplicateRate: number;
}

export interface Stats {
  payments: number;
  captured: number;
  failed: number;
  unknown: number;
  replays: number;
  /** Idempotency keys that were charged by more than one provider. Should always be 0. */
  doubleCharges: number;
}

export type PayEvent =
  | { type: "state"; providers: ProviderInfo[]; config: Config; stats: Stats }
  | { type: "tick"; providers: ProviderInfo[]; stats: Stats }
  | { type: "config"; config: Config }
  | { type: "routed"; id: number; provider: number; attempt: number }
  | { type: "attemptFailed"; id: number; provider: number; kind: FailureKind }
  | { type: "settled"; id: number; provider: number; ms: number }
  | { type: "replayed"; id: number }
  | { type: "failed"; id: number }
  | { type: "unknown"; id: number };
