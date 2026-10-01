# Payments Flow

[![demo](https://img.shields.io/badge/demo-live-brightgreen)](https://bella.taile86535.ts.net:10000/payments-flow/)

A mock payment gateway with health-scored provider routing, circuit breakers and idempotent retries, drawn as a live printed-ledger diagram. Each particle is a real payment moving through the code, and the page shows a counter that must always read zero: double charges.

![Sending one payment 25 times at once: the gateway answers 24 from its idempotency store and the ledger records a single charge](assets/replay-25x.gif)

| Provider cards and an open breaker | Payment inspector: timeout, then a same-provider retry |
| --- | --- |
| ![Beacon's breaker is open: its box is hatched, its card shows the failure dip in the sparkline](assets/degrade.jpg) | ![Payment 1782: Atlas timed out, so the gateway retried Atlas with the same key and got the original charge back](assets/inspector.jpg) |

Most payment-routing demos are diagrams. This one runs the routing: three mock providers that fail, decline and lose responses on command, a router that shifts traffic by observed health, and a retry policy built so a lost response can never charge a card twice. The live counters come from the same event stream that draws the particles.

## Tech stack

- **Backend:** Node.js 20+, TypeScript, `node:http` and `fetch`, [`ws`](https://github.com/websockets/ws) for the event stream
- **Frontend:** Vite and TypeScript with a hand-drawn 2D canvas diagram, no UI framework and no runtime dependencies (about 18 kB of JavaScript)
- **Tests:** `node:test` run through `tsx`, including a chaos test that fires duplicate keys at providers that fail and lose replies
- **CI:** GitHub Actions: typecheck, tests, production build

## Architecture

```
 browser (2D canvas diagram, event tape, controls)
    │  WebSocket /events ◄── routed · attemptFailed · settled · replayed · failed · unknown · tick
    │  POST /api/*       ──► payments, replay, provider tuning, traffic
    ▼
 PaymentService
    ├─ idempotency   one Promise per key; a repeat (in flight or finished) shares the first result
    ├─ HealthRouter  pick a provider at random, weighted by score^3 (success rate, then latency)
    │                 circuit breaker per provider: 4 failures in a row opens it for 3 s, then one probe
    └─ retry policy  definite failure (declined, 5xx)  → charged nothing  → may fail over
                     timeout / lost response           → outcome unknown  → retry the SAME provider, same key
    ▼
 MockProvider × 3    idempotent on key; can decline, return 5xx, or charge and then lose the reply
```

- **The retry rule is the point.** A decline means nothing was charged, so the next attempt can go to another provider. A timeout is different: the provider may already have charged. The gateway then retries only that provider with the same idempotency key, which returns the original charge. Failing over there could charge the card twice. If retries still can't confirm, the payment ends as `unknown` (needs reconciliation) rather than guessing.
- **Double charges are measured, not assumed.** The service counts idempotency keys charged by more than one provider. That number is shown on the page and asserted to be 0 in the tests.
- **Mutation-checked.** With the same-provider rule removed, the lost-response test and the chaos test both fail, so the tests do guard the invariant.
- **Design.** A flat, printed-ledger look on ruled paper: client, gateway, three provider boxes and the ledger drawn as line art on a 2D canvas. Payments are dots travelling along ruled routes, failures are crosses, and a replayed key is a hollow dot that bounces straight back from the gateway. A provider's bar shows its success rate, and an open breaker hatches its box. Under the diagram, provider cards show a minute-long success sparkline, latency percentiles, traffic share and in-flight count, and a receipt-style tape stamps each event (captured, timeout, replayed, failed, unknown). Click a tape row to open the payment inspector. Entering a chapter sets up its scenario (for example, Beacon starts declining 90% of charges).
- **Simulated fallback.** If the page can't reach the server (for example on a static host), it runs the same `PaymentService` and `MockProvider` code inside the browser. The header then reads **SIMULATED · IN YOUR BROWSER** instead of **LIVE**.

## Key features

- Health-scored routing that visibly drains traffic from a degrading provider, with a floor so it is still sampled and can recover.
- Per-provider circuit breaker with open, half-open (single probe) and closed states, covered by unit tests.
- Idempotency keys that dedupe both concurrent and later repeats. Sending one key 25 times at once produces one charge.
- Failure injection from the page: provider decline rate, and the rate at which a provider charges but loses its reply.
- **Payment inspector:** click any tape row to see that payment's attempt-by-attempt timeline (which provider, what failed, how long it took, and whether the gateway failed over or retried the same provider, with the reason in plain language), its replay count, and the final outcome.
- **Provider cards:** success sparkline for the last 60 s, p50 and p95 latency, share of routed traffic, calls in flight, and breaker state, all computed from live attempts.
- **Real amounts:** payments carry amounts in INR (stored in paise). The ledger shows the captured total in lakh and crore, tape rows show exact amounts, and you can send your own payment with a key and amount.
- **Explainer:** a decision table (what happened, what it means, what the gateway does), the routing formula and the breaker states, plus what the demo does not model.
- A live ledger: payments, captured, captured value, failed, unknown, replays and double charges.
- No WebGL needed. Respects `prefers-reduced-motion` (the diagram stops animating dots; counters and the tape still update).

## Setup

Requires Node 20 or newer (or Docker: `docker compose up -d --build` serves it on 127.0.0.1:8200).

```bash
npm install
npm start          # builds the frontend and serves everything on http://localhost:8080
```

For development with hot reload (server on :8080, Vite on :5173):

```bash
npm run dev
```

Other scripts:

```bash
npm test           # unit, concurrency, chaos and HTTP/WebSocket tests
npm run lint       # tsc --noEmit
npm run build      # production frontend into web/dist
```

### HTTP API

Send a payment (the `Idempotency-Key` header is optional; repeat it to get the original result):

```bash
curl -X POST localhost:8080/api/payments \
  -H 'content-type: application/json' -H 'idempotency-key: order-42' \
  -d '{"amount": 249900}'   # amount in paise: ₹2,499.00
# e.g. {"id":1,"key":"order-42","status":"captured","provider":2,"attempts":1}
```

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| GET | `/api/state` | | Providers (score, circuit, charges, tuning), config and counters |
| POST | `/api/payments` | `{ amount, key? }` | One payment (`amount` in paise); `Idempotency-Key` header or `key` sets the key |
| GET | `/api/payments` | `?limit=20` | Most recent payment records, newest first |
| GET | `/api/payments/:id` | | One payment's full record: amount, status, replays and every attempt with its explanation |
| POST | `/api/replay` | `{ n }` | Send one new key `n` times at once; returns how many charges happened |
| POST | `/api/providers/:id` | `{ failureRate?, lostResponseRate?, latencyMs? }` | Tune a mock provider |
| POST | `/api/config` | `{ rps?, duplicateRate? }` | Synthetic traffic rate and the share of repeated keys |
| WS | `/events` | | Stream of `PayEvent` (see [`shared/types.ts`](shared/types.ts)) |

## Limitations

- Providers are mocks with random failures and delays. There is no real money, card data or network to a payment processor.
- State is in memory: idempotency keys and charges are lost on restart and trimmed after about 6,000 keys. A real system needs a durable store with a TTL.
- `unknown` payments are only counted. There is no reconciliation job that later asks the provider what happened.
- Routing weights and breaker thresholds are fixed constants, not tuned against real traffic.
- INR only. The inspector and the list keep only the most recent 400 payments.
- Synthetic traffic is capped at 80 payments per second to keep the scene readable. Not load-tested.

## Why I built this

I wanted to show the part of payment routing that is easy to get wrong: what to do after a timeout. The gateway, its retry rule and its counters are real code you can break from the page, instead of a diagram of how it ought to work.
