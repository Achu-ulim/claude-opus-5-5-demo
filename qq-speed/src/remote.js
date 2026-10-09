// Another player's car, driven by the snapshots their game sends.
// Snapshots are ~70 ms apart and arrive a network trip late, and at racing speed that is several car lengths.
// So the car is predicted forward to the current server time in track space (distance along the centerline + lane):
// that follows the bends instead of shooting off along a tangent. The prediction carries on the car's acceleration
// (read from its last two snapshots), and the car on screen chases it with a critically damped spring along the
// track: its speed changes smoothly instead of surging every time a snapshot lands.
import { clamp, damp, wrapAngle } from './util.js';
import { TUNE, updateFlames, brakeLights } from './vehicle.js';
import { decodeSnap, F } from './netproto.js';

const MAX_AHEAD = 0.5; // s of prediction at most: a racer who goes silent stops rather than driving on blind
export const LAGGING = 2.5; // s without news: shown as lagging, and no longer solid
const BLEND = 9; // 1/s: how fast a sideways push from a collision on this screen fades out
const SNAP_DIST = 12; // m: a correction bigger than this (reset, respawn) jumps instead of sliding
const OMEGA = 6; // 1/s: how tightly the car on screen follows the prediction along the track (no overshoot)
const MAX_ACC = 30; // m/s²: the most acceleration or braking read from two snapshots
const ACC_AHEAD = 0.25; // s: how long that acceleration is assumed to carry on

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
    this.err = { x: 0, z: 0 }; // a push from a collision on this screen, fading out
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
    this.celeb = null; // their victory celebration, played out here by the game (Game.remoteCelebrate)
    this.proj = {};
    this._s = {};
    this.q = {}; // the prediction, reused every frame
    this.ready = false; // the first snapshot places the car outright
    this.dd = 0; // shown distance along the track, its speed, lane and heading offsets from the track
    this.vd = 0;
    this.ld = 0;
    this.hOff = 0;
    this.mOff = 0;
  }

  // on the grid until the first snapshot arrives
  place(d, lat) {
    const s = this.track.sample(d, this._s);
    this.x = s.x + s.rx * lat;
    this.z = s.z + s.rz * lat;
    this.y = s.y + lat * Math.sin(s.bank);
    this.h = this.m = this.trackHd = s.hd;
    this.d = this.dd = s.d;
    this.lat = this.ld = lat;
    this.vd = 0;
    this.hint = s.i;
    this.progress = -this.track.length + s.d;
  }

  push(arr) {
    const p = decodeSnap(arr);
    const prev = this.snap;
    if (prev && p.t <= prev.t) return; // late or duplicate
    // motion in track space: speed along the centerline and across it, headings relative to it
    const hd = this.track.sample(p.d, this._s).hd;
    p.va = p.s * Math.cos(p.m - hd);
    p.vl = -p.s * Math.sin(p.m - hd);
    p.hOff = wrapAngle(p.h - hd);
    p.mOff = wrapAngle(p.m - hd);
    // acceleration along the track from the last two snapshots, lightly smoothed (none after a long gap)
    const gap = prev ? (p.t - prev.t) / 1000 : 0;
    p.a = gap > 0.02 && gap < 0.4 ? clamp((p.va - prev.va) / gap, -MAX_ACC, MAX_ACC) * 0.6 + prev.a * 0.4 : 0;
    this.snap = p;
  }

  // where the car should be now: the last snapshot carried forward along the track, still speeding up or slowing
  // as it was for a moment, then at a steady speed
  predict(now) {
    const p = this.snap, q = this.q;
    const dt = clamp((now - p.t) / 1000, 0, MAX_AHEAD);
    const ta = Math.min(dt, ACC_AHEAD);
    const hw = this.track.halfW - 1.1;
    q.dt = dt;
    q.d = p.d + p.va * dt + p.a * ta * (dt - ta / 2);
    q.v = p.va + p.a * ta;
    q.a = dt < ACC_AHEAD ? p.a : 0;
    // lane changes ease off rather than carrying on into the wall
    q.lat = clamp(p.lat + (p.vl * (1 - Math.exp(-3 * dt))) / 3, -hw, hw);
    return q;
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
    if (!p || this.celeb) return;
    const q = this.predict(now), L = this.track.length;
    let ed = q.d - this.dd;
    ed -= Math.round(ed / L) * L; // the short way round, across the start line
    if (!this.ready || Math.abs(ed) > SNAP_DIST) {
      // first sight of the car, or it reset or respawned: put it there
      this.ready = true;
      this.dd = q.d;
      this.vd = q.v;
      this.ld = q.lat;
      this.hOff = p.hOff;
      this.mOff = p.mOff;
      this.err.x = this.err.z = 0;
      ed = 0;
    }
    // a critically damped spring along the track, fed the predicted acceleration: no surges, no overshoot
    this.vd += (q.a + OMEGA * OMEGA * ed + 2 * OMEGA * (q.v - this.vd)) * dt;
    this.dd = (((this.dd + this.vd * dt) % L) + L) % L;
    this.ld = damp(this.ld, q.lat, 8, dt);
    const kh = 1 - Math.exp(-10 * dt);
    this.hOff += wrapAngle(p.hOff - this.hOff) * kh;
    this.mOff += wrapAngle(p.mOff - this.mOff) * kh;
    const s = this.track.sample(this.dd, this._s);
    const gy = s.y + this.ld * Math.sin(s.bank);
    let y = gy, air = false;
    if (p.flags & F.AIR) {
      y = p.y + p.vy * q.dt - 0.5 * TUNE.gravity * q.dt * q.dt;
      if (y > gy) air = true;
      else y = gy;
    }
    // what's left of a push from a collision on this screen
    const e = this.err, k = Math.exp(-BLEND * dt);
    e.x *= k;
    e.z *= k;
    this.x = s.x + s.rx * this.ld + e.x;
    this.y = y;
    this.z = s.z + s.rz * this.ld + e.z;
    this.h = p.flags & F.SPIN ? p.h + 9 * q.dt : s.hd + this.hOff;
    this.m = s.hd + this.mOff;
    this.d = s.d;
    this.lat = this.ld;
    this.hint = s.i;
    this.trackHd = s.hd;
    this.airborne = air;
    this.s = this.vd; // wheels and engine follow the speed shown, not each snapshot's
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
    this.progress = p.laps * L + p.d + p.va * q.dt;
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
