import { Api } from "./api.ts";
import { FlowView } from "./flow.ts";
import type { PayEvent } from "../../shared/types.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const api = new Api();

// ---- flow diagram (2D canvas; the page still works if it can't start) -----------------------
try {
  const flow = new FlowView($("flow") as HTMLCanvasElement, () => api.view, reduced);
  api.on((e) => flow.handle(e));
} catch {
  document.documentElement.classList.add("no-canvas");
}

// ---- event tape -----------------------------------------------------------------------------
const tape = $("tape");
const TAPE_ROWS = 5;
const name = (id: number) => api.view.providers[id - 1]?.name ?? `provider ${id}`;
function addRow(id: number, stamp: string, cls: string, note: string) {
  const li = document.createElement("li");
  const idEl = document.createElement("span");
  idEl.className = "id";
  idEl.textContent = `#${id}`;
  const st = document.createElement("span");
  st.className = `stamp ${cls}`;
  const inner = document.createElement("span");
  inner.textContent = stamp;
  st.append(inner);
  const nt = document.createElement("span");
  nt.className = "note";
  nt.textContent = note;
  li.append(idEl, st, nt);
  tape.prepend(li);
  while (tape.children.length > TAPE_ROWS) tape.lastElementChild!.remove();
}
function onEvent(e: PayEvent) {
  switch (e.type) {
    case "settled":
      addRow(e.id, "captured", "ok", `${name(e.provider)} · ${e.ms} ms`);
      break;
    case "attemptFailed":
      if (e.kind === "timeout") addRow(e.id, "timeout", "warn", `${name(e.provider)} · outcome unknown, retrying same provider`);
      else addRow(e.id, e.kind, "bad", `${name(e.provider)} · charged nothing, may fail over`);
      break;
    case "replayed":
      addRow(e.id, "replayed", "", "answered from the idempotency store, no new charge");
      break;
    case "failed":
      addRow(e.id, "failed", "bad solid", "every provider declined, nothing charged");
      break;
    case "unknown":
      addRow(e.id, "unknown", "warn solid", "needs reconciliation with the provider");
      break;
    default:
      break;
  }
}
api.on(onEvent);

// ---- controls -------------------------------------------------------------------------------
const rps = $<HTMLInputElement>("rps");
const fail = $<HTMLInputElement>("fail");
const lost = $<HTMLInputElement>("lost");
const mirror = (input: HTMLInputElement, ...outs: string[]) =>
  outs.forEach((id) => ($(id).textContent = input.value));

rps.addEventListener("input", () => {
  mirror(rps, "rps-out");
  api.setConfig({ rps: Number(rps.value) });
});
fail.addEventListener("input", () => {
  mirror(fail, "fail-out", "fail-out2");
  api.setProvider(2, { failureRate: Number(fail.value) / 100 });
});
lost.addEventListener("input", () => {
  mirror(lost, "lost-out", "lost-out2");
  api.setProvider(1, { lostResponseRate: Number(lost.value) / 100 });
});
$("replay").addEventListener("click", async () => {
  const out = $("replay-out");
  out.textContent = "Sending…";
  const r = await api.replay(25);
  out.textContent = r
    ? `${r.requests} requests, ${r.charges} charge${r.charges === 1 ? "" : "s"}. Outcome: ${r.status}.`
    : "Couldn't reach the server.";
});

const BASE_FAIL = 0.02;
// Scrolling a chapter into view sets up the scenario for that chapter.
const onChapter: Record<number, () => void> = {
  0: () => {
    api.setConfig({ rps: 6 });
    api.setProvider(1, { lostResponseRate: 0 });
    api.setProvider(2, { failureRate: BASE_FAIL });
  },
  1: () => {
    api.setConfig({ rps: Number(rps.value) });
    api.setProvider(1, { lostResponseRate: 0 });
    api.setProvider(2, { failureRate: BASE_FAIL });
  },
  2: () => {
    api.setConfig({ rps: Math.max(Number(rps.value), 20) });
    api.setProvider(1, { lostResponseRate: 0 });
    api.setProvider(2, { failureRate: Number(fail.value) / 100 });
  },
  3: () => {
    api.setConfig({ rps: Math.max(Number(rps.value), 16) });
    api.setProvider(2, { failureRate: BASE_FAIL });
    api.setProvider(1, { lostResponseRate: Number(lost.value) / 100 });
  },
  4: () => {
    api.setConfig({ rps: 10 });
    api.setProvider(1, { lostResponseRate: 0 });
    api.setProvider(2, { failureRate: BASE_FAIL });
  },
};
const chapters = [...document.querySelectorAll<HTMLElement>("[data-chapter]")];
let current = -1;
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const i = Number((en.target as HTMLElement).dataset.chapter);
      if (i === current) continue;
      current = i;
      chapters.forEach((c) => c.classList.toggle("active", c === en.target));
      onChapter[i]?.();
    }
  },
  { rootMargin: "-35% 0px -35% 0px", threshold: 0 },
);
chapters.forEach((c) => io.observe(c));
chapters[0]?.classList.add("active");

// ---- counters -------------------------------------------------------------------------------
const fmt = (n: number) => n.toLocaleString("en-US");
setInterval(() => {
  const v = api.view;
  const mode = $("mode");
  mode.dataset.mode = v.mode;
  mode.textContent = v.mode === "simulated" ? "simulated · in your browser" : v.mode === "live" ? "live" : "connecting";
  const s = v.stats;
  $("l-payments").textContent = fmt(s.payments);
  $("l-captured").textContent = fmt(s.captured);
  $("l-failed").textContent = fmt(s.failed);
  $("l-unknown").textContent = fmt(s.unknown);
  $("l-replays").textContent = fmt(s.replays);
  $("l-double").textContent = fmt(s.doubleCharges);
}, 150);

api.connect().then(() => onChapter[Math.max(current, 0)]?.());
