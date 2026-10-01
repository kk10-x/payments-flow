import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { PayEvent } from "../shared/types.ts";
import { createApp } from "../server/main.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("HTTP API: replay endpoint turns 25 concurrent requests into 1 charge", async () => {
  const app = await createApp({ port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 25 }),
    });
    const body = (await res.json()) as { requests: number; charges: number; distinctOutcomes: number };
    assert.equal(body.requests, 25);
    assert.equal(body.charges, 1);
    assert.equal(body.distinctOutcomes, 1);
  } finally {
    await app.close();
  }
});

test("HTTP API: Idempotency-Key header dedupes across separate requests", async () => {
  const app = await createApp({ port: 0 });
  try {
    const pay = () =>
      fetch(`http://127.0.0.1:${app.port}/api/payments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "order-42" },
        body: JSON.stringify({ amount: 2500 }),
      }).then((r) => r.json() as Promise<{ id: number; status: string }>);
    const [a, b] = [await pay(), await pay()];
    assert.equal(a.status, "captured");
    assert.equal(a.id, b.id, "second call returns the first call's result");
    assert.equal(app.service.chargesFor("order-42"), 1);
  } finally {
    await app.close();
  }
});

test("WebSocket streams routed and settled events for real payments", async () => {
  const app = await createApp({ port: 0 });
  const events: PayEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/events`);
  ws.on("message", (m) => events.push(JSON.parse(String(m))));
  try {
    await sleep(150);
    await app.service.pay("ws-1", 100);
    await sleep(100);
    assert.equal(events[0]?.type, "state");
    assert.ok(events.some((e) => e.type === "routed"));
    assert.ok(events.some((e) => e.type === "settled"));
  } finally {
    ws.close();
    await app.close();
  }
});
