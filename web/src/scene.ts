import * as THREE from "three";
import type { PayEvent } from "../../shared/types.ts";

/** Worker identity colours, plus coral reserved for anything that fails or is rejected. */
export const WORKER_COLORS = [0x5b7cff, 0x3fd0b0, 0xffb547].map((c) => new THREE.Color(c));
const BAD = new THREE.Color(0xff5c4d);
const BONE = new THREE.Color(0xe9e4d8);

const CLIENT = new THREE.Vector3(-6, 0, 0);
const LEDGER = new THREE.Vector3(12.5, 0, 0);
const LEDGER_COLOR = new THREE.Color(0xf5efe0);
const GATE = new THREE.Vector3(0, 0, 0);
const WORKER_POS = [0, 1, 2].map((i) => {
  const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
  return new THREE.Vector3(8, Math.cos(a) * 3, Math.sin(a) * 3);
});

/** Camera stops, one per chapter. The scroll position interpolates between them. */
const STOPS = [
  { pos: new THREE.Vector3(-3, 1.5, 26), look: new THREE.Vector3(1, 0, 0) },
  { pos: new THREE.Vector3(2, 3, 20), look: new THREE.Vector3(3.5, 0, 0) },
  { pos: new THREE.Vector3(9, 4, 15), look: new THREE.Vector3(8, 0, 0) },
  { pos: new THREE.Vector3(13, 1.5, 9.5), look: new THREE.Vector3(8, 0, 0) },
  { pos: new THREE.Vector3(-6.5, 1.8, 9), look: new THREE.Vector3(-1, 0, 0) },
];

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  uniform float uUseTint;
  uniform vec3 uTint;
  uniform float uAlphaMul;
  varying float vA;
  varying vec3 vC;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(aSize * uScale / -mv.z, 1.0);
    gl_Position = projectionMatrix * mv;
    vA = aAlpha * uAlphaMul;
    vC = mix(aColor, uTint, uUseTint);
  }
`;
const FRAG = /* glsl */ `
  varying float vA;
  varying vec3 vC;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.08, d);
    gl_FragColor = vec4(vC, a * vA);
  }
`;

function material(uScale: { value: number }, tint?: THREE.Color) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uScale,
      uUseTint: { value: tint ? 1 : 0 },
      uTint: { value: tint ? tint.clone() : new THREE.Color(1, 1, 1) },
      uAlphaMul: { value: 1 },
    },
  });
}

function gauss() {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

function pointCloud(
  positions: Float32Array,
  color: THREE.Color,
  size: number,
  alpha: number,
  mat: THREE.ShaderMaterial,
) {
  const n = positions.length / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const alphas = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    colors.set([color.r, color.g, color.b], i * 3);
    sizes[i] = size * (0.6 + Math.random() * 0.8);
    alphas[i] = alpha * (0.4 + Math.random() * 0.6);
  }
  g.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  g.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  g.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

const POOL = 2400;
const FLOW = 0;
const TO_GATE_SHATTER = 1;
const SHARD = 2;
const REPLAY = 3; // client -> gateway -> back to client: the gateway answers from the idempotency store
const LEDGER_FLY = 4; // provider -> ledger once a payment is captured

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (t: number) => t * t * (3 - 2 * t);

export class PaymentScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  private uScale = { value: 400 };
  private clock = new THREE.Clock();

  // request particle pool
  private geom = new THREE.BufferGeometry();
  private pos = new Float32Array(POOL * 3);
  private col = new Float32Array(POOL * 3);
  private size = new Float32Array(POOL);
  private alpha = new Float32Array(POOL);
  private active = new Uint8Array(POOL);
  private kind = new Uint8Array(POOL);
  private t = new Float32Array(POOL);
  private dur = new Float32Array(POOL);
  private A = new Float32Array(POOL * 3);
  private C = new Float32Array(POOL * 3);
  private V = new Float32Array(POOL * 3);
  private baseSize = new Float32Array(POOL);
  private phase = new Float32Array(POOL);
  private cursor = 0;

  private dust: THREE.Points;
  private ring: THREE.Points;
  private ringPulse = 0;
  private ledger!: THREE.Points;
  private ledgerPulse = 0;
  private clusters: { obj: THREE.Points; mat: THREE.ShaderMaterial; expand: number; target: number; pulse: number; dead: boolean; health: number }[] = [];

  private stopIndex = 0;
  private smoothStop = 0;
  private pointer = new THREE.Vector2();
  private reduced: boolean;
  private raf = 0;
  private running = true;

  constructor(canvas: HTMLCanvasElement, reducedMotion: boolean) {
    this.reduced = reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x07080b, 1);

    // dust: a sparse tunnel around the x axis so camera moves read as travel
    const dustN = 3200;
    const dp = new Float32Array(dustN * 3);
    for (let i = 0; i < dustN; i++) {
      const r = 2 + Math.pow(Math.random(), 0.7) * 22;
      const th = Math.random() * Math.PI * 2;
      dp.set([-16 + Math.random() * 40, Math.cos(th) * r, Math.sin(th) * r], i * 3);
    }
    this.dust = pointCloud(dp, BONE, 0.11, 0.6, material(this.uScale));
    this.scene.add(this.dust);

    // gateway ring
    const ringN = 900;
    const rp = new Float32Array(ringN * 3);
    for (let i = 0; i < ringN; i++) {
      const th = Math.random() * Math.PI * 2;
      const r = 1.7 + gauss() * 0.09;
      rp.set([gauss() * 0.16, Math.cos(th) * r, Math.sin(th) * r], i * 3);
    }
    this.ring = pointCloud(rp, BONE, 0.2, 1, material(this.uScale));
    this.ring.position.copy(GATE);
    this.scene.add(this.ring);

    // ledger: captured payments end here
    const lp = new Float32Array(420 * 3);
    for (let i = 0; i < 420; i++) lp.set([LEDGER.x + gauss() * 0.12, (Math.random() - 0.5) * 6, gauss() * 0.12], i * 3);
    this.ledger = pointCloud(lp, LEDGER_COLOR, 0.14, 0.9, material(this.uScale));
    this.scene.add(this.ledger);

    // client source: a loose knot of points to the left
    const cp = new Float32Array(500 * 3);
    for (let i = 0; i < 500; i++) cp.set([CLIENT.x + gauss() * 0.7, gauss() * 1.1, gauss() * 1.1], i * 3);
    this.scene.add(pointCloud(cp, BONE, 0.2, 0.9, material(this.uScale)));

    // worker clusters
    WORKER_POS.forEach((p, i) => {
      const n = 520;
      const wp = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        const v = new THREE.Vector3(gauss(), gauss(), gauss()).normalize().multiplyScalar(0.9 + gauss() * 0.06);
        wp.set([v.x, v.y, v.z], k * 3);
      }
      const mat = material(this.uScale, WORKER_COLORS[i]);
      const obj = pointCloud(wp, WORKER_COLORS[i]!, 0.2, 1, mat);
      obj.position.copy(p);
      this.scene.add(obj);
      this.clusters.push({ obj, mat, expand: 1, target: 1, pulse: 0, dead: false, health: 1 });
    });

    // request particles
    this.geom.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geom.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    this.geom.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    this.geom.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));
    const pool = new THREE.Points(this.geom, material(this.uScale));
    pool.frustumCulled = false;
    this.scene.add(pool);

    addEventListener("resize", this.resize);
    addEventListener("pointermove", this.onPointer);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
    this.camera.position.copy(STOPS[0]!.pos);
    this.loop();
  }

  /** Fractional chapter index: 0 = hero, 1 = balance, ... driven by scroll position. */
  setStop(i: number) {
    this.stopIndex = Math.min(STOPS.length - 1, Math.max(0, i));
  }

  private resize = () => {
    const w = innerWidth;
    const h = innerHeight;
    const dpr = Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // narrow screens: pull the camera back via a wider field of view instead of cropping the scene
    this.camera.fov = w / h < 0.8 ? 70 : 45;
    // on wide screens push the scene right so it clears the text panel
    if (w / h > 1) this.camera.setViewOffset(w, h, -w * 0.16, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.uScale.value = h * dpr * 0.5;
  };

  private onPointer = (e: PointerEvent) => {
    this.pointer.set((e.clientX / innerWidth - 0.5) * 2, (e.clientY / innerHeight - 0.5) * 2);
  };

  private onVisibility = () => {
    this.running = !document.hidden;
    if (this.running) {
      this.clock.getDelta();
      this.loop();
    } else cancelAnimationFrame(this.raf);
  };

  // ---- particles --------------------------------------------------------------------------
  private slot(): number {
    for (let n = 0; n < POOL; n++) {
      const i = (this.cursor + n) % POOL;
      if (!this.active[i]) {
        this.cursor = (i + 1) % POOL;
        return i;
      }
    }
    return -1;
  }

  private spawn(kind: number, from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, dur: number, size: number) {
    const i = this.slot();
    if (i < 0) return -1;
    this.active[i] = 1;
    this.kind[i] = kind;
    this.t[i] = 0;
    this.dur[i] = dur;
    this.A.set([from.x, from.y, from.z], i * 3);
    this.C.set([to.x, to.y, to.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.baseSize[i] = size;
    this.phase[i] = Math.random() * 6.28;
    return i;
  }

  private shards(at: THREE.Vector3, n: number, speed: number, color: THREE.Color = BAD) {
    for (let k = 0; k < n; k++) {
      const i = this.spawn(SHARD, at, at, color, 0.55 + Math.random() * 0.4, 0.3);
      if (i < 0) return;
      const v = new THREE.Vector3(gauss(), gauss(), gauss()).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      this.V.set([v.x, v.y, v.z], i * 3);
    }
  }

  handle(e: PayEvent) {
    switch (e.type) {
      case "state":
      case "tick":
        e.providers.forEach((p, i) => {
          const c = this.clusters[i];
          if (c) c.health = Math.min(1, Math.max(0, p.score));
          this.setDead(i, p.circuit === "open", e.type === "tick");
        });
        break;
      case "routed": {
        const target = WORKER_POS[e.provider - 1];
        if (!target) break;
        const jitter = new THREE.Vector3(gauss() * 0.5, gauss() * 0.5, gauss() * 0.5);
        const from = CLIENT.clone().add(jitter);
        this.spawn(FLOW, from, target.clone().add(jitter.multiplyScalar(0.8)), WORKER_COLORS[e.provider - 1]!, 1.3, e.attempt > 0 ? 0.9 : 0.7);
        this.ringPulse = Math.min(1, this.ringPulse + 0.08);
        break;
      }
      case "attemptFailed": {
        const p = WORKER_POS[e.provider - 1];
        if (p) this.shards(p, e.kind === "timeout" ? 4 : 7, 3, e.kind === "timeout" ? WORKER_COLORS[2]! : BAD);
        break;
      }
      case "settled": {
        const c = this.clusters[e.provider - 1];
        const p = WORKER_POS[e.provider - 1];
        if (c) c.pulse = Math.min(0.3, c.pulse + 0.05);
        if (p) this.spawn(LEDGER_FLY, p, LEDGER.clone().add(new THREE.Vector3(0, (Math.random() - 0.5) * 4, 0)), LEDGER_COLOR, 0.9, 0.45);
        break;
      }
      case "replayed":
        this.spawn(REPLAY, CLIENT.clone().add(new THREE.Vector3(gauss() * 0.5, gauss() * 0.5, gauss() * 0.5)), GATE, BONE, 0.9, 0.5);
        break;
      case "failed":
        this.shards(GATE, 14, 5);
        break;
      case "unknown":
        this.shards(GATE, 10, 4, WORKER_COLORS[2]!);
        break;
      default:
        break;
    }
  }

  private setDead(i: number, dead: boolean, animate: boolean) {
    const c = this.clusters[i];
    if (!c || c.dead === dead) return;
    c.dead = dead;
    c.target = dead ? 3.2 : 1;
    if (!animate) c.expand = c.target;
    if (dead && animate) this.shards(WORKER_POS[i]!, 40, 6);
    if (!dead && animate) c.pulse = 0.5;
  }

  // ---- frame ------------------------------------------------------------------------------
  private loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;

    // camera: ease toward the scroll-selected stop and blend between neighbours
    this.smoothStop += (this.stopIndex - this.smoothStop) * (this.reduced ? 1 : 1 - Math.exp(-dt * 5));
    const lo = Math.floor(this.smoothStop);
    const hi = Math.min(STOPS.length - 1, lo + 1);
    const f = smooth(this.smoothStop - lo);
    const a = STOPS[lo]!;
    const b = STOPS[hi]!;
    const wantPos = a.pos.clone().lerp(b.pos, f);
    const look = a.look.clone().lerp(b.look, f);
    if (!this.reduced) {
      wantPos.x += this.pointer.x * 0.8 + Math.sin(time * 0.15) * 0.6;
      wantPos.y += -this.pointer.y * 0.5;
    }
    this.camera.position.lerp(wantPos, this.reduced ? 1 : 1 - Math.exp(-dt * 4));
    this.camera.lookAt(look);

    if (!this.reduced) {
      this.dust.rotation.x += dt * 0.03;
      this.ring.rotation.x += dt * 0.35;
    }
    this.ledgerPulse *= Math.exp(-dt * 5);
    this.ledger.scale.set(1 + this.ledgerPulse * 0.8, 1, 1 + this.ledgerPulse * 0.8);
    this.ringPulse *= Math.exp(-dt * 6);
    this.ring.scale.setScalar(1 + this.ringPulse * 0.35);

    for (const c of this.clusters) {
      c.expand += (c.target - c.expand) * (1 - Math.exp(-dt * (c.dead ? 3 : 4)));
      c.pulse *= Math.exp(-dt * 7);
      c.obj.scale.setScalar(c.expand * (1 + c.pulse));
      if (!this.reduced) c.obj.rotation.y += dt * 0.25;
      const tint = c.mat.uniforms.uTint!.value as THREE.Color;
      const goal = c.dead ? BAD : WORKER_COLORS[this.clusters.indexOf(c)]!;
      tint.lerp(goal, 1 - Math.exp(-dt * 6));
      c.mat.uniforms.uAlphaMul!.value = c.dead ? 0.35 : 0.4 + 0.6 * c.health;
    }

    this.stepParticles(dt, time);
    this.renderer.render(this.scene, this.camera);
  };

  private stepParticles(dt: number, time: number) {
    for (let i = 0; i < POOL; i++) {
      if (!this.active[i]) {
        this.alpha[i] = 0;
        continue;
      }
      this.t[i]! += dt / this.dur[i]!;
      const t = this.t[i]!;
      const k = this.kind[i]!;
      const i3 = i * 3;
      if (k === SHARD) {
        if (t >= 1) {
          this.active[i] = 0;
          this.alpha[i] = 0;
          continue;
        }
        const drag = Math.exp(-dt * 2.2);
        for (let c = 0; c < 3; c++) {
          this.V[i3 + c]! *= drag;
          this.A[i3 + c]! += this.V[i3 + c]! * dt;
          this.pos[i3 + c] = this.A[i3 + c]!;
        }
        this.alpha[i] = 1 - t;
        this.size[i] = this.baseSize[i]!;
        continue;
      }
      const ax = this.A[i3]!;
      const ay = this.A[i3 + 1]!;
      const az = this.A[i3 + 2]!;
      let x: number, y: number, z: number;
      if (k === REPLAY) {
        if (t >= 1) {
          this.active[i] = 0;
          this.alpha[i] = 0;
          continue;
        }
        // out to the gateway and straight back: answered from the idempotency store
        const s = t < 0.5 ? ease(t / 0.5) : 1 - ease((t - 0.5) / 0.5);
        x = ax + (GATE.x - ax) * s;
        y = ay + (GATE.y - ay) * s;
        z = az + (GATE.z - az) * s;
        if (t > 0.45 && t < 0.55) this.ringPulse = Math.min(1, this.ringPulse + 0.02);
      } else if (k === LEDGER_FLY) {
        if (t >= 1) {
          this.active[i] = 0;
          this.alpha[i] = 0;
          this.ledgerPulse = Math.min(1, this.ledgerPulse + 0.04);
          continue;
        }
        const s = ease(t);
        x = ax + (this.C[i3]! - ax) * s;
        y = ay + (this.C[i3 + 1]! - ay) * s;
        z = az + (this.C[i3 + 2]! - az) * s;
      } else if (k === TO_GATE_SHATTER) {
        if (t >= 1) {
          this.active[i] = 0;
          this.alpha[i] = 0;
          this.shards(GATE, 7, 3.5);
          continue;
        }
        const s = ease(t);
        x = ax + (GATE.x - ax) * s;
        y = ay + (GATE.y - ay) * s;
        z = az + (GATE.z - az) * s;
      } else {
        if (t >= 1) {
          this.active[i] = 0;
          this.alpha[i] = 0;
          continue;
        }
        const cx = this.C[i3]!;
        const cy = this.C[i3 + 1]!;
        const cz = this.C[i3 + 2]!;
        if (t < 0.42) {
          const s = ease(t / 0.42);
          x = ax + (GATE.x - ax) * s;
          y = ay + (GATE.y - ay) * s;
          z = az + (GATE.z - az) * s;
        } else {
          const s = ease((t - 0.42) / 0.58);
          x = GATE.x + (cx - GATE.x) * s;
          y = GATE.y + (cy - GATE.y) * s;
          z = GATE.z + (cz - GATE.z) * s;
        }
        if (!this.reduced) {
          const w = Math.sin(this.phase[i]! + time * 5 + t * 10) * 0.06;
          y += w;
          z += w;
        }
      }
      this.pos[i3] = x;
      this.pos[i3 + 1] = y;
      this.pos[i3 + 2] = z;
      this.alpha[i] = Math.min(1, t * 8) * (1 - smooth(Math.max(0, (t - 0.9) / 0.1)));
      this.size[i] = this.baseSize[i]!;
    }
    (this.geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }
}
