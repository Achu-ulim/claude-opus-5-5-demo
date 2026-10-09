// Ghost laps: the player's best lap on each track, sampled every 50 ms (position and heading), saved compressed in
// localStorage, and replayed as a see-through car in "Race the ghost" time trials. The ghost is not a racer, so
// nothing can hit it.
import { CARS, buildCar } from './carModel.js';
import { wrapAngle } from './util.js';

const KEY = 'feiche3d.ghosts.v1';
export const GHOST_DT = 0.05;
const QP = 50; // positions in 2 cm steps
const QH = 1000; // heading in milliradians

// samples [x, y, z, h, x, y, z, h, ...] → the first sample as integers plus base64 of Int16 deltas, deflated when the browser can
async function encode(s) {
  const n = s.length / 4;
  const q = new Int32Array(s.length);
  let u = s[3];
  for (let i = 0; i < n; i++) {
    if (i) u += wrapAngle(s[i * 4 + 3] - s[i * 4 - 1]); // heading unwrapped, so its deltas stay small
    q[i * 4] = Math.round(s[i * 4] * QP);
    q[i * 4 + 1] = Math.round(s[i * 4 + 1] * QP);
    q[i * 4 + 2] = Math.round(s[i * 4 + 2] * QP);
    q[i * 4 + 3] = Math.round(u * QH);
  }
  const d = new Int16Array(Math.max(0, s.length - 4));
  for (let k = 4; k < s.length; k++) d[k - 4] = q[k] - q[k - 4];
  let bytes = new Uint8Array(d.buffer);
  const z = typeof CompressionStream === 'function';
  if (z) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { first: [...q.subarray(0, 4)], z, d: btoa(bin) };
}

async function decode(g) {
  let bytes = Uint8Array.from(atob(g.d), (c) => c.charCodeAt(0));
  if (g.z) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  const d = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const q = [...g.first];
  const s = new Float32Array(d.length + 4);
  for (let k = 0; k < 4; k++) s[k] = q[k] / (k === 3 ? QH : QP);
  for (let k = 0; k < d.length; k++) {
    const c = k % 4;
    q[c] += d[k];
    s[k + 4] = q[c] / (c === 3 ? QH : QP);
  }
  return s;
}

export class Ghosts {
  constructor(game) {
    this.game = game;
    try { this.store = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { this.store = {}; }
    this.cache = {}; // decoded laps by track
    this.buf = [];
    this.next = 0;
  }

  // saved ghost for a track: { t (lap time), car, look }, or undefined
  best(mapId) { return this.store[mapId]; }

  // decoded samples for a track's ghost, or null
  async load(mapId) {
    const g = this.store[mapId];
    if (!g) return null;
    if (!this.cache[mapId]) {
      try { this.cache[mapId] = { ...g, s: await decode(g) }; } catch { return null; }
    }
    return this.cache[mapId];
  }

  // ---------- Recording: one sample per 50 ms of the current lap ----------
  startLap() {
    this.buf = [];
    this.next = 0;
  }

  sample(P, lapT) {
    while (lapT >= this.next) {
      this.buf.push(P.x, P.y, P.z, P.h);
      this.next += GHOST_DT;
    }
  }

  // a lap is done: keep it if it's this track's fastest. Returns true when it beat the ghost raced against.
  lapDone(mapId, t, car, look) {
    const s = this.buf;
    this.startLap();
    // only whole laps, recorded from the line (not one joined halfway)
    if (s.length / 4 < (t / GHOST_DT) * 0.9) return false;
    const old = this.store[mapId];
    if (old && old.t <= t) return false;
    const ghost = { t, car, look: look || {} };
    this.cache[mapId] = { ...ghost, s: Float32Array.from(s) };
    encode(s).then((enc) => {
      this.store[mapId] = { ...ghost, ...enc };
      try { localStorage.setItem(KEY, JSON.stringify(this.store)); } catch { /* storage full: the ghost lives until reload */ }
    });
    return true;
  }

  // ---------- Playback ----------
  // a see-through copy of the ghost's car, outside the racers so nothing collides with it
  show(ghost) {
    this.hide();
    if (!ghost) return;
    const m = buildCar(CARS[ghost.car] || CARS[0], { look: ghost.look });
    m.traverse((o) => {
      if (!o.material) return;
      for (const mat of [].concat(o.material)) Object.assign(mat, { transparent: true, opacity: Math.min(mat.opacity ?? 1, 0.38), depthWrite: false });
    });
    if (m.userData.tag) m.userData.tag.visible = false;
    m.userData.shield.visible = false;
    m.renderOrder = 2;
    this.model = m;
    this.lap = ghost;
    this.game.scene.add(m);
  }

  hide() {
    if (!this.model) return;
    this.game.scene.remove(this.model);
    this.model.traverse((o) => { if (o.material && !o.isSprite) for (const mat of [].concat(o.material)) mat.dispose(); });
    this.model = null;
    this.lap = null;
  }

  // put the ghost where it was at this point of its lap
  place(lapT) {
    if (!this.model) return;
    const s = this.lap.s, n = s.length / 4;
    const f = Math.max(0, lapT / GHOST_DT);
    const i = Math.min(n - 2, Math.floor(f)), a = Math.min(1, f - i);
    const k = i * 4;
    const lerp = (c) => s[k + c] + (s[k + 4 + c] - s[k + c]) * a;
    this.model.position.set(lerp(0), lerp(1), lerp(2));
    this.model.rotation.set(0, lerp(3), 0);
  }
}
