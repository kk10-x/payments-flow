import assert from "node:assert/strict";
import { test } from "node:test";
import type { PayEvent } from "../shared/types.ts";
import { MockProvider } from "../server/provider.ts";
import { Health, HealthRouter } from "../server/router.ts";
import { PaymentService } from "../server/service.ts";

const tuning = (over: Partial<MockProvider["tuning"]> = {}) => ({
  failureRate: 0,
  lostResponseRate: 0,
  latencyMs: 5,
  ...over,
});

function setup(tunings: ReturnType<typeof tuning>[], timeoutMs = 60, rand?: () => number) {
  const events: PayEvent[] = [];
  // lostResponseDelayMs is long enough that the caller's short test timeout always fires first
  const providers = tunings.map((t, i) => new MockProvider(i + 1, `p${i + 1}`, t, 300));
  const service = new PaymentService(providers, (e) => events.push(e), timeoutMs, rand);
  return { events, providers, service };
}

test("same idempotency key fired 50x concurrently produces exactly one charge", async () => {
  const { service } = setup([tuning(), tuning(), tuning()]);
  const outcomes = await Promise.all(Array.from({ length: 50 }, () => service.pay("k1", 100)));
  assert.equal(service.chargesFor("k1"), 1);
  assert.ok(outcomes.every((o) => o === outcomes[0] || o.id === outcomes[0]!.id), "all callers share one outcome");
  assert.equal(service.snapshotStats().replays, 49);
});

test("a repeat of a finished payment is a replay, not a new charge", async () => {
  const { service } = setup([tuning()]);
  await service.pay("k2", 100);
  await service.pay("k2", 100);
  assert.equal(service.chargesFor("k2"), 1);
  assert.equal(service.snapshotStats().payments, 1);
});

test("a definite failure fails over to another provider and still charges once", async () => {
  const { service, providers } = setup([tuning({ failureRate: 1 }), tuning()]);
  for (let i = 0; i < 20; i++) {
    const out = await service.pay(`f${i}`, 100);
    assert.equal(out.status, "captured");
    assert.equal(out.provider, 2);
  }
  assert.equal(providers[0]!.charges.size, 0);
  assert.equal(service.doubleCharges(), 0);
});

test("a lost response retries the SAME provider and never charges twice", async () => {
  // Provider 1 always charges but loses its response; provider 2 is healthy and tempting.
  const { service, providers, events } = setup([tuning({ lostResponseRate: 1 }), tuning()], 60, () => 0); // rand=0: router picks provider 1 first
  const out = await service.pay("lost-1", 100);
  assert.equal(out.status, "captured", "retry on the same provider recovers the original charge");
  assert.equal(out.provider, 1);
  assert.equal(service.chargesFor("lost-1"), 1);
  assert.equal(providers[1]!.charges.has("lost-1"), false, "no fail-over after a timeout");
  assert.ok(events.some((e) => e.type === "attemptFailed" && e.kind === "timeout"));
});

test("chaos: mixed failures, lost responses and duplicate keys never double-charge", async () => {
  const { service } = setup([
    tuning({ failureRate: 0.3, lostResponseRate: 0.3 }),
    tuning({ failureRate: 0.3, lostResponseRate: 0.3 }),
    tuning({ failureRate: 0.3, lostResponseRate: 0.3 }),
  ]);
  const calls: Promise<unknown>[] = [];
  for (let i = 0; i < 150; i++) calls.push(service.pay(`c${i % 60}`, 100));
  await Promise.all(calls);
  assert.equal(service.doubleCharges(), 0);
});

test("router shifts traffic away from a failing provider and trips its breaker", () => {
  let t = 0;
  const router = new HealthRouter([1, 2], () => 0.5, () => t);
  for (let i = 0; i < 30; i++) router.health.get(1)!.record(false, 50);
  for (let i = 0; i < 30; i++) router.health.get(2)!.record(true, 50);
  assert.equal(router.health.get(1)!.state, "open");
  for (let i = 0; i < 20; i++) assert.equal(router.pick(), 2);
});

test("breaker goes half-open after cooldown, allows one probe, and closes on success", () => {
  let t = 0;
  const h = new Health(() => t);
  for (let i = 0; i < 4; i++) h.record(false, 50);
  assert.equal(h.state, "open");
  t += 3500;
  h.refresh();
  assert.equal(h.state, "half-open");
  h.record(true, 50);
  assert.equal(h.state, "closed");
});

test("half-open breaker lets exactly one probe through", () => {
  let t = 0;
  const router = new HealthRouter([1], () => 0.5, () => t);
  for (let i = 0; i < 4; i++) router.health.get(1)!.record(false, 50);
  assert.equal(router.pick(), undefined, "open: no traffic");
  t += 3500;
  assert.equal(router.pick(), 1, "half-open: one probe");
  assert.equal(router.pick(), undefined, "second request is held back while the probe is out");
});
