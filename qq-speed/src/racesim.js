// Formula 1 race simulation: fuel, tyres and damage for every car, and pit stops to put them right.
import { PIT, pitLat } from './pitlane.js';
import { clamp, lerp, wrapAngle } from './util.js';

const FUEL_LAPS = 2.4; // a full tank at racing pace
const TYRE_LAPS = 3.2; // a fresh set, driven cleanly
const RELEASE_SPEED = 30;

export class RaceSim {
  constructor(game, pit, crew) {
    this.g = game;
    this.pit = pit;
    this.crew = crew;
    this.track = game.track;
    this.L = this.track.length;
  }

  setup(racers) {
    for (const r of racers) {
      r.car = { fuel: 1, tyre: 0, wing: 0, engine: 0, susp: 0, pull: Math.random() < 0.5 ? -1 : 1 };
      r.baseT = { ...r.T };
      r.pit = null;
      r.box = false;
      r.stops = 0;
      r.warned = {};
      r.lastU = this.pit.u(r.d ?? 0);
    }
  }

  // how worn tyres, damage and an empty tank change the car
  perf(c) {
    const grip = (c.tyre < 0.6 ? 1 - c.tyre * 0.12 : 0.928 - (c.tyre - 0.6) * 0.8) * (1 - c.wing * 0.25);
    const empty = c.fuel <= 0;
    return {
      vmax: (1 - c.engine * 0.22) * (c.tyre >= 1 ? 0.55 : 1) * (empty ? 0.22 : 1),
      accel: (1 - c.engine * 0.3) * (empty ? 0.3 : 1),
      grip,
      turn: (1 - c.wing * 0.25) * (1 - c.susp * 0.15),
      pull: c.susp * 0.18 * c.pull,
    };
  }

  // before physics: rescale each car's handling from its condition
  pre() {
    for (const r of this.g.racers) {
      if (!r.car) continue;
      const p = this.perf(r.car);
      const B = r.baseT;
      r.T = { ...B, vmax: B.vmax * p.vmax, vmaxNitro: B.vmaxNitro * p.vmax, accel: B.accel * p.accel, nitroAccel: B.nitroAccel * p.accel, grip: B.grip * p.grip, turnRate: B.turnRate * p.turn };
      r.gripMul = p.grip * p.turn;
      r.steerPull = p.pull;
      if (r.isPlayer && r.car.fuel <= 0) r.nitroTime = 0;
    }
  }

  damage(r, amt, part = 'wing') {
    if (!r.car || r.pit) return;
    const c = r.car;
    c[part] = clamp(c[part] + amt, 0, 1);
    if (r.isPlayer) {
      if (part === 'wing' && c.wing >= 0.85 && !r.warned.wingGone) { r.warned.wingGone = true; this.g.hud.message('Front wing broken!', '#ff4b4b'); }
      if (part === 'engine' && c.engine >= 0.6 && !r.warned.engine) { r.warned.engine = true; this.g.hud.message('Engine damage!', '#ff4b4b'); }
    }
    this.visual(r);
    if (c.wing >= 0.95 && c.engine >= 0.95 && c.susp >= 0.95) this.g.retire(r);
  }

  // a broken front wing falls off the car until it's replaced
  visual(r) {
    const w = r.model.userData.wing;
    if (w) for (const m of w) m.visible = r.car.wing < 0.85;
  }

  // after physics
  post(dt) {
    const g = this.g;
    for (const r of g.racers) {
      if (!r.car) continue;
      if (r.pit) { this.drive(r, dt); continue; }
      if (r.finished || r.retired) continue;
      const c = r.car;
      const ds = Math.abs(r.s) * dt;
      const nitro = r.nitroTime > 0;
      if (g.state === 'race') {
        c.fuel = Math.max(0, c.fuel - (ds / (FUEL_LAPS * this.L)) * (nitro ? 2.2 : 1) * (r.isPlayer && r.throttle <= 0 ? 0.4 : 1));
        c.tyre = Math.min(1, c.tyre + (ds / (TYRE_LAPS * this.L)) * (r.drifting ? 3 : 1) * (1 + c.susp * 0.6));
      }
      // engine smoke when badly damaged
      if (c.engine > 0.5 && Math.random() < dt * 14) {
        const b = r.x - Math.sin(r.h) * 2.4, bz = r.z - Math.cos(r.h) * 2.4;
        g.fx.smoke.emit(b, r.y + 0.8, bz, (Math.random() - 0.5), 1 + Math.random(), (Math.random() - 0.5), 1.1, 1.2, 3.5, 0.25, 0.25, 0.27, 0.6);
      }
      const u = this.pit.u(r.d);
      // rivals decide on a stop 200 m before the pit entry
      if (!r.isPlayer && this.crossed(r.lastU, u, this.L - 200)) r.box = this.aiWantsBox(r);
      if (!r.isPlayer) this.mistakes(r, dt);
      if (r.isPlayer) this.radio(r);
      // take the pit entry when boxing, or when the player steers into it (hugging the pit side at the entry)
      if (g.state === 'race') {
        if (r.box && this.crossed(r.lastU, u, 0)) this.enter(r);
        else if (r.isPlayer && u < 25 && r.lat > this.track.halfW - 3 && !r.pitSkip) this.enter(r, u);
        if (u > 30 && u < 60) r.pitSkip = false;
      }
      r.lastU = u;
    }
    this.crew.update(dt, g.time);
  }

  // Rivals are not perfect either: in corners they lock up or run wide into the wall. The odds go up with
  // worn tyres, damage and a less skilled driver, and the damage works exactly like the player's.
  mistakes(r, dt) {
    const g = this.g;
    if (g.state !== 'race' || g.raceTime < 6 || r.s < 28 || r.wreck > 0) return;
    r.mistakeCd = (r.mistakeCd || 0) - dt;
    if (r.mistakeCd > 0) return;
    if (Math.abs(this.track.curv[r.hint] || 0) < 0.012) return;
    const c = r.car;
    const rate = 0.012 + Math.max(0, 1.3 - (r.skill ?? 1)) * 0.02 + c.tyre * c.tyre * 0.09 + c.wing * 0.04 + c.susp * 0.05;
    if (Math.random() > rate * dt) return;
    r.mistakeCd = 8;
    const R = Math.random;
    const near = g.player && Math.hypot(r.x - g.player.x, r.z - g.player.z) < 150;
    if (R() < 0.7) {
      // lock-up: flat-spotted tyres, a puff of smoke, time lost
      r.s *= 0.62;
      c.tyre = Math.min(1, c.tyre + 0.06);
      for (let k = 0; k < 14; k++) g.fx.smoke.emit(r.x + (R() - 0.5), r.y + 0.3, r.z + (R() - 0.5), (R() - 0.5) * 2, 1 + R(), (R() - 0.5) * 2, 0.9, 1.2, 4, 0.95, 0.95, 0.97, 0.45);
      if (near) g.audio.play('scrape');
    } else {
      // ran wide into the barrier
      const hard = r.s;
      r.s *= 0.45;
      r.lat = Math.sign(r.lat || (R() - 0.5)) * (this.track.halfW - 1.4);
      r.latV = 0;
      this.damage(r, 0.12 + R() * 0.3, 'wing');
      this.damage(r, 0.05 + R() * 0.2, 'susp');
      g.fx.sparks(r.x, r.y + 0.5, r.z, 20);
      if (near) g.audio.play('crash', hard * 0.3);
      if (hard > 52 && R() < 0.12) g.retire(r);
    }
  }

  crossed(prev, now, at) {
    if (at === 0) return prev > this.L - 80 && now < 80;
    return prev < at && now >= at && now - prev < 80;
  }

  // distance still to race, in laps
  remaining(r) {
    const laps = this.g.race.laps;
    const covered = r.isPlayer ? r.progress / this.L : r.dist / this.L;
    return Math.max(0, laps - covered);
  }

  // same judgement for everyone: the player's guide lights up on exactly the conditions that make rivals pit
  needsPit(r) { return this.aiWantsBox(r); }

  aiWantsBox(r) {
    const c = r.car;
    const left = this.remaining(r);
    if (left < 0.35) return false;
    const fuelNeed = left / FUEL_LAPS;
    return c.fuel < fuelNeed * 1.02 + 0.08 || (c.tyre > 0.7 && left > 0.6) || c.wing > 0.55 || c.engine > 0.55 || c.susp > 0.6;
  }

  radio(r) {
    const c = r.car, w = r.warned, hud = this.g.hud;
    const left = this.remaining(r);
    if (!r.box && left > 0.3 && c.fuel < Math.min(0.2, left / FUEL_LAPS) && !w.fuel) { w.fuel = true; hud.message('Low fuel: box, box!', '#ffd23a'); }
    if (!r.box && c.tyre > 0.8 && left > 0.4 && !w.tyre) { w.tyre = true; hud.message('Tyres are gone: box!', '#ffd23a'); }
    if (c.fuel <= 0 && !w.empty) { w.empty = true; hud.message('Out of fuel!', '#ff4b4b'); }
  }

  enter(r, u = 0) {
    r.box = false;
    r.pitSkip = true;
    if (r.isPlayer) r.endDrift(false);
    r.pit = { u, speed: Math.abs(r.s), lat0: r.lat, phase: 'in', timer: 0, dist0: r.dist - u };
    r.drifting = false;
    r.nitroTime = 0;
    if (r.isPlayer) this.g.hud.message('Pit lane', '#27c7ff', true);
  }

  // work plan for the stop: what gets done and how long the car sits
  plan(r) {
    const c = r.car;
    const left = this.remaining(r);
    const tyres = c.tyre > 0.25;
    const fuelTo = Math.min(1, Math.max(c.fuel, (left / FUEL_LAPS) * 1.08 + 0.05));
    const fuelT = (fuelTo - c.fuel) * 6.5;
    const repairT = (c.wing + c.engine + c.susp) * 5;
    const time = 1.4 + Math.max(tyres ? 2.2 : 0, fuelT, repairT);
    return { tyres, fuelFrom: c.fuel, fuelTo, from: { wing: c.wing, engine: c.engine, susp: c.susp, tyre: c.tyre }, time };
  }

  drive(r, dt) {
    const p = r.pit, g = this.g;
    const boxU = this.pit.boxU(r.team ?? 0);
    if (p.phase === 'in' || p.phase === 'lane') {
      if (p.u >= PIT.taperIn) p.phase = 'lane';
      const toBox = boxU - p.u;
      // brake to the limiter, then to a stop on the box
      const target = p.phase === 'in' && p.u < PIT.taperIn - 30 ? Math.max(PIT.limit, p.speed - 30 * dt) : Math.min(PIT.limit, Math.sqrt(Math.max(0, toBox) * 2 * 14));
      p.speed = p.speed > target ? Math.max(target, p.speed - 40 * dt) : Math.min(target, p.speed + 12 * dt);
      if (toBox <= 0.3) {
        p.phase = 'stop';
        p.speed = 0;
        p.u = boxU;
        p.work = this.plan(r);
        p.timer = 0;
        this.crew.setWorking(r.team ?? 0, true);
      }
    } else if (p.phase === 'stop') {
      p.timer += dt;
      const w = p.work, c = r.car;
      const k = clamp(p.timer / w.time, 0, 1);
      c.fuel = lerp(w.fuelFrom, w.fuelTo, k);
      c.wing = lerp(w.from.wing, 0, k);
      c.engine = lerp(w.from.engine, 0, k);
      c.susp = lerp(w.from.susp, 0, k);
      if (w.tyres) c.tyre = k > 0.8 ? 0 : w.from.tyre;
      if (k >= 1) {
        this.crew.setWorking(r.team ?? 0, false);
        r.stops++;
        r.warned = {};
        this.visual(r);
        p.phase = 'out';
        if (r.isPlayer) g.hud.message(`Stop ${w.time.toFixed(1)}s: go, go, go!`, '#6dff9e');
        if (r.isPlayer) g.excite(0.4);
      }
    } else {
      const limit = p.u < PIT.laneOut ? PIT.limit : RELEASE_SPEED;
      p.speed = Math.min(limit, p.speed + 14 * dt);
    }
    p.u += p.speed * dt;
    if (p.phase === 'out' && p.u >= PIT.exit) return this.release(r);
    this.place(r, p);
  }

  // put the car where the pit lane says it is
  place(r, p) {
    const tr = this.track, hw = tr.halfW;
    const d = this.pit.d(p.u);
    const s = tr.sample(d, {});
    const lat = pitLat(this.pit, hw, p.u, p.lat0);
    const ahead = pitLat(this.pit, hw, p.u + 2, p.lat0);
    const h = s.hd + Math.atan2(ahead - lat, 2) * -1;
    r.x = s.x + s.rx * lat;
    r.z = s.z + s.rz * lat;
    r.y = s.y + hw * Math.sin(s.bank) + 0.05;
    r.h = h;
    r.s = p.speed;
    r.d = d;
    r.lat = lat;
    if (r.isPlayer) {
      r.m = h;
      r.airborne = false;
      r.vy = 0;
      r.hint = s.i;
      r.throttle = p.speed > 1 ? 1 : 0;
    } else {
      r.dist = p.dist0 + p.u;
      r.trackHd = s.hd;
      r.slope = tr.slope[s.i];
      r.bank = 0;
      r.yawOff = wrapAngle(h - s.hd);
      r.airborne = false;
      r.hint = s.i;
    }
  }

  release(r) {
    const p = r.pit;
    const s = this.track.sample(this.pit.d(PIT.exit), {});
    r.pit = null;
    r.lastU = PIT.exit;
    r.s = p.speed;
    r.lat = this.track.halfW - 3;
    if (r.isPlayer) { r.h = r.m = s.hd; r.hint = s.i; r.d = s.d; }
    else { r.latV = 0; r.dist = p.dist0 + PIT.exit; }
    r.ghost = 1.5;
  }

  // player asks for a stop (B key / BOX button); ask again to cancel
  toggleBox(r) {
    if (!r.car || r.pit) return;
    r.box = !r.box;
    this.g.hud.message(r.box ? 'Box this lap' : 'Stay out', r.box ? '#27c7ff' : '#ffffff', true);
  }
}
