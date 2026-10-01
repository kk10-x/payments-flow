import Lenis from "lenis";
import { Api } from "./api.ts";
import { PaymentScene, WORKER_COLORS } from "./scene.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const api = new Api();

// ---- 3D scene (optional: the page still works without WebGL) ---------------------------------
let scene: PaymentScene | null = null;
try {
  scene = new PaymentScene($("stage") as HTMLCanvasElement, reduced);
  api.on((e) => scene?.handle(e));
} catch {
  document.documentElement.classList.add("no-gl");
}

// ---- scroll: chapter index drives the camera --------------------------------------------------
const chapters = [...document.querySelectorAll<HTMLElement>("[data-chapter]")];
function onScroll() {
  scene?.setStop(scrollY / innerHeight);
}
if (!reduced) {
  const lenis = new Lenis({ lerp: 0.1 });
  const raf = (t: number) => {
    lenis.raf(t);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  lenis.on("scroll", onScroll);
}
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// ---- controls ---------------------------------------------------------------------------------
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
// Scrolling into a chapter sets up the scenario for that chapter.
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
let current = -1;
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const i = Number((en.target as HTMLElement).dataset.chapter);
      if (i === current) continue;
      current = i;
      onChapter[i]?.();
    }
  },
  { threshold: 0.55 },
);
chapters.forEach((c) => io.observe(c));

// ---- ledger -----------------------------------------------------------------------------------
const provEl = $("l-providers");
provEl.innerHTML = [1, 2, 3]
  .map(
    (id) =>
      `<li id="lp-${id}" style="--c:#${WORKER_COLORS[id - 1]!.getHexString()}"><span class="nm"></span><span class="n"></span></li>`,
  )
  .join("");
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
  for (const p of v.providers) {
    const li = $(`lp-${p.id}`);
    li.classList.toggle("down", p.circuit === "open");
    li.querySelector(".nm")!.textContent = p.name.toLowerCase();
    li.querySelector(".n")!.textContent =
      p.circuit === "open" ? "open" : p.circuit === "half-open" ? "probe" : `${Math.round(p.successRate * 100)}%`;
  }
}, 150);

api.connect().then(() => onChapter[Math.max(current, 0)]?.());
