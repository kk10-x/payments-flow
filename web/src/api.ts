import type { Config, PayEvent, PaymentRecord, ProviderInfo, ProviderTuning, Stats } from "../../shared/types.ts";
import { MockProvider } from "../../server/provider.ts";
import { PaymentService } from "../../server/service.ts";

export type Mode = "connecting" | "live" | "simulated";

export interface View {
  mode: Mode;
  providers: ProviderInfo[];
  stats: Stats;
  config: Config;
}

export interface ReplayResult {
  requests: number;
  charges: number;
  status: string;
}

type Listener = (e: PayEvent) => void;

const NAMES = ["Atlas", "Beacon", "Crest"];
const DEFAULTS: ProviderTuning[] = [
  { failureRate: 0.02, lostResponseRate: 0, latencyMs: 60 },
  { failureRate: 0.02, lostResponseRate: 0, latencyMs: 90 },
  { failureRate: 0.02, lostResponseRate: 0, latencyMs: 120 },
];

/**
 * Talks to the payments server when one is reachable. Otherwise it runs the very same
 * PaymentService and MockProvider classes inside the browser, and the UI labels itself SIMULATED
 * so nobody mistakes it for a server.
 */
export class Api {
  view: View = {
    mode: "connecting",
    providers: NAMES.map((name, i) => ({
      id: i + 1,
      name,
      score: 1,
      successRate: 1,
      p50: null,
      p95: null,
      inflight: 0,
      share: 0,
      spark: [],
      circuit: "closed",
      charges: 0,
      tuning: { ...DEFAULTS[i]! },
    })),
    stats: { payments: 0, captured: 0, capturedAmount: 0, failed: 0, unknown: 0, replays: 0, doubleCharges: 0 },
    config: { rps: 0, duplicateRate: 0.1 },
  };
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private local: { service: PaymentService; providers: MockProvider[] } | null = null;

  on(fn: Listener) {
    this.listeners.add(fn);
  }

  private dispatch(e: PayEvent) {
    if (e.type === "state") {
      this.view.providers = e.providers;
      this.view.config = e.config;
      this.view.stats = e.stats;
    } else if (e.type === "tick") {
      this.view.providers = e.providers;
      this.view.stats = e.stats;
    } else if (e.type === "config") {
      this.view.config = e.config;
    }
    for (const fn of this.listeners) fn(e);
  }

  connect(): Promise<Mode> {
    return new Promise((resolve) => {
      // Relative to the page URL so the app also works under a path prefix (e.g. /payments-flow/).
      const wsUrl = new URL("events", document.baseURI);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      let settled = false;
      const fallback = () => {
        if (settled) return;
        settled = true;
        this.ws?.close();
        this.startLocal();
        this.view.mode = "simulated";
        resolve("simulated");
      };
      const timer = setTimeout(fallback, 1500);
      try {
        const ws = new WebSocket(wsUrl);
        this.ws = ws;
        ws.onmessage = (m) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.view.mode = "live";
            resolve("live");
          }
          this.dispatch(JSON.parse(String(m.data)) as PayEvent);
        };
        ws.onerror = fallback;
        ws.onclose = () => {
          if (!settled) fallback();
          else this.view.mode = "connecting";
        };
      } catch {
        fallback();
      }
    });
  }

  private startLocal() {
    const providers = NAMES.map((n, i) => new MockProvider(i + 1, n, { ...DEFAULTS[i]! }));
    const service = new PaymentService(providers, (e) => this.dispatch(e));
    this.local = { service, providers };
    const snap = (): PayEvent => ({
      type: "tick",
      providers: service.snapshotProviders(),
      stats: service.snapshotStats(),
    });
    this.dispatch({ ...(snap() as { providers: ProviderInfo[]; stats: Stats }), type: "state", config: service.config });
    let carry = 0;
    setInterval(() => {
      carry += (service.config.rps * 50) / 1000;
      while (carry >= 1) {
        carry -= 1;
        void service.syntheticPayment();
      }
    }, 50);
    setInterval(() => this.dispatch(snap()), 400);
  }

  private post(path: string, body?: unknown) {
    return fetch(new URL(path, document.baseURI), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).catch(() => undefined);
  }

  setConfig(patch: Partial<Config>) {
    if (this.local) {
      Object.assign(this.local.service.config, patch);
      this.dispatch({ type: "config", config: this.local.service.config });
    } else void this.post("api/config", patch);
  }

  setProvider(id: number, patch: Partial<ProviderTuning>) {
    if (this.local) Object.assign(this.local.providers[id - 1]!.tuning, patch);
    else void this.post(`api/providers/${id}`, patch);
  }

  /** Send one payment (amount in paise). Same key twice returns the first result. */
  async pay(key: string, amount: number): Promise<{ id: number; status: string } | null> {
    if (this.local) {
      const o = await this.local.service.pay(key, amount);
      return { id: o.id, status: o.status };
    }
    const res = await fetch(new URL("api/payments", document.baseURI), {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ amount }),
    }).catch(() => undefined);
    return res && res.ok ? ((await res.json()) as { id: number; status: string }) : null;
  }

  async getPayment(id: number): Promise<PaymentRecord | null> {
    if (this.local) return this.local.service.getRecord(id) ?? null;
    const res = await fetch(new URL(`api/payments/${id}`, document.baseURI)).catch(() => undefined);
    return res && res.ok ? ((await res.json()) as PaymentRecord) : null;
  }

  async replay(n: number): Promise<ReplayResult | null> {
    if (this.local) {
      const { service } = this.local;
      const key = `replay_${Date.now().toString(36)}`;
      const outcomes = await Promise.all(Array.from({ length: n }, () => service.pay(key, 4999)));
      return { requests: n, charges: service.chargesFor(key), status: outcomes[0]!.status };
    }
    const res = await this.post("api/replay", { n });
    return res ? ((await res.json()) as ReplayResult) : null;
  }
}
