import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { softDotTexture, textTexture } from './textures.js';

// ---------- Car catalog ----------
// shape: side profile in (x = along the car, + is the nose; y = up), extruded across `width`.
//   top: outline from the front bumper over the hood and deck to the rear bumper; [x, y] = line, [cx, cy, x, y] = curve
//   cabin: greenhouse outline, [base front, windshield top, roof rear, rear glass base, ...]; a painted roof panel is derived from it
// Detail positions (lights, grille, wing) only give heights / z; they are snapped onto the body surface at build time.
// tune: overrides for TUNE in vehicle.js; this is what makes each car drive differently
export const CARS = [
  {
    id: 'sedan', name: 'Metro Sedan', cls: 'Sedan',
    desc: 'Forgiving grip and the fastest charge bar. Slow, but hard to crash.',
    body: 0x3f72c4, accent: 0xd5dbe3, glow: 0x6fb6ff, rim: 0xcfd6de, caliper: 0x5a606a,
    shape: {
      len: [-2.4, 2.42], axles: [-1.45, 1.5], wheelR: 0.44, wheelW: 0.36, arch: 0.51, sill: 0.32, width: 1.96, track: 0.9,
      top: [[2.48, 0.34, 2.48, 0.56], [2.44, 0.84], [2.3, 0.93, 1.95, 0.95], [0.82, 1.0], [-1.3, 1.02], [-2.28, 1.0], [-2.46, 0.98, -2.44, 0.8], [-2.44, 0.42]],
      cabin: { pts: [[0.88, 0.96], [0.1, 1.54], [-0.98, 1.56], [-1.58, 1.0], [-1.2, 0.95], [0.5, 0.95]], width: 1.7 },
    },
    grille: { type: 'bars', y: 0.66 },
    head: { type: 'rect', y: 0.8, x: 0.6 },
    tail: { type: 'sedan', y: 0.84 },
    wing: { type: 'lip', z: -2.3 },
    spokes: 5,
    exhaust: [[-0.55, 0.4]],
    mirror: 0.62,
    tune: { vmax: 49, vmaxNitro: 70, accel: 21, nitroAccel: 36, brake: 50, turnRate: 2.05, grip: 14, driftYaw: 1.35, driftGrip: 2.3, maxDriftAngle: 1.0, gaugeRate: 0.43, nitroTime: 3.0 },
  },
  {
    id: 'gt', name: 'Street GT', cls: 'Sports Car',
    desc: 'The all-rounder. Balanced numbers and a tall wing that loves long slides.',
    body: 0xffc21a, accent: 0x1b1b1b, glow: 0xffe066, rim: 0x2b2b2b, caliper: 0xe53935,
    shape: {
      len: [-2.3, 2.38], axles: [-1.38, 1.42], wheelR: 0.46, wheelW: 0.4, arch: 0.53, sill: 0.3, width: 2.0, track: 0.93,
      top: [[2.44, 0.32, 2.44, 0.5], [2.32, 0.7], [1.85, 0.87, 1.2, 0.93], [0.55, 0.96], [-1.5, 1.0], [-2.2, 1.02, -2.34, 0.92], [-2.34, 0.45]],
      cabin: { pts: [[0.64, 0.92], [-0.2, 1.36], [-0.9, 1.38], [-2.05, 1.0], [-1.5, 0.95], [0.3, 0.92]], width: 1.5 },
    },
    grille: { type: 'mouth', y: 0.45, w: 1.1 },
    head: { type: 'slim', y: 0.66, x: 0.62 },
    tail: { type: 'bar', y: 0.8 },
    wing: { type: 'tall', z: -1.95 },
    stripes: [0.7, 2.15],
    spokes: 6,
    exhaust: [[-0.42, 0.4], [0.42, 0.4]],
    mirror: 0.4,
    tune: { vmax: 54, vmaxNitro: 75, accel: 24, nitroAccel: 40, turnRate: 1.95, grip: 12, driftYaw: 1.6, maxDriftAngle: 1.15, gaugeRate: 0.38 },
  },
  {
    id: 'mclaren', name: 'McLaren', cls: 'Supercar',
    desc: 'Launches like nothing else and turns in razor sharp. Rewards clean lines.',
    body: 0xff7a00, accent: 0x1b1b1b, glow: 0xff9a3a, rim: 0x2b2b2b, caliper: 0xff7a00,
    shape: {
      len: [-2.3, 2.36], axles: [-1.42, 1.3], wheelR: 0.48, wheelW: 0.42, arch: 0.55, sill: 0.28, width: 2.04, track: 0.95,
      top: [[2.44, 0.3, 2.42, 0.46], [2.26, 0.6], [1.8, 0.82, 1.25, 0.92], [0.9, 0.93], [-1.0, 1.02], [-1.9, 1.06], [-2.3, 1.07, -2.36, 0.9], [-2.34, 0.42]],
      cabin: { pts: [[1.08, 0.9], [0.2, 1.28], [-0.55, 1.31], [-1.68, 1.04], [-1.1, 1.0], [0.6, 0.9]], width: 1.42 },
    },
    grille: { type: 'slim', y: 0.42 },
    head: { type: 'socket', y: 0.62, x: 0.66 },
    tail: { type: 'c', y: 0.8 },
    wing: { type: 'active', z: -2.02 },
    side: { type: 'intake', z: [-0.55, -1.0], y: [0.5, 0.94] },
    spokes: 10,
    exhaust: [[-0.2, 0.92], [0.2, 0.92]],
    mirror: 0.8,
    tune: { vmax: 58, vmaxNitro: 79, accel: 29, nitroAccel: 43, turnRate: 2.05, grip: 13.5, driftYaw: 1.5, gaugeRate: 0.34 },
  },
  {
    id: 'audi', name: 'Audi', cls: 'Supercar',
    desc: 'All-wheel-drive grip and hard braking. Stable, but reluctant to slide.',
    body: 0xeceff2, accent: 0x1c1e22, glow: 0x5ab0ff, rim: 0x2e3136, caliper: 0xd32f2f,
    shape: {
      len: [-2.26, 2.34], axles: [-1.4, 1.3], wheelR: 0.47, wheelW: 0.42, arch: 0.54, sill: 0.29, width: 2.0, track: 0.93,
      top: [[2.42, 0.3, 2.4, 0.5], [2.32, 0.74], [1.85, 0.87, 1.2, 0.92], [0.85, 0.94], [-1.1, 1.0], [-1.95, 1.0], [-2.3, 1.0, -2.32, 0.85], [-2.3, 0.42]],
      cabin: { pts: [[0.98, 0.91], [0.15, 1.31], [-0.72, 1.33], [-1.78, 1.0], [-1.2, 0.96], [0.55, 0.91]], width: 1.44 },
    },
    grille: { type: 'hex', y: 0.52 },
    head: { type: 'blade', y: 0.72, x: 0.64 },
    tail: { type: 'bar', y: 0.8 },
    wing: { type: 'lip', z: -2.18 },
    side: { type: 'blade', z: [-0.52, -1.02], y: [0.36, 0.98] },
    spokes: 5,
    exhaust: [[-0.62, 0.4], [0.62, 0.4]],
    mirror: 0.72,
    tune: { vmax: 57, vmaxNitro: 77, accel: 27, nitroAccel: 41, brake: 52, turnRate: 1.95, grip: 15, driftYaw: 1.35, driftGrip: 2.4, maxDriftAngle: 1.0, gaugeRate: 0.35 },
  },
  {
    id: 'bugatti', name: 'Bugatti', cls: 'Hypercar',
    desc: 'Untouchable top speed and the biggest nitro. Heavy in the corners.',
    body: 0x2c63d8, body2: 0x0d1a3a, accent: 0xc9ced6, glow: 0x3a8dff, rim: 0xc9ced6, caliper: 0x1b1b1b,
    shape: {
      len: [-2.46, 2.46], axles: [-1.5, 1.45], wheelR: 0.5, wheelW: 0.46, arch: 0.57, sill: 0.3, width: 2.1, track: 0.98,
      top: [[2.54, 0.32, 2.52, 0.52], [2.44, 0.74], [2.0, 0.92, 1.4, 0.98], [0.95, 0.99], [-1.1, 1.06], [-2.0, 1.03], [-2.46, 1.0, -2.48, 0.82], [-2.46, 0.42]],
      cabin: { pts: [[1.05, 0.96], [0.25, 1.34], [-0.6, 1.36], [-1.62, 1.06], [-1.1, 1.03], [0.6, 0.96]], width: 1.46 },
      // dark front half of the two-tone paint, ending where the side C-line sweeps back
      front: { x: -0.1, top: [[2.54, 0.32, 2.52, 0.52], [2.44, 0.74], [2.0, 0.92, 1.4, 0.98], [0.95, 0.99], [-0.1, 1.03]] },
    },
    grille: { type: 'horseshoe', y: 0.56 },
    head: { type: 'quad', y: 0.72, x: 0.66 },
    tail: { type: 'thin', y: 0.9 },
    wing: { type: 'active', z: -2.12 },
    side: { type: 'cline', z: -0.35, y: 0.7 },
    fin: true,
    spokes: 8,
    exhaust: [[-0.3, 0.45], [-0.1, 0.45], [0.1, 0.45], [0.3, 0.45]],
    mirror: 0.8,
    tune: { vmax: 61, vmaxNitro: 82, accel: 25, nitroAccel: 45, turnRate: 1.72, grip: 10.5, driftYaw: 1.35, driftGrip: 1.9, gaugeRate: 0.3, nitroTime: 3.1 },
  },
  {
    id: 'ferrari', name: 'Ferrari', cls: 'Supercar',
    desc: 'The drift king. Wide slide angles and fast charging, with speed to match.',
    body: 0xd40000, accent: 0x151515, glow: 0xff3a1f, rim: 0xd0d0d0, caliper: 0xffcc00,
    shape: {
      len: [-2.3, 2.4], axles: [-1.4, 1.35], wheelR: 0.47, wheelW: 0.42, arch: 0.54, sill: 0.28, width: 2.02, track: 0.94,
      top: [[2.48, 0.3, 2.46, 0.48], [2.4, 0.66, 2.1, 0.74], [1.6, 0.88, 1.25, 0.93], [1.0, 0.9, 0.85, 0.9], [-1.2, 1.0], [-1.8, 1.1, -2.1, 1.03], [-2.36, 0.96, -2.36, 0.8], [-2.32, 0.42]],
      cabin: { pts: [[1.0, 0.88], [0.2, 1.28], [-0.55, 1.3], [-1.72, 1.02], [-1.2, 0.98], [0.6, 0.88]], width: 1.42 },
    },
    grille: { type: 'mouth', y: 0.42, w: 1.5 },
    head: { type: 'swept', y: 0.7, x: 0.68 },
    tail: { type: 'round', y: 0.78 },
    wing: { type: 'lip', z: -2.2 },
    side: { type: 'intake', z: [-0.62, -0.98], y: [0.48, 0.86] },
    spokes: 5,
    exhaust: [[-0.5, 0.42], [-0.3, 0.42], [0.3, 0.42], [0.5, 0.42]],
    mirror: 0.72,
    tune: { vmax: 59, vmaxNitro: 79, accel: 26, nitroAccel: 41, turnRate: 2.0, grip: 11.5, driftYaw: 1.78, driftYawAlign: 0.95, driftGrip: 1.8, maxDriftAngle: 1.25, gaugeRate: 0.41 },
  },
  {
    id: 'lambo', name: 'Lamborghini', cls: 'Supercar',
    desc: 'All-wheel-drive wedge. Brutal launch and a high top speed, sharp but twitchy.',
    body: 0x8fd14f, accent: 0x151515, glow: 0xb6ff5a, rim: 0x1c1c1c, caliper: 0xffb300,
    shape: {
      len: [-2.34, 2.42], axles: [-1.42, 1.36], wheelR: 0.48, wheelW: 0.44, arch: 0.55, sill: 0.27, width: 2.06, track: 0.96,
      top: [[2.5, 0.28, 2.48, 0.42], [2.2, 0.62], [1.3, 0.9], [0.9, 0.93], [-1.0, 1.0], [-2.0, 1.03], [-2.36, 0.96], [-2.36, 0.42]],
      cabin: { pts: [[1.12, 0.9], [0.1, 1.24], [-0.62, 1.26], [-1.9, 1.02], [-1.2, 0.98], [0.6, 0.9]], width: 1.4 },
    },
    grille: { type: 'slim', y: 0.4 },
    head: { type: 'y', y: 0.6, x: 0.68 },
    tail: { type: 'y', y: 0.82 },
    wing: { type: 'active', z: -2.1 },
    side: { type: 'intake', z: [-0.5, -1.02], y: [0.46, 0.96] },
    spokes: 6,
    exhaust: [[-0.12, 0.72], [0.12, 0.72]],
    mirror: 0.82,
    tune: { vmax: 62, vmaxNitro: 82, accel: 30, nitroAccel: 44, turnRate: 2.0, grip: 12.5, driftYaw: 1.6, maxDriftAngle: 1.15, gaugeRate: 0.36 },
  },
  {
    id: 'porsche', name: 'Porsche', cls: 'Sports Car',
    desc: 'Rear-engined precision. The best handling in the garage, with a huge swan-neck wing.',
    body: 0xb8bec6, accent: 0xc8102e, glow: 0xff5a5a, rim: 0x2b2b2b, caliper: 0xc8102e,
    shape: {
      len: [-2.28, 2.32], axles: [-1.3, 1.36], wheelR: 0.46, wheelW: 0.42, arch: 0.53, sill: 0.3, width: 1.98, track: 0.92,
      top: [[2.4, 0.32, 2.38, 0.5], [2.3, 0.72], [1.9, 0.86, 1.3, 0.9], [0.7, 0.93], [-0.4, 1.02], [-1.6, 1.0, -2.2, 0.9], [-2.34, 0.72], [-2.3, 0.42]],
      cabin: { pts: [[0.72, 0.9], [-0.05, 1.36], [-0.75, 1.4], [-1.85, 0.98], [-1.3, 0.94], [0.4, 0.9]], width: 1.46 },
    },
    grille: { type: 'mouth', y: 0.44, w: 1.3 },
    head: { type: 'round', y: 0.74, x: 0.66 },
    tail: { type: 'bar', y: 0.78 },
    wing: { type: 'tall', z: -1.95 },
    stripes: [0.8, 2.1],
    spokes: 5,
    exhaust: [[-0.14, 0.46], [0.14, 0.46]],
    mirror: 0.45,
    tune: { vmax: 59, vmaxNitro: 79, accel: 28, nitroAccel: 42, brake: 55, turnRate: 2.12, grip: 15.5, driftYaw: 1.6, maxDriftAngle: 1.15, gaugeRate: 0.39 },
  },
  {
    id: 'koenigsegg', name: 'Koenigsegg', cls: 'Hypercar',
    desc: 'The fastest car in the game. Monstrous top speed and nitro, demanding in the bends.',
    body: 0x26282c, accent: 0xffd000, glow: 0xffd000, rim: 0x3a3d42, caliper: 0xffd000,
    shape: {
      len: [-2.42, 2.42], axles: [-1.48, 1.38], wheelR: 0.49, wheelW: 0.46, arch: 0.56, sill: 0.28, width: 2.06, track: 0.97,
      top: [[2.5, 0.3, 2.48, 0.48], [2.34, 0.66], [1.9, 0.86, 1.3, 0.93], [0.95, 0.94], [-1.05, 1.03], [-2.0, 1.02], [-2.42, 1.0, -2.44, 0.8], [-2.42, 0.42]],
      cabin: { pts: [[1.1, 0.92], [0.2, 1.3], [-0.6, 1.32], [-1.72, 1.04], [-1.1, 1.0], [0.6, 0.92]], width: 1.44 },
    },
    grille: { type: 'mouth', y: 0.42, w: 1.6 },
    head: { type: 'blade', y: 0.68, x: 0.68 },
    tail: { type: 'c', y: 0.84 },
    wing: { type: 'tall', z: -2.05 },
    side: { type: 'intake', z: [-0.55, -1.05], y: [0.5, 0.95] },
    spokes: 10,
    exhaust: [[0, 0.95]],
    mirror: 0.82,
    tune: { vmax: 64, vmaxNitro: 85, accel: 28, nitroAccel: 47, turnRate: 1.8, grip: 11.5, driftYaw: 1.45, driftGrip: 1.9, gaugeRate: 0.32, nitroTime: 3.0 },
  },
  {
    id: 'pagani', name: 'Pagani', cls: 'Hypercar',
    desc: 'A hand-built hypercar: huge pace with forgiving, balanced handling and a playful slide.',
    body: 0x00897b, accent: 0x1b1b1b, glow: 0x3dffd0, rim: 0xc9ced6, caliper: 0x00897b,
    shape: {
      len: [-2.32, 2.38], axles: [-1.42, 1.34], wheelR: 0.48, wheelW: 0.44, arch: 0.55, sill: 0.28, width: 2.04, track: 0.95,
      top: [[2.46, 0.3, 2.44, 0.48], [2.36, 0.66, 2.05, 0.74], [1.6, 0.88, 1.25, 0.93], [1.0, 0.91, 0.85, 0.91], [-1.1, 1.02], [-1.8, 1.1, -2.1, 1.02], [-2.34, 0.95, -2.34, 0.8], [-2.3, 0.42]],
      cabin: { pts: [[1.02, 0.88], [0.18, 1.3], [-0.5, 1.32], [-1.7, 1.03], [-1.2, 0.99], [0.6, 0.88]], width: 1.4 },
    },
    grille: { type: 'mouth', y: 0.42, w: 1.3 },
    head: { type: 'swept', y: 0.7, x: 0.66 },
    tail: { type: 'round', y: 0.8 },
    wing: { type: 'active', z: -2.12 },
    side: { type: 'intake', z: [-0.6, -1.0], y: [0.5, 0.88] },
    spokes: 8,
    exhaust: [[-0.12, 0.62], [0.12, 0.62], [-0.12, 0.44], [0.12, 0.44]],
    mirror: 0.72,
    tune: { vmax: 62, vmaxNitro: 82, accel: 28, nitroAccel: 44, turnRate: 1.98, grip: 13, driftYaw: 1.7, driftYawAlign: 0.9, driftGrip: 1.85, maxDriftAngle: 1.2, gaugeRate: 0.38 },
  },
];

// ---------- Spec sheet (derived from the tune values, so the menu never lies) ----------
const BASE = { vmax: 55, vmaxNitro: 76, accel: 24, turnRate: 1.9, grip: 12, driftYaw: 1.5, driftYawAlign: 0.85, driftGrip: 2.0, maxDriftAngle: 1.15, gaugeRate: 0.36, nitroTime: 2.8 };
function rawSpecs(car) {
  const t = { ...BASE, ...car.tune };
  // 0-100 km/h using the same acceleration curve as PlayerCar
  let s = 0, time = 0;
  while (s < 100 / 3.6 && time < 20) { s += t.accel * (1 - Math.pow(s / t.vmax, 2) * 0.85) * 0.01; time += 0.01; }
  return {
    speed: t.vmax,
    accel: 1 / time,
    handling: t.turnRate * Math.sqrt(t.grip),
    drift: ((t.driftYaw + t.driftYawAlign) * t.maxDriftAngle) / Math.sqrt(t.driftGrip),
    nitro: t.gaugeRate * t.nitroTime * (t.vmaxNitro - t.vmax),
    t, time,
  };
}
export function carSpecs() {
  const rows = CARS.map(rawSpecs);
  const keys = ['speed', 'accel', 'handling', 'drift', 'nitro'];
  const lo = {}, hi = {};
  for (const k of keys) { lo[k] = Math.min(...rows.map((r) => r[k])); hi[k] = Math.max(...rows.map((r) => r[k])); }
  return rows.map((r) => {
    const bar = {};
    for (const k of keys) bar[k] = 0.3 + 0.7 * ((r[k] - lo[k]) / (hi[k] - lo[k] || 1));
    return {
      bar,
      label: {
        speed: `${Math.round(r.t.vmax * 3.6)} km/h`,
        accel: `${r.time.toFixed(1)}s`,
        handling: `${Math.round(bar.handling * 10)}/10`,
        drift: `${Math.round(bar.drift * 10)}/10`,
        nitro: `${Math.round(r.t.vmaxNitro * 3.6)} km/h`,
      },
    };
  });
}

// ---------- Geometry ----------
function outline(s, pts) {
  for (const p of pts) p.length === 4 ? s.quadraticCurveTo(p[0], p[1], p[2], p[3]) : s.lineTo(p[0], p[1]);
}

function profileShape(pts) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  outline(s, pts.slice(1));
  s.closePath();
  return s;
}

// Extruded side profile: shape x = body length (+ is the nose), extrude direction = car width
function extrudeSide(shape, width, bevel) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 4,
    curveSegments: 16,
  });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.rotateY(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

// Lower body with the wheel arches cut out; `from` starts the outline at x instead of the rear bumper (two-tone front section)
function bodyShape(S, top, from = null) {
  const [ra, fa] = S.axles;
  const a = S.arch, y0 = S.sill;
  const s = new THREE.Shape();
  if (from == null) {
    s.moveTo(S.len[0] + 0.08, y0);
    s.lineTo(ra - a, y0);
    s.absarc(ra, y0, a, Math.PI, 0, true);
  } else s.moveTo(from, y0);
  s.lineTo(fa - a, y0);
  s.absarc(fa, y0, a, Math.PI, 0, true);
  s.lineTo(S.len[1] - 0.08, y0);
  outline(s, top);
  s.closePath();
  return s;
}

// Surface lookups on an extruded profile (the bevel pushes the real surface out by `off`)
function surface(shape, off) {
  const pts = shape.getPoints(16);
  pts.push(pts[0]);
  const cross = (u, v, at, pick, init) => {
    let best = init;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a[u] === b[u] || (a[u] - at) * (b[u] - at) > 0) continue;
      best = pick(best, a[v] + ((b[v] - a[v]) * (at - a[u])) / (b[u] - a[u]));
    }
    return best;
  };
  return {
    front: (y) => cross('y', 'x', y, Math.max, -1e9) + off,
    rear: (y) => cross('y', 'x', y, Math.min, 1e9) - off,
    top: (x) => cross('x', 'y', x, Math.max, -1e9) + off,
  };
}

const ROOF_UP = 0.07;
const cache = new Map();
function geos(car) {
  if (cache.has(car.id)) return cache.get(car.id);
  const S = car.shape;
  const R = S.wheelR, Ww = S.wheelW;
  const bodyS = bodyShape(S, S.top);
  const [, c1, c2] = S.cabin.pts;
  const roofPts = [[c1[0] + 0.1, c1[1] + 0.02], [c1[0], c1[1] + ROOF_UP], [c2[0], c2[1] + ROOF_UP], [c2[0] - 0.16, c2[1] + 0.03]];
  const G = {
    surf: surface(bodyS, 0.112),
    roofTop: Math.max(c1[1], c2[1]) + ROOF_UP + 0.04,
    body: extrudeSide(bodyS, S.width, 0.14),
    cabin: extrudeSide(profileShape(S.cabin.pts), S.cabin.width, 0.12),
    roof: extrudeSide(profileShape(roofPts), S.cabin.width - 0.14, 0.05),
    skirt: extrudeSide(profileShape([[S.axles[0] + S.arch, S.sill - 0.04], [S.axles[1] - S.arch, S.sill - 0.04], [S.axles[1] - S.arch, S.sill + 0.08], [S.axles[0] + S.arch, S.sill + 0.08]]), S.width + 0.06, 0.03),
    tire: new THREE.CylinderGeometry(R, R, Ww, 28, 1, true).rotateZ(Math.PI / 2),
    sidewall: new THREE.RingGeometry(R * 0.66, R, 28).rotateY(Math.PI / 2),
    barrel: new THREE.CylinderGeometry(R * 0.66, R * 0.66, Ww, 24, 1, true).rotateZ(Math.PI / 2),
    rotor: new THREE.CircleGeometry(R * 0.52, 20).rotateY(Math.PI / 2),
    spoke: new THREE.BoxGeometry(0.06, 0.07, R * 0.58).translate(0, 0, R * 0.33),
    hub: new THREE.CylinderGeometry(R * 0.15, R * 0.15, 0.08, 12).rotateZ(Math.PI / 2),
    caliper: new THREE.BoxGeometry(0.1, R * 0.42, R * 0.3),
  };
  if (S.front) G.front = extrudeSide(bodyShape(S, [...S.front.top, [S.front.x, S.sill + 0.02]], S.front.x), S.width + 0.01, 0.14);
  cache.set(car.id, G);
  return G;
}

// ---------- Build ----------
export function buildCar(car, { name = null, isPlayer = false } = {}) {
  const G = geos(car);
  const S = car.shape;
  const P = G.surf;
  const W = S.width / 2;
  const group = new THREE.Group();
  const root = new THREE.Group(); // Body (used for roll / pitch / drift yaw)
  group.add(root);

  const coat = { clearcoat: 1, clearcoatRoughness: 0.08 };
  const paint = new THREE.MeshPhysicalMaterial({ color: car.body, metalness: 0.55, roughness: 0.28, ...coat });
  const paint2 = car.body2 ? new THREE.MeshPhysicalMaterial({ color: car.body2, metalness: 0.6, roughness: 0.25, ...coat, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }) : paint;
  const accent = new THREE.MeshStandardMaterial({ color: car.accent, metalness: 0.5, roughness: 0.35 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, metalness: 1, roughness: 0.15 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0c1220, metalness: 0.9, roughness: 0.06, clearcoat: 1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.7 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.7, side: THREE.DoubleSide });
  const tireM = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, side: THREE.DoubleSide });
  const rimM = new THREE.MeshStandardMaterial({ color: car.rim, metalness: 0.9, roughness: 0.25 });
  const rotorM = new THREE.MeshStandardMaterial({ color: 0x80858d, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide });
  const headM = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xe8f4ff, emissiveIntensity: 3.5 });
  const tailM = new THREE.MeshStandardMaterial({ color: 0xff2030, emissive: 0xff1020, emissiveIntensity: 4 });
  const neonM = new THREE.MeshStandardMaterial({ color: car.glow, emissive: car.glow, emissiveIntensity: 3.5 });
  const caliperM = new THREE.MeshStandardMaterial({ color: car.caliper, metalness: 0.3, roughness: 0.4 });

  const add = (geo, mat, x = 0, y = 0, z = 0, parent = root) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const box = (w, h, d, mat, x, y, z) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  const mirrored = (fn) => { for (const s of [-1, 1]) fn(s); };

  add(G.body, paint).castShadow = true;
  if (G.front) add(G.front, paint2).castShadow = true;
  add(G.cabin, glass).castShadow = true;
  add(G.roof, paint2);
  add(G.skirt, accent);

  // Side mirrors
  mirrored((s) => {
    const m = box(0.2, 0.1, 0.16, paint2, s * (S.cabin.width / 2 + 0.1), P.top(car.mirror) + 0.05, car.mirror);
    m.rotation.y = s * 0.2;
  });

  // Hood + roof racing stripes
  if (car.stripes) {
    // short segments so the stripes follow the curve of the hood
    const [z0, z1] = car.stripes;
    const n = 8;
    mirrored((s) => {
      for (let k = 0; k < n; k++) {
        const za = z0 + ((z1 - z0) * k) / n, zb = z0 + ((z1 - z0) * (k + 1)) / n;
        const ya = P.top(za) + 0.012, yb = P.top(zb) + 0.012;
        box(0.16, 0.02, Math.hypot(zb - za, yb - ya) + 0.01, accent, s * 0.14, (ya + yb) / 2, (za + zb) / 2).rotation.x = -Math.atan2(yb - ya, zb - za);
      }
      box(0.16, 0.02, 0.6, accent, s * 0.14, G.roofTop + 0.01, (S.cabin.pts[1][0] + S.cabin.pts[2][0]) / 2);
    });
  }

  // Center spine over the roof and down the engine cover
  if (car.fin) {
    const [, c1, c2, c3] = S.cabin.pts;
    box(0.05, 0.08, c1[0] - c2[0], dark, 0, G.roofTop + 0.03, (c1[0] + c2[0]) / 2);
    const za = c3[0], zb = S.len[0] + 0.4;
    const ya = P.top(za) + 0.04, yb = P.top(zb) + 0.04;
    add(new THREE.BoxGeometry(0.05, 0.08, Math.hypot(za - zb, ya - yb)), dark, 0, (ya + yb) / 2, (za + zb) / 2).rotation.x = Math.atan2(ya - yb, za - zb);
  }

  // ---- Front grille / intakes
  const gr = car.grille;
  const zg = Math.min(P.front(gr.y - 0.1), P.front(gr.y + 0.1));
  if (gr.type === 'bars') {
    box(1.1, 0.26, 0.1, dark, 0, gr.y, zg);
    for (let k = 0; k < 3; k++) box(1.12, 0.03, 0.12, chrome, 0, gr.y - 0.08 + k * 0.08, zg + 0.01);
    box(1.6, 0.14, 0.1, dark, 0, 0.42, P.front(0.42) - 0.02);
  } else if (gr.type === 'mouth') {
    box(gr.w, 0.2, 0.1, dark, 0, gr.y, zg);
    box(gr.w + 0.1, 0.03, 0.2, accent, 0, gr.y - 0.12, zg);
  } else if (gr.type === 'slim') {
    mirrored((s) => box(0.46, 0.2, 0.1, dark, s * 0.58, gr.y + 0.04, zg - 0.02));
    box(0.5, 0.1, 0.1, dark, 0, gr.y, zg);
    box(1.9, 0.03, 0.24, accent, 0, 0.3, P.front(0.3) - 0.06);
  } else if (gr.type === 'hex') {
    const hex = add(new THREE.CylinderGeometry(0.4, 0.4, 0.1, 6).rotateX(Math.PI / 2).rotateZ(Math.PI / 6), dark, 0, gr.y, Math.min(P.front(gr.y - 0.2), P.front(gr.y + 0.2)) + 0.01);
    hex.scale.set(1.45, 0.62, 1);
    mirrored((s) => box(0.34, 0.2, 0.1, dark, s * 0.8, 0.44, P.front(0.44) - 0.03));
  } else if (gr.type === 'horseshoe') {
    const zz = Math.min(P.front(gr.y - 0.2), P.front(gr.y + 0.2));
    add(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 24).rotateX(Math.PI / 2), dark, 0, gr.y, zz).scale.set(1, 1.2, 1);
    const ring = add(new THREE.TorusGeometry(0.25, 0.035, 8, 28, Math.PI * 1.55), chrome, 0, gr.y, zz + 0.04);
    ring.rotation.z = -Math.PI * 0.275;
    ring.scale.set(1, 1.2, 1);
    mirrored((s) => box(0.55, 0.22, 0.1, dark, s * 0.72, 0.44, P.front(0.44) - 0.03));
  }

  // ---- Headlights
  const hd = car.head;
  const zh = P.front(hd.y);
  mirrored((s) => {
    const x = s * hd.x;
    if (hd.type === 'rect') {
      box(0.46, 0.16, 0.1, headM, x, hd.y, zh - 0.02).rotation.y = s * 0.12;
    } else if (hd.type === 'slim') {
      box(0.5, 0.1, 0.12, headM, x, hd.y, zh - 0.04).rotation.x = -0.5;
    } else if (hd.type === 'socket') {
      box(0.5, 0.2, 0.1, dark, x, hd.y, zh - 0.04).rotation.x = -0.9;
      box(0.38, 0.045, 0.1, headM, x, hd.y + 0.04, zh - 0.08).rotation.x = -0.9;
      box(0.045, 0.14, 0.14, headM, x + s * 0.2, hd.y, zh - 0.04).rotation.x = -0.9;
    } else if (hd.type === 'blade') {
      box(0.5, 0.12, 0.1, dark, x, hd.y, zh - 0.04).rotation.x = -0.4;
      box(0.46, 0.035, 0.1, headM, x, hd.y - 0.02, zh - 0.02).rotation.set(-0.4, 0, s * 0.12);
    } else if (hd.type === 'quad') {
      box(0.44, 0.2, 0.1, dark, x, hd.y, zh - 0.04).rotation.x = -0.4;
      for (let k = 0; k < 4; k++) box(0.08, 0.06, 0.1, headM, x - s * 0.15 + s * k * 0.1, hd.y + 0.05 - k * 0.035, zh - 0.01 - k * 0.012);
    } else if (hd.type === 'round') {
      add(new THREE.CylinderGeometry(0.15, 0.15, 0.12, 20).rotateX(Math.PI / 2), headM, x, hd.y, zh - 0.04).rotation.x = -0.35;
      add(new THREE.CylinderGeometry(0.19, 0.19, 0.1, 20).rotateX(Math.PI / 2), dark, x, hd.y, zh - 0.07).rotation.x = -0.35;
    } else if (hd.type === 'y') {
      // Y-shaped daytime lights: two arms and a stem
      box(0.3, 0.05, 0.1, headM, x - s * 0.08, hd.y + 0.04, zh - 0.04).rotation.set(-0.6, 0, s * 0.45);
      box(0.3, 0.05, 0.1, headM, x + s * 0.08, hd.y + 0.04, zh - 0.04).rotation.set(-0.6, 0, -s * 0.45);
      box(0.05, 0.16, 0.1, headM, x, hd.y - 0.06, zh - 0.02);
    } else if (hd.type === 'swept') {
      box(0.52, 0.07, 0.12, headM, x, hd.y, zh - 0.06).rotation.set(-0.7, 0, s * 0.22);
    }
  });

  // ---- Tail lights
  const tl = car.tail;
  const zt = P.rear(tl.y);
  if (tl.type === 'sedan') {
    mirrored((s) => {
      box(0.5, 0.2, 0.08, tailM, s * 0.66, tl.y, zt + 0.02);
      box(0.04, 0.18, 0.36, tailM, s * (W + 0.005), tl.y, zt + 0.22);
    });
    box(0.7, 0.12, 0.06, chrome, 0, tl.y - 0.02, zt + 0.01);
  } else if (tl.type === 'bar') {
    box(1.6, 0.06, 0.08, tailM, 0, tl.y, zt + 0.02);
    mirrored((s) => box(0.34, 0.16, 0.08, tailM, s * 0.72, tl.y - 0.04, zt + 0.02));
  } else if (tl.type === 'c') {
    box(1.2, 0.26, 0.06, dark, 0, tl.y, zt + 0.02);
    mirrored((s) => {
      const x = s * 0.72;
      box(0.05, 0.28, 0.08, tailM, x + s * 0.14, tl.y, zt + 0.01);
      box(0.3, 0.05, 0.08, tailM, x, tl.y + 0.12, zt + 0.01);
      box(0.3, 0.05, 0.08, tailM, x, tl.y - 0.12, zt + 0.01);
    });
  } else if (tl.type === 'y') {
    box(1.3, 0.24, 0.06, dark, 0, tl.y, zt + 0.02);
    mirrored((s) => {
      box(0.34, 0.05, 0.08, tailM, s * 0.66, tl.y + 0.06, zt + 0.01).rotation.z = s * 0.4;
      box(0.34, 0.05, 0.08, tailM, s * 0.66, tl.y - 0.06, zt + 0.01).rotation.z = -s * 0.4;
    });
  } else if (tl.type === 'thin') {
    box(1.9, 0.04, 0.08, tailM, 0, tl.y, zt + 0.02);
    box(1.4, 0.26, 0.06, dark, 0, 0.62, P.rear(0.62) + 0.02);
  } else if (tl.type === 'round') {
    const disc = new THREE.CylinderGeometry(0.1, 0.1, 0.08, 20).rotateX(Math.PI / 2);
    mirrored((s) => {
      add(disc, tailM, s * 0.56, tl.y, zt + 0.02);
      add(disc, tailM, s * 0.8, tl.y - 0.02, zt + 0.02);
    });
    box(1.0, 0.16, 0.06, dark, 0, 0.56, P.rear(0.56) + 0.02);
  }

  // Rear diffuser
  box(1.6, 0.16, 0.3, dark, 0, 0.3, P.rear(0.36) + 0.1);

  // ---- Wings
  const wg = car.wing;
  const deck = P.top(wg.z);
  if (wg.type === 'tall') {
    const wing = box(2.1, 0.07, 0.46, accent, 0, deck + 0.3, wg.z);
    wing.rotation.x = -0.12;
    wing.castShadow = true;
    mirrored((s) => {
      box(0.08, 0.42, 0.18, dark, s * 0.62, deck + 0.08, wg.z);
      box(0.05, 0.28, 0.6, paint, s * 1.06, deck + 0.26, wg.z - 0.02);
    });
  } else if (wg.type === 'active') {
    const wing = box(1.86, 0.05, 0.36, accent, 0, deck + 0.12, wg.z);
    wing.rotation.x = -0.08;
    wing.castShadow = true;
    mirrored((s) => box(0.04, 0.12, 0.2, dark, s * 0.5, deck + 0.05, wg.z + 0.04));
  } else if (wg.type === 'lip') {
    box(1.5, 0.06, 0.16, accent, 0, deck + 0.02, wg.z).rotation.x = -0.25;
  }

  // ---- Side details
  const sd = car.side;
  if (sd?.type === 'intake' || sd?.type === 'blade') {
    const [za, zb] = sd.z, [ya, yb] = sd.y;
    const len = za - zb, h = yb - ya;
    const p = new THREE.Shape();
    // swept panel: tall at the leading edge, tapering toward the rear wheel
    p.moveTo(0, h * 0.2); p.lineTo(len * 0.85, h * 0.02); p.lineTo(len, h); p.lineTo(len * 0.1, h * 0.8); p.closePath();
    const g = new THREE.ShapeGeometry(p).rotateY(-Math.PI / 2);
    mirrored((s) => {
      add(g, sd.type === 'blade' ? new THREE.MeshStandardMaterial({ color: car.accent, metalness: 0.6, roughness: 0.3, side: THREE.DoubleSide }) : panel, s * (W + 0.012), ya, zb);
      if (sd.type === 'intake') box(0.02, 0.03, len * 0.95, accent, s * (W + 0.016), yb - 0.03, (za + zb) / 2 + 0.02);
    });
  } else if (sd?.type === 'cline') {
    const g = new THREE.TorusGeometry(0.72, 0.045, 8, 32, Math.PI).rotateZ(-Math.PI / 2).rotateY(Math.PI / 2).scale(1, 0.46, 1);
    mirrored((s) => add(g, chrome, s * (W + 0.02), sd.y, sd.z));
  }

  // Side neon strips
  const neonLen = S.axles[1] - S.axles[0] - S.arch * 2 - 0.1;
  mirrored((s) => box(0.03, 0.05, neonLen, neonM, s * (W + 0.05), S.sill + 0.02, (S.axles[0] + S.axles[1]) / 2));

  // Exhaust pipes
  const exhausts = [];
  for (const [x, y] of car.exhaust) {
    const zr = P.rear(y);
    const ex = add(new THREE.CylinderGeometry(0.08, 0.1, 0.3, 12), chrome, x, y, zr + 0.1);
    ex.rotation.x = Math.PI / 2;
    exhausts.push(new THREE.Vector3(x, y, zr - 0.08));
  }

  // Underglow
  const glowMat = new THREE.MeshBasicMaterial({
    color: car.glow, map: softDotTexture(), transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const under = new THREE.Mesh(new THREE.PlaneGeometry(S.width + 1.2, S.len[1] - S.len[0] + 1), glowMat);
  under.rotation.x = -Math.PI / 2;
  under.position.y = 0.06;
  group.add(under);

  // Wheels: open rims show the brake rotor and caliper between the spokes
  const wheels = [];
  const half = S.wheelW / 2;
  for (const z of [S.axles[1], S.axles[0]]) for (const s of [-1, 1]) {
    const x = s * S.track;
    const steer = new THREE.Group();
    steer.position.set(x, S.wheelR, z);
    const spin = new THREE.Group();
    steer.add(spin);
    add(G.tire, tireM, 0, 0, 0, spin).castShadow = true;
    add(G.sidewall, tireM, half, 0, 0, spin);
    add(G.sidewall, tireM, -half, 0, 0, spin);
    add(G.barrel, panel, 0, 0, 0, spin);
    add(G.rotor, rotorM, -s * 0.02, 0, 0, spin);
    for (let k = 0; k < car.spokes; k++) add(G.spoke, rimM, s * (half - 0.04), 0, 0, spin).rotation.x = (k * Math.PI * 2) / car.spokes;
    add(G.hub, rimM, s * (half - 0.03), 0, 0, spin);
    // brake caliper stays put while the wheel spins
    add(G.caliper, caliperM, s * 0.07, S.wheelR * 0.18, z > 0 ? -S.wheelR * 0.3 : S.wheelR * 0.3, steer);
    group.add(steer);
    wheels.push({ steer, spin, front: z > 0, x, z, r: S.wheelR });
  }

  // Nitro exhaust flames (two cones, additive blending)
  const flameMatOuter = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3aa0ff).multiplyScalar(2.2), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flameMatInner = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.5, 2.5), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flames = [];
  const fs = exhausts.length > 2 ? 0.7 : 1;
  for (const e of exhausts) {
    const fg = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.2 * fs, 1.6, 12, 1, true), flameMatOuter);
    outer.rotation.x = -Math.PI / 2;
    outer.position.z = -0.8;
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.1 * fs, 0.9, 10, 1, true), flameMatInner);
    inner.rotation.x = -Math.PI / 2;
    inner.position.z = -0.45;
    fg.add(outer, inner);
    fg.position.copy(e);
    fg.visible = false;
    root.add(fg);
    flames.push(fg);
  }

  // Name tag
  let tag = null;
  if (name) {
    const tex = textTexture(name, { w: 512, h: 96, fg: '#ffffff', font: 'bold 56px "PingFang SC","Microsoft YaHei",sans-serif', stroke: 'rgba(0,0,0,0.75)' });
    tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
    tag.scale.set(4.2, 0.8, 1);
    tag.position.set(0, 2.5, 0);
    group.add(tag);
  }

  // Shield (item: Angel)
  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(2.9, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  shield.scale.set(1, 0.6, 1.25);
  shield.position.y = 0.8;
  shield.visible = false;
  group.add(shield);

  group.userData = { root, wheels, flames, exhausts, flameMatOuter, under, glowMat, tag, shield, skin: car, isPlayer, tailM, rotorM, track: S.track, rearZ: -S.axles[0] };
  return group;
}

// ---------- Formula 1 car ----------
// Open-wheel single seater in a team livery. Same userData contract as buildCar, so physics, effects and HUD treat it alike.
export function buildF1Car(team, { name = null, isPlayer = false } = {}) {
  const group = new THREE.Group();
  const root = new THREE.Group();
  group.add(root);
  const coat = { clearcoat: 1, clearcoatRoughness: 0.1 };
  const body = new THREE.MeshPhysicalMaterial({ color: team.body, metalness: 0.45, roughness: 0.3, ...coat });
  const accent = new THREE.MeshPhysicalMaterial({ color: team.accent, metalness: 0.4, roughness: 0.35, ...coat });
  const trim = new THREE.MeshStandardMaterial({ color: team.trim, metalness: 0.3, roughness: 0.4 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.55, metalness: 0.3 });
  const tireM = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, side: THREE.DoubleSide });
  const coverM = new THREE.MeshStandardMaterial({ color: 0x202226, metalness: 0.6, roughness: 0.35, side: THREE.DoubleSide });
  const stripeM = new THREE.MeshStandardMaterial({ color: 0xe10600, roughness: 0.6, side: THREE.DoubleSide });
  const tailM = new THREE.MeshStandardMaterial({ color: 0xff2030, emissive: 0xff1020, emissiveIntensity: 4 });
  const visor = new THREE.MeshPhysicalMaterial({ color: 0x0c1220, metalness: 0.9, roughness: 0.05, clearcoat: 1 });
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = root) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const box = (w, h, d, mat, x, y, z) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  const mirrored = (fn) => { for (const s of [-1, 1]) fn(s); };

  // floor, survival cell and nose
  box(1.5, 0.05, 4.4, carbon, 0, 0.1, -0.15);
  box(0.62, 0.46, 2.1, body, 0, 0.42, 0.55);
  add(new THREE.CylinderGeometry(0.1, 0.28, 1.6, 14).rotateX(Math.PI / 2), body, 0, 0.36, 2.35).scale.set(1, 0.7, 1);
  box(0.14, 0.08, 0.3, trim, 0, 0.32, 3.1);
  // front wing: main plane, flaps in the team trim, endplates
  const wing = [box(1.94, 0.04, 0.44, accent, 0, 0.13, 2.95), box(1.84, 0.03, 0.24, trim, 0, 0.2, 2.86)];
  wing[1].rotation.x = -0.35;
  mirrored((s) => wing.push(box(0.03, 0.22, 0.52, body, s * 0.97, 0.2, 2.93)));
  // sidepods with dark intakes and a downswept tail
  mirrored((s) => {
    box(0.5, 0.4, 1.4, body, s * 0.56, 0.34, 0.0);
    box(0.44, 0.26, 0.04, carbon, s * 0.56, 0.4, 0.71);
    const tail = box(0.46, 0.28, 0.9, body, s * 0.5, 0.26, -1.05);
    tail.rotation.x = 0.18;
    box(0.06, 0.05, 0.12, carbon, s * 0.72, 0.64, 0.45); // mirror
    box(0.03, 0.12, 0.03, carbon, s * 0.66, 0.58, 0.45);
  });
  // engine cover, airbox, shark fin
  const cover = box(0.58, 0.42, 1.6, body, 0, 0.62, -0.95);
  cover.rotation.x = 0.14;
  box(0.34, 0.3, 0.55, body, 0, 1.0, -0.12);
  box(0.24, 0.18, 0.04, carbon, 0, 1.02, 0.16);
  box(0.03, 0.34, 1.1, trim, 0, 0.98, -1.35);
  // cockpit, driver, halo
  // open cockpit: side rails and a front coaming, so the driver and wheel show
  mirrored((s) => box(0.06, 0.08, 0.66, carbon, s * 0.24, 0.66, 0.42));
  box(0.46, 0.08, 0.06, carbon, 0, 0.66, 0.74);

  // Driver, seated low; the legs stay hidden inside the chassis until they climb out
  const suit = new THREE.MeshStandardMaterial({ color: team.body, roughness: 0.6 });
  const glove = new THREE.MeshStandardMaterial({ color: team.trim, roughness: 0.6 });
  const drv = new THREE.Group();
  drv.position.set(0, 0.32, 0.26);
  root.add(drv);
  // race kit: team suit with contrasting side panels, collar, belt, shoulder trim and a sponsor patch
  const panel = new THREE.MeshStandardMaterial({ color: team.accent, roughness: 0.6 });
  const trimM = new THREE.MeshStandardMaterial({ color: team.trim, roughness: 0.5 });
  const boot = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6 });
  const part = (g, m, x, y, z) => add(g, m, x, y, z, drv);
  mirrored((sx) => {
    part(new THREE.BoxGeometry(0.14, 0.62, 0.2), suit, sx * 0.08, -0.4, 0); // legs
    part(new THREE.BoxGeometry(0.03, 0.6, 0.12), panel, sx * 0.155, -0.4, 0); // leg stripe
    part(new THREE.BoxGeometry(0.15, 0.13, 0.28), boot, sx * 0.08, -0.77, 0.03); // boots
    part(new THREE.BoxGeometry(0.03, 0.4, 0.2), panel, sx * 0.205, 0.18, 0); // side panels
    part(new THREE.BoxGeometry(0.12, 0.05, 0.25), trimM, sx * 0.15, 0.42, 0); // shoulder trim
  });
  part(new THREE.BoxGeometry(0.4, 0.46, 0.24), suit, 0, 0.2, 0); // torso
  part(new THREE.BoxGeometry(0.41, 0.06, 0.25), panel, 0, -0.02, 0); // belt
  part(new THREE.BoxGeometry(0.14, 0.08, 0.01), white, 0.08, 0.28, 0.125); // chest patch
  part(new THREE.CylinderGeometry(0.1, 0.11, 0.06, 14), trimM, 0, 0.45, 0); // collar
  part(new THREE.BoxGeometry(0.32, 0.08, 0.14), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4 }), 0, 0.45, -0.08); // HANS device
  // helmet: shaped shell, dark visor band, team stripe over the crown, small rear spoiler
  const helmet = new THREE.Group();
  helmet.position.set(0, 0.54, 0);
  drv.add(helmet);
  add(new THREE.SphereGeometry(0.16, 20, 16).scale(1, 1.05, 1.12), trim, 0, 0, 0, helmet);
  add(new THREE.SphereGeometry(0.162, 20, 8, 0, Math.PI * 2, Math.PI * 0.38, Math.PI * 0.14).scale(1, 1.05, 1.12), panel, 0, 0, 0, helmet).rotation.x = -0.2;
  add(new THREE.TorusGeometry(0.162, 0.018, 6, 24, Math.PI).rotateY(Math.PI / 2).scale(1, 1.05, 1.12), panel, 0, 0, 0, helmet);
  add(new THREE.BoxGeometry(0.16, 0.03, 0.06), panel, 0, 0.12, -0.15, helmet);
  const visorM = add(new THREE.SphereGeometry(0.165, 20, 6, -Math.PI * 0.32, Math.PI * 0.64, Math.PI * 0.4, Math.PI * 0.16).scale(1, 1.05, 1.12), visor, 0, 0, 0, helmet);
  // arms for when the driver is out of the car: pivot at the shoulder so they can wave
  const freeArms = [-1, 1].map((s) => {
    const a = new THREE.Group();
    a.position.set(s * 0.26, 0.4, 0);
    add(new THREE.BoxGeometry(0.1, 0.5, 0.1), suit, 0, -0.25, 0, a);
    add(new THREE.BoxGeometry(0.11, 0.05, 0.11), trimM, 0, -0.48, 0, a);
    add(new THREE.SphereGeometry(0.055, 10, 8), glove, 0, -0.55, 0, a);
    a.visible = false;
    drv.add(a);
    return a;
  });
  // steering wheel, tilted toward the driver; the hands ride on its grips
  const sw = new THREE.Group();
  sw.position.set(0, 0.8, 0.56);
  sw.rotation.x = -0.45;
  root.add(sw);
  const rimM = new THREE.MeshStandardMaterial({ color: 0x4a4e57, metalness: 0.5, roughness: 0.35 });
  add(new THREE.BoxGeometry(0.34, 0.15, 0.035), rimM, 0, 0, 0, sw);
  add(new THREE.BoxGeometry(0.16, 0.07, 0.012), new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: team.trim, emissiveIntensity: 1.4 }), 0, 0.02, -0.022, sw);
  [[-0.11, 0xff3030], [0.11, 0x30d0ff], [-0.07, 0xffd23a], [0.07, 0x3ddc84]].forEach(([x, c]) => add(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.6 }), x, -0.045, -0.022, sw));
  const hands = [-1, 1].map((s) => {
    add(new THREE.BoxGeometry(0.06, 0.19, 0.06), new THREE.MeshStandardMaterial({ color: team.accent, roughness: 0.6 }), s * 0.19, 0, 0, sw);
    const h = add(new THREE.SphereGeometry(0.06, 10, 8), glove, s * 0.19, 0.02, -0.045, sw);
    add(new THREE.CylinderGeometry(0.055, 0.055, 0.05, 10), new THREE.MeshStandardMaterial({ color: team.trim, roughness: 0.5 }), 0, -0.06, -0.03, h);
    return h;
  });
  // arms while driving: stretched from each shoulder to its hand every frame
  const armGeo = new THREE.CylinderGeometry(0.045, 0.05, 1, 8);
  const arms = [-1, 1].map(() => add(armGeo, suit));
  const Y = new THREE.Vector3(0, 1, 0), sh = new THREE.Vector3(), hd = new THREE.Vector3(), dir = new THREE.Vector3();
  const drive = (steer) => {
    if (!arms[0].visible) return;
    sw.rotation.z = -steer * 1.8; // wheel rim turns the way the car does
    drv.rotation.z = steer * 0.07; // head and body lean with the load
    sw.updateMatrix();
    [-1, 1].forEach((s, k) => {
      sh.set(s * 0.21, 0.38, 0).applyEuler(drv.rotation).add(drv.position);
      hd.set(s * 0.19, 0.02, -0.045).applyMatrix4(sw.matrix);
      dir.subVectors(hd, sh);
      const len = dir.length();
      arms[k].position.copy(sh).addScaledVector(dir, 0.5);
      arms[k].quaternion.setFromUnitVectors(Y, dir.normalize());
      arms[k].scale.set(1, len, 1);
    });
  };
  // seated (hands on the wheel) or out of the car (free arms)
  const setSeated = (on) => {
    for (const m of [...arms, ...hands]) m.visible = on;
    for (const a of freeArms) a.visible = !on;
  };
  const halo = add(new THREE.TorusGeometry(0.38, 0.035, 8, 24, Math.PI), carbon, 0, 0.93, 0.32);
  halo.rotation.set(-Math.PI / 2, 0, Math.PI);
  box(0.05, 0.26, 0.05, carbon, 0, 0.8, 0.72);
  // rear wing, DRS flap, endplates, beam wing, diffuser
  box(1.02, 0.05, 0.34, accent, 0, 1.0, -2.3);
  box(1.02, 0.04, 0.22, trim, 0, 1.1, -2.36).rotation.x = -0.4;
  mirrored((s) => box(0.03, 0.56, 0.6, body, s * 0.52, 0.86, -2.3));
  box(0.9, 0.04, 0.2, carbon, 0, 0.5, -2.36);
  box(0.06, 0.5, 0.12, carbon, 0, 0.72, -2.28);
  box(1.0, 0.2, 0.34, carbon, 0, 0.2, -2.3);
  // rain light plus endplate lights: all flare under braking
  box(0.2, 0.14, 0.05, tailM, 0, 0.42, -2.5);
  mirrored((s) => box(0.035, 0.3, 0.04, tailM, s * 0.54, 0.9, -2.58));

  // Wheels: big exposed tyres with wheel covers and a compound stripe; wishbones out to each hub
  const wheels = [];
  const axles = [{ z: 1.78, x: 0.83, r: 0.36, w: 0.36 }, { z: -1.55, x: 0.8, r: 0.37, w: 0.44 }];
  for (const A of axles) for (const s of [-1, 1]) {
    const steer = new THREE.Group();
    steer.position.set(s * A.x, A.r, A.z);
    const spin = new THREE.Group();
    steer.add(spin);
    add(new THREE.CylinderGeometry(A.r, A.r, A.w, 28, 1, true).rotateZ(Math.PI / 2), tireM, 0, 0, 0, spin);
    for (const side of [-1, 1]) add(new THREE.RingGeometry(A.r * 0.62, A.r, 28).rotateY(Math.PI / 2), tireM, side * A.w / 2, 0, 0, spin);
    add(new THREE.CircleGeometry(A.r * 0.62, 20).rotateY(Math.PI / 2), coverM, s * (A.w / 2 + 0.005), 0, 0, spin);
    add(new THREE.RingGeometry(A.r * 0.8, A.r * 0.86, 28).rotateY(Math.PI / 2), stripeM, s * (A.w / 2 + 0.006), 0, 0, spin);
    add(new THREE.BoxGeometry(0.06, 0.05, 0.2), trim, s * (A.w / 2 + 0.01), A.r * 0.38, 0, spin); // spoke mark so rotation reads
    group.add(steer);
    wheels.push({ steer, spin, front: A.z > 0, x: s * A.x, z: A.z, r: A.r });
    for (const dy of [0.28, 0.44]) {
      const arm = box(A.x - 0.3, 0.03, 0.05, carbon, s * (0.3 + (A.x - 0.3) / 2), dy, A.z);
      arm.rotation.z = s * (dy === 0.28 ? 0.1 : -0.12);
    }
  }

  // Underglow in the team trim
  const glowMat = new THREE.MeshBasicMaterial({ color: team.trim, map: softDotTexture(), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const under = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 6.2), glowMat);
  under.rotation.x = -Math.PI / 2;
  under.position.y = 0.05;
  group.add(under);

  // single central exhaust under the rear wing
  const flameMatOuter = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3aa0ff).multiplyScalar(2.2), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flameMatInner = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.5, 2.5), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  add(new THREE.CylinderGeometry(0.07, 0.08, 0.2, 10).rotateX(Math.PI / 2), carbon, 0, 0.62, -2.42);
  const exhausts = [new THREE.Vector3(0, 0.62, -2.55)];
  const fg = new THREE.Group();
  const outer = new THREE.Mesh(new THREE.ConeGeometry(0.18, 1.5, 12, 1, true), flameMatOuter);
  outer.rotation.x = -Math.PI / 2;
  outer.position.z = -0.75;
  const inner = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.85, 10, 1, true), flameMatInner);
  inner.rotation.x = -Math.PI / 2;
  inner.position.z = -0.42;
  fg.add(outer, inner);
  fg.position.copy(exhausts[0]);
  fg.visible = false;
  root.add(fg);

  let tag = null;
  if (name) {
    const tex = textTexture(name, { w: 512, h: 96, fg: '#ffffff', font: 'bold 56px "PingFang SC","Microsoft YaHei",sans-serif', stroke: 'rgba(0,0,0,0.75)' });
    tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
    tag.scale.set(4.2, 0.8, 1);
    tag.position.set(0, 2.2, 0);
    group.add(tag);
  }
  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(3.1, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  shield.scale.set(0.8, 0.5, 1.25);
  shield.position.y = 0.7;
  shield.visible = false;
  group.add(shield);

  group.userData = { root, wheels, flames: [fg], exhausts, flameMatOuter, under, glowMat, tag, shield, skin: team, isPlayer, tailM, track: 0.82, rearZ: 1.55, wing, drive, driver: { drv, freeArms, helmet, visor: visorM, setSeated } };
  drive(0);
  return group;
}

// ---------- Menu previews: render each car once into an image ----------
export function renderCarThumbs(w = 480, h = 267) { return renderThumbs(CARS, buildCar, w, h); }
export function renderTeamThumbs(teams, w = 480, h = 267) { return renderThumbs(teams, buildF1Car, w, h); }

function renderThumbs(list, build, w, h) {
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(w, h, false);
  r.toneMapping = THREE.NeutralToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(r);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x404a60, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.set(4, 8, 6);
  scene.add(sun);
  const cam = new THREE.PerspectiveCamera(24, w / h, 0.1, 100);
  cam.position.set(4.9, 2.4, 5.6);
  cam.lookAt(0, 0.62, 0.05);
  const urls = list.map((car) => {
    const m = build(car);
    m.userData.under.visible = false;
    m.rotation.y = -0.15;
    scene.add(m);
    r.render(scene, cam);
    const url = canvas.toDataURL('image/png');
    scene.remove(m);
    m.traverse((o) => { if (o.material) o.material.dispose(); });
    return url;
  });
  env.dispose();
  pmrem.dispose();
  r.dispose();
  r.forceContextLoss();
  return urls;
}
