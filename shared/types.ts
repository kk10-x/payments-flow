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
  /** Latency of recent successful calls, in ms (null until there are samples). */
  p50: number | null;
  p95: number | null;
  /** Calls currently waiting on this provider. */
  inflight: number;
  /** Share of all routed attempts that went to this provider over the last minute, 0 to 1. */
  share: number;
  /** Success ratio per second for the last 60 s, oldest first; null where there was no traffic. */
  spark: (number | null)[];
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
  /** Sum of captured amounts, in paise (INR minor units). */
  capturedAmount: number;
  failed: number;
  unknown: number;
  replays: number;
  /** Idempotency keys that were charged by more than one provider. Should always be 0. */
  doubleCharges: number;
}

export interface Attempt {
  n: number;
  provider: number;
  ok: boolean;
  kind?: FailureKind;
  ms: number;
  /** Plain-language explanation of what the gateway concluded and did next. */
  note: string;
}

export interface PaymentRecord {
  id: number;
  key: string;
  /** Paise (INR minor units). */
  amount: number;
  status: Status | "pending";
  provider?: number;
  attempts: Attempt[];
  /** How many later requests reused this idempotency key and were answered from the first result. */
  replays: number;
  createdAt: number;
  /** Final explanation of the outcome. */
  summary: string;
}

export type PayEvent =
  | { type: "state"; providers: ProviderInfo[]; config: Config; stats: Stats }
  | { type: "tick"; providers: ProviderInfo[]; stats: Stats }
  | { type: "config"; config: Config }
  | { type: "routed"; id: number; provider: number; attempt: number }
  | { type: "attemptFailed"; id: number; provider: number; kind: FailureKind }
  | { type: "settled"; id: number; provider: number; ms: number; amount: number }
  /** `id` is the id of the original payment that this repeat key resolved to. */
  | { type: "replayed"; id: number }
  | { type: "failed"; id: number }
  | { type: "unknown"; id: number };
