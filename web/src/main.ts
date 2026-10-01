import { Api } from "./api.ts";
import { FlowView, PROVIDER_INK } from "./flow.ts";
import type { PayEvent, PaymentRecord, ProviderInfo } from "../../shared/types.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isNarrow = () => matchMedia("(max-width: 900px)").matches;

const api = new Api();

// ---- formatting -----------------------------------------------------------------------------
const fmt = (n: number) => n.toLocaleString("en-US");
/** Compact rupees from paise, with Indian units: L (lakh) and Cr (crore). */
function inrCompact(paise: number): string {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`;
  return `₹${Math.round(r).toLocaleString("en-IN")}`;
}
const inrExact = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const name = (id: number) => api.view.providers[id - 1]?.name ?? `provider ${id}`;

// ---- flow diagram (2D canvas; the page still works if it can't start) -----------------------
try {
  const flow = new FlowView($("flow") as HTMLCanvasElement, () => api.view, reduced);
  api.on((e) => flow.handle(e));
} catch {
  document.documentElement.classList.add("no-canvas");
}

// ---- payment inspector ----------------------------------------------------------------------
const inspector = $("inspector");
const lower = $("lower");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function closeInspector() {
  inspector.hidden = true;
  inspector.replaceChildren();
}

function renderInspector(rec: PaymentRecord) {
  const head = el("header");
  head.append(el("h3", undefined, `Payment #${rec.id}`));
  const close = el("button", "close", "Close");
  close.type = "button";
  close.addEventListener("click", closeInspector);
  head.append(close);

  const meta = el("dl", "meta");
  const add = (k: string, v: string, cls?: string) => {
    const d = el("div");
    d.append(el("dt", undefined, k), el("dd", cls, v));
    meta.append(d);
  };
  add("amount", inrExact(rec.amount));
  add("key", rec.key);
  add("status", rec.status, `status-${rec.status}`);
  add("replays", String(rec.replays));

  const steps = el("ol", "timeline");
  for (const a of rec.attempts) {
    const li = el("li", a.ok ? "ok" : a.kind === "timeout" ? "warn" : "bad");
    li.style.setProperty("--c", PROVIDER_INK[a.provider - 1] ?? "#12181f");
    const top = el("div", "step");
    top.append(
      el("span", "n", String(a.n)),
      el("span", "who", name(a.provider)),
      el("span", "what", a.ok ? "captured" : (a.kind ?? "failed")),
      el("span", "ms", `${a.ms} ms`),
    );
    li.append(top, el("p", undefined, a.note));
    steps.append(li);
  }
  if (rec.attempts.length === 0) steps.append(el("li", "warn", "No attempts yet."));

  inspector.replaceChildren(head, meta, steps, el("p", "summary", rec.summary));
  if (!isNarrow()) {
    // Cover exactly the provider cards and event tape.
    inspector.style.top = `${lower.offsetTop}px`;
    inspector.style.height = `${lower.offsetHeight}px`;
  } else {
    inspector.style.removeProperty("top");
    inspector.style.removeProperty("height");
  }
  inspector.hidden = false;
}

async function inspect(id: number) {
  const rec = await api.getPayment(id);
  if (rec) renderInspector(rec);
  else {
    inspector.replaceChildren(
      el("p", "summary", `Payment #${id} is no longer kept. Only the most recent payments are retained.`),
    );
    inspector.hidden = false;
  }
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeInspector();
});

// ---- event tape -----------------------------------------------------------------------------
const tape = $("tape");
const TAPE_ROWS = 4;
function addRow(id: number, stamp: string, cls: string, note: string) {
  const li = el("li");
  const row = el("button", "row");
  row.type = "button";
  row.setAttribute("aria-label", `Inspect payment ${id}: ${stamp}`);
  const st = el("span", `stamp ${cls}`);
  st.append(el("span", undefined, stamp));
  row.append(el("span", "id", `#${id}`), st, el("span", "note", note));
  row.addEventListener("click", () => void inspect(id));
  li.append(row);
  tape.prepend(li);
  while (tape.children.length > TAPE_ROWS) tape.lastElementChild!.remove();
}
function onEvent(e: PayEvent) {
  switch (e.type) {
    case "settled":
      addRow(e.id, "captured", "ok", `${name(e.provider)} · ${e.ms} ms · ${inrExact(e.amount)}`);
      break;
    case "attemptFailed":
      if (e.kind === "timeout") addRow(e.id, "timeout", "warn", `${name(e.provider)} · outcome unknown, retrying same provider`);
      else addRow(e.id, e.kind, "bad", `${name(e.provider)} · charged nothing, may fail over`);
      break;
    case "replayed":
      addRow(e.id, "replayed", "", "repeat key answered from the first result, no new charge");
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

// ---- provider cards -------------------------------------------------------------------------
const cards = $("cards");
const SVG = "http://www.w3.org/2000/svg";
interface CardEls {
  badge: HTMLElement;
  path: SVGPathElement;
  ok: HTMLElement;
  lat: HTMLElement;
  share: HTMLElement;
  root: HTMLElement;
}
const cardEls: CardEls[] = [1, 2, 3].map((id) => {
  const root = el("article", "card");
  root.style.setProperty("--c", PROVIDER_INK[id - 1]!);
  const head = el("header");
  const nm = el("b", undefined, "");
  nm.dataset.name = String(id);
  const badge = el("span", "badge", "closed");
  head.append(nm, badge);

  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 120 28");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Success rate over the last minute");
  const base = document.createElementNS(SVG, "line");
  base.setAttribute("x1", "0");
  base.setAttribute("x2", "120");
  base.setAttribute("y1", "26");
  base.setAttribute("y2", "26");
  base.setAttribute("class", "base");
  const path = document.createElementNS(SVG, "path");
  svg.append(base, path);

  const dl = el("dl");
  const cell = (k: string) => {
    const d = el("div");
    const dd = el("dd", undefined, "–");
    d.append(el("dt", undefined, k), dd);
    dl.append(d);
    return dd;
  };
  const ok = cell("success");
  const share = cell("traffic");
  const lat = cell("latency");
  lat.parentElement!.classList.add("wide");
  root.append(head, svg, dl);
  cards.append(root);
  return { badge, path, ok, lat, share, root };
});

function sparkPath(spark: (number | null)[]): string {
  let d = "";
  let pen = false;
  spark.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    const x = (i / (spark.length - 1)) * 120;
    const y = 26 - v * 24;
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  return d;
}

function renderCards(providers: ProviderInfo[]) {
  providers.forEach((p, i) => {
    const c = cardEls[i];
    if (!c) return;
    const nm = c.root.querySelector<HTMLElement>("b")!;
    if (nm.textContent !== p.name.toUpperCase()) nm.textContent = p.name.toUpperCase();
    const state = p.circuit === "open" ? "open" : p.circuit === "half-open" ? "probe" : "closed";
    c.badge.textContent = p.inflight > 0 ? `${state} · ${p.inflight} live` : state;
    c.root.dataset.circuit = p.circuit;
    c.path.setAttribute("d", sparkPath(p.spark));
    c.ok.textContent = `${Math.round(p.successRate * 100)}%`;
    c.lat.textContent = p.p50 === null ? "–" : `p50 ${p.p50} · p95 ${p.p95} ms`;
    c.share.textContent = `${Math.round(p.share * 100)}%`;
  });
}

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
$("send").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const out = $("send-out");
  const rupees = Number($<HTMLInputElement>("amt").value);
  if (!Number.isFinite(rupees) || rupees < 1) {
    out.textContent = "Enter an amount of at least ₹1.";
    return;
  }
  const key = $<HTMLInputElement>("idem").value.trim() || `pay_${Math.random().toString(36).slice(2, 10)}`;
  out.textContent = "Sending…";
  const r = await api.pay(key, Math.round(rupees * 100));
  if (!r) {
    out.textContent = "Couldn't reach the server.";
    return;
  }
  out.textContent = `Payment #${r.id}: ${r.status}. Send the same key again and you get payment #${r.id} back, not a new charge.`;
  void inspect(r.id);
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

// Past the last chapter (the explainer), stop generating load.
new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting)) api.setConfig({ rps: 4 });
  },
  { threshold: 0.3 },
).observe(document.querySelector(".explain")!);

// ---- counters and cards ---------------------------------------------------------------------
setInterval(() => {
  const v = api.view;
  const mode = $("mode");
  mode.dataset.mode = v.mode;
  mode.textContent = v.mode === "simulated" ? "simulated · in your browser" : v.mode === "live" ? "live" : "connecting";
  const s = v.stats;
  $("l-payments").textContent = fmt(s.payments);
  $("l-captured").textContent = fmt(s.captured);
  $("l-value").textContent = inrCompact(s.capturedAmount);
  $("l-failed").textContent = fmt(s.failed);
  $("l-unknown").textContent = fmt(s.unknown);
  $("l-replays").textContent = fmt(s.replays);
  $("l-double").textContent = fmt(s.doubleCharges);
  renderCards(v.providers);
}, 200);

api.connect().then(() => onChapter[Math.max(current, 0)]?.());
