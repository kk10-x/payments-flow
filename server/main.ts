import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { PayEvent, ProviderTuning } from "../shared/types.ts";
import { MockProvider } from "./provider.ts";
import { PaymentService } from "./service.ts";

const WEB_DIST = fileURLToPath(new URL("../web/dist", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

export const DEFAULT_TUNING: ProviderTuning[] = [
  { failureRate: 0.02, lostResponseRate: 0, latencyMs: 60 },
  { failureRate: 0.02, lostResponseRate: 0, latencyMs: 90 },
  { failureRate: 0.02, lostResponseRate: 0, latencyMs: 120 },
];
const NAMES = ["Atlas", "Beacon", "Crest"];

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;

export async function createApp(opts: { port?: number; timeoutMs?: number } = {}) {
  const clients = new Set<WebSocket>();
  const emit = (e: PayEvent) => {
    const payload = JSON.stringify(e);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(payload);
  };
  const providers = NAMES.map((n, i) => new MockProvider(i + 1, n, { ...DEFAULT_TUNING[i]! }));
  const service = new PaymentService(providers, emit, opts.timeoutMs);

  const snapshot = (): PayEvent => ({
    type: "state",
    providers: service.snapshotProviders(),
    config: service.config,
    stats: service.snapshotStats(),
  });

  let carry = 0;
  const trafficTimer = setInterval(() => {
    carry += (service.config.rps * 50) / 1000;
    while (carry >= 1) {
      carry -= 1;
      void service.syntheticPayment();
    }
  }, 50);
  const tickTimer = setInterval(
    () => emit({ type: "tick", providers: service.snapshotProviders(), stats: service.snapshotStats() }),
    400,
  );
  // Keep demo memory bounded: forget the oldest charges once a provider holds a lot of them.
  const pruneTimer = setInterval(() => {
    for (const p of providers) {
      if (p.charges.size > 20000) {
        let n = 10000;
        for (const k of p.charges.keys()) {
          if (n-- <= 0) break;
          p.charges.delete(k);
        }
      }
    }
  }, 10_000);

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<any>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    try {
      if (path === "/api/state" && req.method === "GET") return json(res, 200, snapshot());

      if (path === "/api/config" && req.method === "POST") {
        const b = await readBody(req);
        service.config.rps = clamp(b.rps, 0, 80, service.config.rps);
        service.config.duplicateRate = clamp(b.duplicateRate, 0, 1, service.config.duplicateRate);
        emit({ type: "config", config: service.config });
        return json(res, 200, service.config);
      }

      // Payments: the real API. Same Idempotency-Key => same result, one charge.
      if (path === "/api/payments" && req.method === "POST") {
        const b = await readBody(req);
        const key = String(req.headers["idempotency-key"] ?? b.key ?? `pay_${Math.random().toString(36).slice(2, 10)}`);
        const amount = clamp(b.amount, 1, 100_000_000, 100_000); // paise (INR minor units)
        return json(res, 200, await service.pay(key, amount));
      }

      // Inspect payments: recent list, or one payment's full attempt timeline.
      if (path === "/api/payments" && req.method === "GET") {
        const limit = clamp(Number(new URL(req.url ?? "/", "http://x").searchParams.get("limit")), 1, 100, 20);
        return json(res, 200, service.recentRecords(limit));
      }
      const pm = path.match(/^\/api\/payments\/(\d+)$/);
      if (pm && req.method === "GET") {
        const rec = service.getRecord(Number(pm[1]));
        return rec ? json(res, 200, rec) : json(res, 404, { error: "payment not found (only the most recent are kept)" });
      }

      // Fire the same key `n` times concurrently and report how many charges actually happened.
      if (path === "/api/replay" && req.method === "POST") {
        const n = clamp((await readBody(req)).n, 2, 200, 25);
        const key = `replay_${Date.now().toString(36)}`;
        const outcomes = await Promise.all(Array.from({ length: n }, () => service.pay(key, 4999)));
        return json(res, 200, {
          key,
          requests: n,
          charges: service.chargesFor(key),
          distinctOutcomes: new Set(outcomes.map((o) => o.id)).size,
          status: outcomes[0]!.status,
        });
      }

      const m = path.match(/^\/api\/providers\/(\d+)$/);
      if (m && req.method === "POST") {
        const p = providers.find((x) => x.id === Number(m[1]));
        if (!p) return json(res, 404, { error: "no such provider" });
        const b = await readBody(req);
        p.tuning.failureRate = clamp(b.failureRate, 0, 1, p.tuning.failureRate);
        p.tuning.lostResponseRate = clamp(b.lostResponseRate, 0, 1, p.tuning.lostResponseRate);
        p.tuning.latencyMs = clamp(b.latencyMs, 5, 1000, p.tuning.latencyMs);
        return json(res, 200, p.tuning);
      }

      if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });
      return serveStatic(path, res);
    } catch (err) {
      return json(res, 500, { error: String(err) });
    }
  });

  function serveStatic(path: string, res: ServerResponse) {
    const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    let file = join(WEB_DIST, rel);
    if (!file.startsWith(WEB_DIST) || !existsSync(file)) file = join(WEB_DIST, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Frontend not built. Run `npm run build`, or use `npm run dev`.");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }

  const wss = new WebSocketServer({ server, path: "/events" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify(snapshot()));
    ws.on("close", () => clients.delete(ws));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 8080, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8080);

  async function close() {
    clearInterval(trafficTimer);
    clearInterval(tickTimer);
    clearInterval(pruneTimer);
    wss.close();
    for (const c of clients) c.terminate();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }

  return { port, close, service, providers };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const app = await createApp({ port: Number(process.env.PORT ?? 8080) });
  console.log(`payments-flow listening on http://localhost:${app.port}`);
  const stop = () => app.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
