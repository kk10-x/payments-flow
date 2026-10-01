import type { PayEvent } from "../../shared/types.ts";
import type { View } from "./api.ts";

export const INK = "#12181f";
export const DIM = "#5b655e";
export const RULE = "#aab2a8";
export const BAD = "#c23b22";
/** One ink per provider; the same three appear in the diagram and in the tape. */
export const PROVIDER_INK = ["#2447d6", "#0b8a6a", "#b7791f"];

// Logical drawing space. The canvas scales this to fit while keeping the aspect ratio.
const W = 900;
const H = 440;
const CLIENT = { x: 52, y: 220 };
const GATE = { x: 250, y: 220, w: 96, h: 150 };
const BOX = { w: 214, h: 78, x: 456 };
const PROV_Y = [78, 220, 362];
const LEDGER_X = 862;

interface Pt {
  x: number;
  y: number;
}
type DotKind = "pay" | "ledger" | "replay";
interface Dot {
  kind: DotKind;
  path: Pt[];
  t: number;
  dur: number;
  color: string;
}
interface Cross {
  at: Pt;
  t: number;
  color: string;
  size: number;
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function along(path: Pt[], t: number): Pt {
  // Position at fraction t of the polyline's total length.
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const l = Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
    lens.push(l);
    total += l;
  }
  let d = t * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]!) {
      const f = lens[i]! === 0 ? 0 : d / lens[i]!;
      return {
        x: path[i]!.x + (path[i + 1]!.x - path[i]!.x) * f,
        y: path[i]!.y + (path[i + 1]!.y - path[i]!.y) * f,
      };
    }
    d -= lens[i]!;
  }
  return path[path.length - 1]!;
}

/**
 * A flat, printed-diagram view of the payment flow: client, gateway, three provider boxes and the
 * ledger rule. Payments are dots travelling along ruled routes. Providers show a success bar and
 * circuit state, and an open breaker hatches the box.
 */
export class FlowView {
  private ctx: CanvasRenderingContext2D;
  private dots: Dot[] = [];
  private crosses: Cross[] = [];
  private pulse = [0, 0, 0];
  private gatePulse = 0;
  private ledgerPulse = 0;
  private last = performance.now();
  private raf = 0;
  private dpr = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private view: () => View,
    private reduced: boolean,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) cancelAnimationFrame(this.raf);
      else {
        this.last = performance.now();
        this.loop();
      }
    });
    this.loop();
  }

  private resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  private provLeft(i: number): Pt {
    return { x: BOX.x, y: PROV_Y[i]! };
  }
  private provRight(i: number): Pt {
    return { x: BOX.x + BOX.w, y: PROV_Y[i]! };
  }

  handle(e: PayEvent) {
    if (this.reduced) return;
    switch (e.type) {
      case "routed": {
        const i = e.provider - 1;
        const jitter = (Math.random() - 0.5) * 18;
        const via = { x: 400, y: PROV_Y[i]! + jitter * 0.3 };
        this.dots.push({
          kind: "pay",
          path: [{ x: CLIENT.x + 16, y: CLIENT.y + jitter }, { x: GATE.x - GATE.w / 2, y: GATE.y + jitter }, { x: GATE.x + GATE.w / 2, y: GATE.y + jitter }, via, this.provLeft(i)],
          t: 0,
          dur: 1.25,
          color: PROVIDER_INK[i]!,
        });
        this.gatePulse = Math.min(1, this.gatePulse + 0.1);
        break;
      }
      case "settled": {
        const i = e.provider - 1;
        this.pulse[i] = 1;
        const y = 70 + Math.random() * 300;
        this.dots.push({
          kind: "ledger",
          path: [this.provRight(i), { x: LEDGER_X - 40, y: PROV_Y[i]! }, { x: LEDGER_X, y }],
          t: 0,
          dur: 0.9,
          color: INK,
        });
        break;
      }
      case "attemptFailed": {
        const i = e.provider - 1;
        this.crosses.push({
          at: { x: BOX.x + 6, y: PROV_Y[i]! + (Math.random() - 0.5) * 40 },
          t: 0,
          color: e.kind === "timeout" ? PROVIDER_INK[2]! : BAD,
          size: 9,
        });
        break;
      }
      case "replayed": {
        const j = (Math.random() - 0.5) * 24;
        this.dots.push({
          kind: "replay",
          path: [{ x: CLIENT.x + 16, y: CLIENT.y + j }, { x: GATE.x - GATE.w / 2, y: GATE.y + j }, { x: CLIENT.x + 16, y: CLIENT.y + j }],
          t: 0,
          dur: 0.9,
          color: INK,
        });
        break;
      }
      case "failed":
      case "unknown":
        this.crosses.push({
          at: { x: GATE.x + GATE.w / 2 + 10, y: GATE.y + (Math.random() - 0.5) * 60 },
          t: 0,
          color: e.type === "failed" ? BAD : PROVIDER_INK[2]!,
          size: 14,
        });
        break;
      default:
        break;
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.step(dt);
    this.draw();
  };

  private step(dt: number) {
    for (const d of this.dots) d.t += dt / d.dur;
    for (const d of this.dots) {
      if (d.t >= 1 && d.kind === "ledger") this.ledgerPulse = Math.min(1, this.ledgerPulse + 0.06);
    }
    this.dots = this.dots.filter((d) => d.t < 1);
    for (const c of this.crosses) c.t += dt / 0.8;
    this.crosses = this.crosses.filter((c) => c.t < 1);
    this.pulse = this.pulse.map((p) => p * Math.exp(-dt * 6));
    this.gatePulse *= Math.exp(-dt * 6);
    this.ledgerPulse *= Math.exp(-dt * 4);
  }

  private draw() {
    const { ctx, canvas } = this;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const s = Math.min(cw / W, ch / H);
    ctx.setTransform(s, 0, 0, s, (cw - W * s) / 2, (ch - H * s) / 2);

    const v = this.view();
    ctx.lineJoin = "round";

    // routes
    ctx.strokeStyle = RULE;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(CLIENT.x + 16, CLIENT.y);
    ctx.lineTo(GATE.x - GATE.w / 2, GATE.y);
    ctx.stroke();
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(GATE.x + GATE.w / 2, GATE.y);
      ctx.lineTo(400, GATE.y);
      ctx.lineTo(400, PROV_Y[i]!);
      ctx.lineTo(BOX.x, PROV_Y[i]!);
      ctx.stroke();
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(BOX.x + BOX.w, PROV_Y[i]!);
      ctx.lineTo(LEDGER_X - 40, PROV_Y[i]!);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // client
    ctx.fillStyle = INK;
    ctx.fillRect(CLIENT.x - 6, CLIENT.y - 6, 12, 12);
    this.label("CLIENT", CLIENT.x, CLIENT.y + 30, "center");

    // gateway
    ctx.fillStyle = "rgba(18,24,31,0.04)";
    ctx.fillRect(GATE.x - GATE.w / 2, GATE.y - GATE.h / 2, GATE.w, GATE.h);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5 + this.gatePulse * 2.5;
    ctx.strokeRect(GATE.x - GATE.w / 2, GATE.y - GATE.h / 2, GATE.w, GATE.h);
    ctx.lineWidth = 1;
    for (let k = -3; k <= 3; k++) {
      ctx.beginPath();
      ctx.moveTo(GATE.x - GATE.w / 2 + 12, GATE.y + k * 18);
      ctx.lineTo(GATE.x + GATE.w / 2 - 12, GATE.y + k * 18);
      ctx.strokeStyle = RULE;
      ctx.stroke();
    }
    this.label("GATEWAY", GATE.x, GATE.y + GATE.h / 2 + 24, "center");

    // providers
    v.providers.forEach((p, i) => {
      const y = PROV_Y[i]!;
      const top = y - BOX.h / 2;
      const open = p.circuit === "open";
      const color = PROVIDER_INK[i]!;
      ctx.save();
      ctx.beginPath();
      ctx.rect(BOX.x, top, BOX.w, BOX.h);
      ctx.fillStyle = "#f3f5ef";
      ctx.fill();
      if (open) {
        ctx.clip();
        ctx.strokeStyle = "rgba(194,59,34,0.35)";
        ctx.lineWidth = 1.2;
        for (let x = BOX.x - BOX.h; x < BOX.x + BOX.w; x += 9) {
          ctx.beginPath();
          ctx.moveTo(x, top + BOX.h);
          ctx.lineTo(x + BOX.h, top);
          ctx.stroke();
        }
      }
      ctx.restore();
      ctx.strokeStyle = open ? BAD : color;
      ctx.lineWidth = 1.6 + this.pulse[i]! * 3;
      ctx.strokeRect(BOX.x, top, BOX.w, BOX.h);

      ctx.fillStyle = color;
      ctx.font = '700 19px Archivo, "Helvetica Neue", sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(p.name.toUpperCase(), BOX.x + 14, top + 28);
      ctx.fillStyle = open ? BAD : p.circuit === "half-open" ? PROVIDER_INK[2]! : DIM;
      ctx.font = '500 14px "IBM Plex Mono", monospace';
      ctx.textAlign = "right";
      ctx.fillText(open ? "OPEN" : p.circuit === "half-open" ? "PROBE" : "CLOSED", BOX.x + BOX.w - 14, top + 25);

      // success bar
      const bx = BOX.x + 14;
      const bw = BOX.w - 28;
      const by = top + 44;
      ctx.fillStyle = "rgba(18,24,31,0.12)";
      ctx.fillRect(bx, by, bw, 6);
      ctx.fillStyle = open ? BAD : color;
      ctx.fillRect(bx, by, bw * Math.max(0, Math.min(1, p.successRate)), 6);
      ctx.fillStyle = INK;
      ctx.font = '500 15px "IBM Plex Mono", monospace';
      ctx.textAlign = "left";
      ctx.fillText(`${Math.round(p.successRate * 100)}% ok`, bx, top + 66);
    });

    // ledger rule with tally ticks
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5 + this.ledgerPulse * 2.5;
    ctx.beginPath();
    ctx.moveTo(LEDGER_X, 40);
    ctx.lineTo(LEDGER_X, 400);
    ctx.stroke();
    ctx.lineWidth = 1;
    for (let y = 40; y <= 400; y += 12) {
      ctx.beginPath();
      ctx.moveTo(LEDGER_X, y);
      ctx.lineTo(LEDGER_X + (y % 60 === 40 ? 10 : 5), y);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(LEDGER_X - 14, 220);
    ctx.rotate(-Math.PI / 2);
    this.label("LEDGER", 0, 0, "center");
    ctx.restore();

    // dots
    for (const d of this.dots) {
      const p = along(d.path, ease(Math.min(d.t, 1)));
      const a = Math.min(1, d.t * 8) * (1 - Math.max(0, (d.t - 0.88) / 0.12));
      ctx.globalAlpha = a;
      if (d.kind === "replay") {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, d.kind === "ledger" ? 3.2 : 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // failure crosses
    ctx.lineWidth = 2.2;
    for (const c of this.crosses) {
      ctx.globalAlpha = 1 - c.t;
      ctx.strokeStyle = c.color;
      const r = c.size * (0.7 + c.t * 0.5);
      ctx.beginPath();
      ctx.moveTo(c.at.x - r, c.at.y - r);
      ctx.lineTo(c.at.x + r, c.at.y + r);
      ctx.moveTo(c.at.x + r, c.at.y - r);
      ctx.lineTo(c.at.x - r, c.at.y + r);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private label(text: string, x: number, y: number, align: CanvasTextAlign) {
    const { ctx } = this;
    ctx.fillStyle = DIM;
    ctx.font = '600 13px Archivo, "Helvetica Neue", sans-serif';
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "2px";
    ctx.fillText(text, x, y);
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";
  }
}
