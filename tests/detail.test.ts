import assert from "node:assert/strict";
import { test } from "node:test";
import type { PayEvent } from "../shared/types.ts";
import { ProviderMetrics } from "../server/metrics.ts";
import { MockProvider } from "../server/provider.ts";
import { PaymentService } from "../server/service.ts";
import { createApp } from "../server/main.ts";

const tuning = (over: Partial<MockProvider["tuning"]> = {}) => ({
  failureRate: 0,
  lostResponseRate: 0,
  latencyMs: 5,
  ...over,
});

function setup(tunings: ReturnType<typeof tuning>[], timeoutMs = 60, rand?: () => number) {
  const events: PayEvent[] = [];
  const providers = tunings.map((t, i) => new MockProvider(i + 1, `p${i + 1}`, t, 300));
  const service = new PaymentService(providers, (e) => events.push(e), timeoutMs, rand);
  return { events, providers, service };
}

test("metrics: percentiles, in-flight count and per-second success ratio use an injectable clock", () => {
  let t = 1_000_000;
  const m = new ProviderMetrics(() => t);
  for (let i = 1; i <= 100; i++) {
    m.routed();
    m.done(true, i);
  }
  assert.equal(m.snapshot().p50, 51);
  assert.equal(m.snapshot().p95, 96);
  assert.equal(m.inflight, 0);

  t += 1000;
  m.routed();
  m.routed();
  assert.equal(m.snapshot().inflight, 2);
  m.done(true, 10);
  m.done(false, 10);
  const spark = m.snapshot().spark;
  assert.equal(spark.length, 60);
  assert.equal(spark[59], 0.5, "this second: 1 ok, 1 failed");
  assert.equal(spark[58], 1, "previous second: all ok");
  assert.equal(spark[0], null, "no traffic a minute ago");
});

test("metrics: old seconds fall out of the 60 s window", () => {
  let t = 5_000_000;
  const m = new ProviderMetrics(() => t);
  m.routed();
  m.done(true, 5);
  t += 90_000;
  assert.equal(m.snapshot().routed, 0);
  assert.ok(m.snapshot().spark.every((v) => v === null));
});

test("record: a lost response shows a timeout attempt, then a same-provider retry that returns the original charge", async () => {
  const { service } = setup([tuning({ lostResponseRate: 1 }), tuning()], 60, () => 0);
  const out = await service.pay("rec-1", 250_000);
  const rec = service.getRecord(out.id)!;
  assert.equal(rec.status, "captured");
  assert.equal(rec.amount, 250_000);
  assert.deepEqual(
    rec.attempts.map((a) => [a.provider, a.ok, a.kind ?? null]),
    [
      [1, false, "timeout"],
      [1, true, null],
    ],
  );
  assert.match(rec.attempts[0]!.note, /does not fail over/);
  assert.match(rec.attempts[1]!.note, /No second charge/);
  assert.match(rec.summary, /Captured by p1 after 2 attempts/);
});

test("record: a decline fails over, and the timeline says nothing was charged", async () => {
  const { service } = setup([tuning({ failureRate: 1 }), tuning()], 60, () => 0);
  const out = await service.pay("rec-2", 10_000);
  const rec = service.getRecord(out.id)!;
  assert.equal(rec.attempts[0]!.ok, false);
  assert.match(rec.attempts[0]!.note, /Nothing was charged/);
  assert.equal(rec.attempts.at(-1)!.provider, 2);
  assert.match(rec.attempts.at(-1)!.note, /after the earlier provider declined/);
});

test("replays: counted on the original record, and the event points at the original payment id", async () => {
  const { service, events } = setup([tuning()]);
  const first = service.pay("rep-1", 5000);
  await Promise.all([service.pay("rep-1", 5000), service.pay("rep-1", 5000)]);
  const out = await first;
  assert.equal(service.getRecord(out.id)!.replays, 2);
  const replayed = events.filter((e) => e.type === "replayed");
  assert.equal(replayed.length, 2);
  assert.ok(replayed.every((e) => e.type === "replayed" && e.id === out.id));
});

test("stats: captured amount is the sum of captured payments only", async () => {
  const { service } = setup([tuning({ failureRate: 0 })]);
  await service.pay("a", 10_000);
  await service.pay("b", 25_000);
  await service.pay("a", 10_000); // replay, not counted again
  assert.equal(service.snapshotStats().capturedAmount, 35_000);
});

test("provider snapshot exposes latency, share and sparkline", async () => {
  const { service } = setup([tuning(), tuning()]);
  for (let i = 0; i < 20; i++) await service.pay(`s${i}`, 100);
  const snap = service.snapshotProviders();
  const share = snap.reduce((s, p) => s + p.share, 0);
  assert.ok(Math.abs(share - 1) < 0.01, `shares sum to ${share}`);
  assert.ok(snap.every((p) => p.spark.length === 60));
  assert.ok(snap.some((p) => p.p50 !== null));
});

test("HTTP: payment record endpoints return the attempt timeline", async () => {
  const app = await createApp({ port: 0 });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const paid = (await (
      await fetch(`${base}/api/payments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "insp-1" },
        body: JSON.stringify({ amount: 123_400 }),
      })
    ).json()) as { id: number };
    const rec = (await (await fetch(`${base}/api/payments/${paid.id}`)).json()) as { key: string; amount: number; attempts: unknown[] };
    assert.equal(rec.key, "insp-1");
    assert.equal(rec.amount, 123_400);
    assert.ok(rec.attempts.length >= 1);
    const list = (await (await fetch(`${base}/api/payments?limit=5`)).json()) as { id: number }[];
    assert.equal(list[0]!.id, paid.id, "most recent first");
    const missing = await fetch(`${base}/api/payments/999999`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});
