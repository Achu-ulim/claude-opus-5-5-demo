// Another player's car, driven by the snapshots their game sends.
// Snapshots are ~70 ms apart and arrive a network trip late, and at racing speed that is several car lengths.
// So the car is predicted forward to the current server time in track space (distance along the centerline + lane):
// that follows the bends instead of shooting off along a tangent. Corrections are blended out over a few frames.
import { clamp, damp, wrapAngle } from './util.js';
import { TUNE, updateFlames, brakeLights } from './vehicle.js';
import { decodeSnap, F } from './netproto.js';

const MAX_AHEAD = 0.5; // s of prediction at most: a racer who goes silent stops rather than driving on blind
export const LAGGING = 2.5; // s without news: shown as lagging, and no longer solid
const BLEND = 9; // 1/s: how fast a correction to the predicted position fades out
const SNAP_DIST = 12; // m: a correction bigger than this (reset, respawn) jumps instead of sliding

export class RemoteCar {
  constructor(track, model, name, netId, tune = {}) {
    this.track = track;
    this.model = model;
    this.name = name;
    this.netId = netId;
    this.id = 'net:' + netId;
    this.T = { ...TUNE, ...tune };
    this.isPlayer = false;
    this.isRemote = true;
    this.enginePitch = 0.93 + Math.random() * 0.14;
    this.snap = null;
    this.fresh = false;
    this.err = { x: 0, y: 0, z: 0, h: 0 };
    this.x = this.y = this.z = this.h = this.m = this.s = this.vy = this.steer = 0;
    this.d = 0;
    this.lat = 0;
    this.hint = 0;
    this.lapsDone = -1;
    this.progress = 0;
    this.lag = 0;
    this.gone = false;
    this.drifting = false;
    this.driftDir = 0;
    this.airborne = false;
    this.nitroTime = 0;
    this.boost = false;
    this.braking = false;
    this.shield = 0;
    this.spin = 0;
    this.ghost = 0;
    this.magnet = 0;
    this.wreck = 0;
    this.pitchVis = 0;
    this.rollVis = 0;
    this._s = {};
  }

  // on the grid until the first snapshot arrives
  place(d, lat) {
    const s = this.track.sample(d, this._s);
    this.x = s.x + s.rx * lat;
    this.z = s.z + s.rz * lat;
    this.y = s.y + lat * Math.sin(s.bank);
    this.h = this.m = this.trackHd = s.hd;
    this.d = s.d;
    this.lat = lat;
    this.hint = s.i;
    this.progress = -this.track.length + s.d;
  }

  push(arr) {
    const p = decodeSnap(arr);
    if (this.snap && p.t <= this.snap.t) return; // late or duplicate
    // motion in track space: speed along the centerline and across it, headings relative to it
    const hd = this.track.sample(p.d, this._s).hd;
    p.va = p.s * Math.cos(p.m - hd);
    p.vl = -p.s * Math.sin(p.m - hd);
    p.hOff = wrapAngle(p.h - hd);
    p.mOff = wrapAngle(p.m - hd);
    this.fresh = !!this.snap; // the first one places the car outright
    this.snap = p;
  }

  predict(now) {
    const p = this.snap, tr = this.track;
    const dt = clamp((now - p.t) / 1000, 0, MAX_AHEAD);
    const hw = tr.halfW - 1.1;
    // lane changes ease off rather than carrying on into the wall
    const lat = clamp(p.lat + (p.vl * (1 - Math.exp(-3 * dt))) / 3, -hw, hw);
    const s = tr.sample(p.d + p.va * dt, this._s);
    const gy = s.y + lat * Math.sin(s.bank);
    let y = gy, air = false;
    if (p.flags & F.AIR) {
      y = p.y + p.vy * dt - 0.5 * TUNE.gravity * dt * dt;
      if (y > gy) air = true;
      else y = gy;
    }
    return {
      x: s.x + s.rx * lat, y, z: s.z + s.rz * lat, air, d: s.d, lat, i: s.i, hd: s.hd, bank: s.bank, dt,
      h: p.flags & F.SPIN ? p.h + 9 * dt : s.hd + p.hOff,
      m: s.hd + p.mOff,
    };
  }

  // pushed out of another car on this screen; the offset fades like any other correction, while the car's own
  // game (which sees the same contact) moves it for real
  nudge(dx, dz) {
    this.x += dx;
    this.z += dz;
    this.err.x += dx;
    this.err.z += dz;
  }

  // once per frame, now = server time (ms)
  update(dt, now) {
    const p = this.snap;
    if (!p) return;
    const q = this.predict(now);
    if (this.fresh) {
      this.fresh = false;
      const ex = this.x - q.x, ez = this.z - q.z;
      if (ex * ex + ez * ez > SNAP_DIST * SNAP_DIST) this.err = { x: 0, y: 0, z: 0, h: 0 };
      else this.err = { x: ex, y: this.y - q.y, z: ez, h: wrapAngle(this.h - q.h) };
    }
    const k = Math.exp(-BLEND * dt);
    const e = this.err;
    e.x *= k; e.y *= k; e.z *= k; e.h *= k;
    this.x = q.x + e.x;
    this.y = q.y + e.y;
    this.z = q.z + e.z;
    this.h = q.h + e.h;
    this.m = q.m + e.h;
    this.d = q.d;
    this.lat = q.lat;
    this.hint = q.i;
    this.trackHd = q.hd;
    this.airborne = q.air;
    this.s = p.s;
    this.vy = p.vy;
    this.steer = damp(this.steer, p.steer, 12, dt);
    const f = p.flags;
    this.drifting = !!(f & F.DRIFT);
    this.driftDir = f & F.LEFT ? 1 : -1;
    this.nitroTime = f & F.NITRO ? 1 : 0;
    this.boost = !!(f & F.BOOST);
    this.braking = !!(f & F.BRAKE);
    this.shield = f & F.SHIELD ? 1 : 0;
    this.spin = f & F.SPIN ? 1 : 0;
    this.magnet = f & F.MAGNET ? 1 : 0;
    this.wreck = f & F.WRECK ? 1 : 0;
    this.lag = (now - p.t) / 1000;
    // wrecked, just respawned, lagging or gone: drive through it
    this.ghost = f & F.GHOST || this.lag > LAGGING || this.gone ? 1 : 0;
    this.lapsDone = p.laps;
    this.progress = p.laps * this.track.length + p.d + p.va * q.dt;
  }

  syncModel(dt) {
    const mdl = this.model;
    const u = mdl.userData;
    const tr = this.track;
    const i = this.hint;
    mdl.visible = !this.gone;
    mdl.position.set(this.x, this.y, this.z);
    const rel = this.h - tr.hd[i];
    const pitchT = this.airborne ? clamp(-this.vy * 0.012, -0.3, 0.3) : -Math.atan(tr.slope[i] * Math.cos(rel));
    this.pitchVis = damp(this.pitchVis, pitchT, 10, dt);
    this.rollVis = damp(this.rollVis, -tr.bank[i] * Math.cos(rel), 10, dt);
    mdl.rotation.set(this.pitchVis, this.h, this.rollVis, 'YXZ');
    const sp = Math.abs(this.s);
    const lean = this.drifting ? this.driftDir * 0.07 : this.steer * 0.045 * clamp(sp / 30, 0, 1);
    u.root.rotation.z = damp(u.root.rotation.z, lean, 8, dt);
    for (const w of u.wheels) {
      w.spin.rotation.x += (this.s * dt) / w.r;
      if (w.front) w.steer.rotation.y = this.drifting ? -this.driftDir * 0.3 : this.steer * 0.38;
    }
    updateFlames(u, this.nitroTime > 0, this.boost);
    brakeLights(u, this.braking, sp);
    u.shield.visible = this.shield > 0;
    this.fade(this.lag > LAGGING);
  }

  // a racer whose updates have stopped isn't solid (it may really be somewhere else): show it see-through until they're back
  fade(on) {
    if (on === !!this.faded) return;
    this.faded = on;
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.userData.fadeKeep === undefined) m.userData.fadeKeep = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
        const k = m.userData.fadeKeep;
        if (k.transparent) continue; // flames, glow and the shield are see-through already
        m.transparent = on;
        m.opacity = on ? 0.3 : k.opacity;
        m.depthWrite = on ? false : k.depthWrite;
        m.needsUpdate = true;
      }
    });
  }
}
