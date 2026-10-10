import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { softDotTexture, textTexture } from './textures.js';
import { engineAccel, gearCut } from './vehicle.js';
import { cleanLook } from './netproto.js';
import { item } from './catalog.js';
import { DROP, bodySpec, bodyGeometry, cabinSpec, cabinGeometry, roofGeometry, pillarCurves, wellGeometry, sideX, topAt, noseZ, tailZ, endZ, endNormal, deckY, tyreGeometry, rimGeometry, RIM_FOR_SPOKES } from './carGeometry.js';

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
  // 0-100 km/h using the same acceleration curve and gear changes as PlayerCar
  const sim = { s: 0, T: t };
  let time = 0;
  while (sim.s < 100 / 3.6 && time < 20) { sim.s += engineAccel(t, sim.s, t.vmax) * gearCut(sim, 0.01) * 0.01; time += 0.01; }
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

// ---------- Looks ----------
// A garage look ({ paint, wheels, bodykit, glow } part ids, see catalog.js) as what buildCar draws: colours,
// finishes and the body kit's pieces. A slot left out has the car's factory part, so an empty look is the car as
// it always was. Accent, rim style, calipers and stripes aren't in the garage: they are always the car's own.
const GLOW_OFF = 0x000000; // the "Off" underglow
export function resolveLook(car, look) {
  const l = cleanLook(look);
  const paint = item(l.paint), wheels = item(l.wheels), kit = item(l.bodykit), glow = item(l.glow);
  return {
    paint: paint?.color ?? car.body, finish: paint?.finish || 'gloss',
    rimColor: wheels?.color ?? car.rim, rimFinish: wheels?.finish || 'alloy',
    glow: glow?.color ?? car.glow, rainbow: !!glow?.rainbow,
    kit: kit?.kit || {},
    accent: car.accent, rim: RIM_FOR_SPOKES[car.spokes] || 'star', caliper: car.caliper, stripes: !!car.stripes,
  };
}

// Chrome is a mirror, Gold Leaf a warmer and softer metal, Pearl shifts colour with the angle, Matte has no shine
const FINISH = {
  gloss: { metalness: 0.55, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08 },
  matte: { metalness: 0.15, roughness: 0.72, clearcoat: 0 },
  pearl: { metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06, iridescence: 0.85, iridescenceIOR: 1.5, iridescenceThicknessRange: [180, 520] },
  chrome: { metalness: 1, roughness: 0.07, clearcoat: 1, clearcoatRoughness: 0.02 },
  gold: { metalness: 1, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.04 },
};
export function paintMaterial(color, finish = 'gloss', extra = {}) {
  return new THREE.MeshPhysicalMaterial({ color, ...(FINISH[finish] || FINISH.gloss), ...extra });
}
// rims: polished alloy, neon that glows in its own colour, satin carbon, gold
const RIM_FINISH = {
  alloy: { metalness: 0.92, roughness: 0.22 },
  neon: { metalness: 0.92, roughness: 0.22, emissiveIntensity: 1.4 },
  carbon: { metalness: 0.35, roughness: 0.42 },
  gold: { metalness: 1, roughness: 0.16 },
};

// ---------- Geometry (cached per car) ----------
const cache = new Map();
function geos(car) {
  if (cache.has(car.id)) return cache.get(car.id);
  const S = car.shape;
  const B = bodySpec(car);
  const C = cabinSpec(car, B);
  const R = B.R;
  const G = {
    B, C, R,
    body: bodyGeometry(B, S.front ? S.front.x : null),
    cabin: cabinGeometry(C),
    roof: roofGeometry(C),
    pillars: pillarCurves(C),
    well: wellGeometry(B),
    roofTop: Math.max(C.c1[1], C.c2[1]) + 0.02,
    tyre: tyreGeometry(R, S.wheelW, R * 0.74),
    barrel: new THREE.CylinderGeometry(R * 0.72, R * 0.72, S.wheelW * 0.9, 28, 1, true).rotateZ(Math.PI / 2),
    rotor: new THREE.CylinderGeometry(R * 0.6, R * 0.6, 0.03, 28).rotateZ(Math.PI / 2),
    caliper: new THREE.BoxGeometry(0.09, R * 0.42, R * 0.32),
  };
  const tube = (pts, r) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(8, pts.length * 2), r, 6);
  G.pillarA = tube(G.pillars.a, 0.03);
  G.pillarC = tube(G.pillars.c, 0.03);
  G.pillarB = G.pillars.b.length > 1 ? tube(G.pillars.b, 0.022) : null;
  cache.set(car.id, G);
  return G;
}

// ---------- Draw calls: one per material for the rigid parts ----------
// A car is ~90 meshes and every mesh is a draw call (two with its shadow), which on a full grid is most of the frame's
// CPU time. Meshes that never move against `parent` are baked into one mesh per material: the same triangles with the
// same materials, so the car looks exactly as it did. Subtrees in `skip` stay as they are (the parts that move or come
// and go: flames, the F1 driver, its wheel and arms). With `only`, just those meshes are merged, among themselves.
// Returns the meshes that now stand for the parts considered.
const _rel = new THREE.Matrix4();
function mergeParts(parent, { skip = new Set(), only = null } = {}) {
  const groups = new Map(), kept = [];
  const visit = (node) => {
    for (const o of node.children) {
      if (skip.has(o) || !o.visible) continue;
      visit(o);
      if (!o.isMesh || (only && !only.has(o))) continue;
      const g = o.geometry;
      if (o.children.length || Array.isArray(o.material) || o.material.transparent || o.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender
        || g.morphAttributes.position || g.drawRange.start !== 0 || g.drawRange.count !== Infinity) { kept.push(o); continue; }
      const attrs = Object.keys(g.attributes).sort().map((k) => `${k}:${g.attributes[k].itemSize}:${g.attributes[k].array.constructor.name}`).join();
      const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}|${!!g.index}|${attrs}`;
      let grp = groups.get(key);
      if (!grp) groups.set(key, (grp = []));
      grp.push(o);
    }
  };
  visit(parent);
  const out = [...kept], emptied = new Set();
  for (const meshes of groups.values()) {
    if (meshes.length < 2) { out.push(...meshes); continue; }
    const geos = meshes.map((o) => {
      _rel.identity();
      for (let p = o; p !== parent; p = p.parent) { p.updateMatrix(); _rel.premultiply(p.matrix); }
      const geo = o.geometry.clone().applyMatrix4(_rel);
      // a mirrored part was drawn with its winding flipped; baked in, its triangles have to be turned back
      if (_rel.determinant() < 0) flipWinding(geo);
      return geo;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) { out.push(...meshes); continue; }
    const src = meshes[0];
    const m = new THREE.Mesh(merged, src.material);
    m.castShadow = src.castShadow;
    m.receiveShadow = src.receiveShadow;
    m.renderOrder = src.renderOrder;
    parent.add(m);
    out.push(m);
    for (const o of meshes) { emptied.add(o.parent); o.removeFromParent(); }
  }
  // lamp housings and the like that held only merged parts
  for (const g of emptied) if (g !== parent && !g.children.length && !g.isMesh && !skip.has(g)) g.removeFromParent();
  return out;
}

function flipWinding(geo) {
  if (geo.index) {
    const a = geo.index.array;
    for (let i = 0; i + 2 < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    return;
  }
  for (const attr of Object.values(geo.attributes)) {
    const a = attr.array, n = attr.itemSize;
    for (let v = 0; v + 2 < attr.count; v += 3)
      for (let c = 0; c < n; c++) { const i = (v + 1) * n + c, j = (v + 2) * n + c, t = a[i]; a[i] = a[j]; a[j] = t; }
  }
}

// ---------- Build ----------
export function buildCar(car, { name = null, isPlayer = false, look = null } = {}) {
  const G = geos(car);
  const S = car.shape;
  const B = G.B, C = G.C;
  const L = resolveLook(car, look);
  const K = L.kit; // body kit pieces (catalog.js); a kit's splitter, skirts or wing replace the car's own
  const W = S.width / 2;
  const group = new THREE.Group();
  const root = new THREE.Group(); // Body (used for roll / pitch / drift yaw)
  root.position.y = -DROP;
  group.add(root);

  const paint = paintMaterial(L.paint, L.finish);
  // two-tone cars keep their dark front, or a deep shade of a garage paint
  const front2 = S.front ? (L.paint === car.body && car.body2 != null ? car.body2 : new THREE.Color(L.paint).multiplyScalar(0.28).getHex()) : null;
  const paint2 = front2 != null ? paintMaterial(front2, L.finish) : paint;
  const accent = new THREE.MeshStandardMaterial({ color: L.accent, metalness: 0.5, roughness: 0.35 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, metalness: 1, roughness: 0.15 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b111c, metalness: 0.2, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02, reflectivity: 0.9 });
  const gloss = new THREE.MeshPhysicalMaterial({ color: 0x0c0d10, metalness: 0.3, roughness: 0.25, clearcoat: 1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.7 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.7, side: THREE.DoubleSide });
  const wellM = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.95, side: THREE.DoubleSide });
  const tireM = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.88, side: THREE.DoubleSide });
  const rimM = new THREE.MeshStandardMaterial({ color: L.rimColor, ...RIM_FINISH[L.rimFinish], ...(L.rimFinish === 'neon' ? { emissive: L.rimColor } : {}) });
  const rotorM = new THREE.MeshStandardMaterial({ color: 0x80858d, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide });
  const headM = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xe8f4ff, emissiveIntensity: 3.5 });
  const tailM = new THREE.MeshStandardMaterial({ color: 0xff2030, emissive: 0xff1020, emissiveIntensity: 4 });
  const neonM = new THREE.MeshStandardMaterial({ color: L.glow, emissive: L.glow, emissiveIntensity: 3.5 });
  const caliperM = new THREE.MeshStandardMaterial({ color: L.caliper, metalness: 0.3, roughness: 0.4 });

  const add = (geo, mat, x = 0, y = 0, z = 0, parent = root) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const box = (w, h, d, mat, x, y, z, parent = root) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, parent);
  const mirrored = (fn) => { for (const s of [-1, 1]) fn(s); };
  const front = (y, x = 0) => endZ(B, 1, x, y) ?? noseZ(B, y, x);
  const rear = (y, x = 0) => endZ(B, -1, x, y) ?? tailZ(B, y, x);
  const top = (z) => deckY(B, z);
  const UP = new THREE.Vector3(0, 1, 0);
  // frame on the nose (end = 1) or tail (end = -1) at (x, y): +z out of the surface, +y up; on the tail +x is the
  // car's left (seen from behind it is the right)
  const onBody = (end, x, y, along = null, upright = false) => {
    const z = end > 0 ? front(y, x) : rear(y, x);
    const Z = endNormal(B, end, x, y);
    // fascia bands lean back with a sloping nose, but never tip down where the body curves under
    if (upright) { Z.y = Math.min(0.6, Math.max(0, Z.y)); Z.normalize(); }
    const X = along ? along.clone().sub(Z.clone().multiplyScalar(along.dot(Z))).normalize() : new THREE.Vector3().crossVectors(UP, Z).normalize();
    const Y = new THREE.Vector3().crossVectors(Z, X);
    if (along && Y.y < 0) { X.negate(); Y.negate(); }
    return { pos: new THREE.Vector3(x, y, z), quat: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z)) };
  };
  // a band across the nose or tail at height y, upright, in segments that follow the curve in plan; inset sinks it in
  const strip = (end, y, x0, x1, h, d, mat, inset = 0.02, n = Math.max(2, Math.round((x1 - x0) / 0.12))) => {
    const at = end > 0 ? front : rear;
    for (let i = 0; i < n; i++) {
      const xa = x0 + ((x1 - x0) * i) / n, xb = x0 + ((x1 - x0) * (i + 1)) / n, xm = (xa + xb) / 2;
      const dir = new THREE.Vector3(xb - xa, 0, at(y, xb) - at(y, xa));
      const f = onBody(end, xm, y, dir, true);
      const m = box(dir.length() + 0.012, h, d, mat, 0, 0, 0);
      m.position.copy(f.pos).add(new THREE.Vector3(0, 0, 1).applyQuaternion(f.quat).multiplyScalar(d / 2 - inset));
      m.quaternion.copy(f.quat);
    }
  };
  // a skin moulded onto the nose or tail over x0..x1, y0..y1, lifted just off the paint: intakes, dark panels, light bars
  const patch = (end, x0, x1, y0, y1, mat, lift = 0.006) => {
    const nx = Math.max(2, Math.ceil((x1 - x0) / 0.05)), ny = Math.max(1, Math.ceil((y1 - y0) / 0.04));
    const pos = [], idx = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      let y = y0 + ((y1 - y0) * j) / ny, z = endZ(B, end, x, y);
      // under the nose the body may curve away below y0: walk up onto it
      for (let k = 0; z == null && k < 6; k++) { y += 0.02; z = endZ(B, end, x, y); }
      pos.push(x, y, (z ?? (end > 0 ? noseZ(B, y, x) : tailZ(B, y, x))) + end * lift);
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      if (end > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return add(g, mat);
  };
  // a flat splitter plate under the nose at height y: its front edge follows the nose, `out` beyond it
  const splitter = (y, w, out, mat) => {
    const sh = new THREE.Shape();
    const n = 16, pts = [];
    for (let i = 0; i <= n; i++) { const x = -w + (2 * w * i) / n; pts.push([x, front(y + 0.05, Math.abs(x)) + out]); }
    const back = Math.min(...pts.map((p) => p[1])) - 0.35;
    sh.moveTo(-w, back);
    for (const [x, z] of pts) sh.lineTo(x, z);
    sh.lineTo(w, back);
    sh.closePath();
    add(new THREE.ExtrudeGeometry(sh, { depth: 0.025, bevelEnabled: false }).rotateX(Math.PI / 2), mat, 0, y, 0);
  };
  // a lamp cluster at (x, y) on the nose or tail, facing straight out of the surface there
  const lamp = (end, x, y) => {
    const f = onBody(end, x, y);
    const g = new THREE.Group();
    g.position.copy(f.pos);
    g.quaternion.copy(f.quat);
    root.add(g);
    return g;
  };

  const bodyMesh = add(G.body, S.front ? [paint, paint2] : paint);
  bodyMesh.castShadow = true;
  add(G.cabin, glass).castShadow = true;
  add(G.roof, paint2).castShadow = true;
  // pillars framing the glass (the left ones mirrored)
  mirrored((s) => {
    const m = [add(G.pillarA, paint2), add(G.pillarC, paint2)];
    if (G.pillarB) m.push(add(G.pillarB, gloss));
    if (s < 0) for (const p of m) p.scale.x = -1;
  });

  // wheel wells: dark arch roof and inner wall over each wheel
  for (const ax of S.axles) mirrored((s) => {
    const roof = add(G.well.roof, wellM, s * (B.xIn + G.well.len / 2 - 0.01), B.Rc, ax);
    roof.scale.x = s;
    const wall = add(G.well.wall, wellM, s * (B.xIn + 0.004), B.Rc, ax);
    if (s < 0) wall.rotation.y = Math.PI;
  });

  // side skirts between the arches
  const zs0 = S.axles[0] + B.ra + 0.04, zs1 = S.axles[1] - B.ra - 0.04;
  if (!K.skirts) mirrored((s) => box(0.05, 0.09, zs1 - zs0, accent, s * (sideX(B, (zs0 + zs1) / 2, S.sill + 0.05) - 0.005), S.sill + 0.03, (zs0 + zs1) / 2));

  // Side mirrors, on the doors just behind the base of the windshield pillars: rounded housings, dark glass behind
  const mirrorGeo = new THREE.SphereGeometry(1, 16, 10).scale(0.11, 0.065, 0.085);
  const mirrorGlass = new THREE.CircleGeometry(1, 16).scale(0.085, 0.05, 1).rotateY(Math.PI);
  mirrored((s) => {
    const zm = Math.min(car.mirror, C.c0[0] - 0.14);
    const xb = C.wb * 0.96, yb = topAt(B, zm, xb);
    const arm = box(0.2, 0.035, 0.07, gloss, s * (xb + 0.08), yb + 0.05, zm);
    arm.rotation.z = s * 0.35;
    const m = add(mirrorGeo, paint2, s * (xb + 0.2), yb + 0.1, zm - 0.02);
    m.rotation.y = s * 0.18;
    add(mirrorGlass, gloss, s * (xb + 0.205), yb + 0.1, zm - 0.075).rotation.y = s * 0.18;
  });

  // Hood + roof racing stripes
  const stripes = L.stripes ? car.stripes || [C.c0[0] + 0.06, S.len[1] - 0.28] : null;
  if (stripes) {
    // short segments so the stripes follow the curve of the hood
    const [z0, z1] = stripes;
    const n = 10;
    mirrored((s) => {
      for (let k = 0; k < n; k++) {
        const za = z0 + ((z1 - z0) * k) / n, zb = z0 + ((z1 - z0) * (k + 1)) / n;
        const ya = top(za) + 0.008, yb = top(zb) + 0.008;
        box(0.16, 0.012, Math.hypot(zb - za, yb - ya) + 0.01, accent, s * 0.14, (ya + yb) / 2, (za + zb) / 2).rotation.x = -Math.atan2(yb - ya, zb - za);
      }
      box(0.16, 0.012, Math.max(0.2, C.c1[0] - C.c2[0] - 0.15), accent, s * 0.14, G.roofTop + 0.004, (C.c1[0] + C.c2[0]) / 2);
    });
  }

  // Center spine over the roof and down the engine cover
  if (car.fin) {
    const c1 = C.c1, c2 = C.c2, c3 = C.c3;
    box(0.05, 0.06, c1[0] - c2[0], dark, 0, G.roofTop + 0.02, (c1[0] + c2[0]) / 2);
    const za = c3[0], zb = S.len[0] + 0.4;
    const ya = top(za) + 0.03, yb = top(zb) + 0.03;
    add(new THREE.BoxGeometry(0.05, 0.07, Math.hypot(za - zb, ya - yb)), dark, 0, (ya + yb) / 2, (za + zb) / 2).rotation.x = Math.atan2(ya - yb, za - zb);
  }

  // ---- Front grille / intakes: dark skins on the nose, splitter plates under it
  const gr = car.grille;
  const intakeM = new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.55, metalness: 0.3, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  if (gr.type === 'bars') {
    patch(1, -0.55, 0.55, gr.y - 0.13, gr.y + 0.13, intakeM);
    for (let k = 0; k < 3; k++) strip(1, gr.y - 0.08 + k * 0.08, -0.56, 0.56, 0.025, 0.06, chrome, 0.02);
    patch(1, -0.8, 0.8, 0.35, 0.49, intakeM);
  } else if (gr.type === 'mouth') {
    patch(1, -gr.w / 2, gr.w / 2, gr.y - 0.1, gr.y + 0.1, intakeM);
    if (!K.splitter) splitter(gr.y - 0.14, gr.w / 2 + 0.06, 0.05, accent);
  } else if (gr.type === 'slim') {
    mirrored((s) => patch(1, s > 0 ? 0.36 : -0.8, s > 0 ? 0.8 : -0.36, gr.y - 0.06, gr.y + 0.14, intakeM));
    patch(1, -0.25, 0.25, gr.y - 0.05, gr.y + 0.05, intakeM);
    if (!K.splitter) splitter(0.3, 0.95, 0.08, accent);
  } else if (gr.type === 'hex') {
    const hex = add(new THREE.CylinderGeometry(0.4, 0.4, 0.1, 6).rotateX(Math.PI / 2).rotateZ(Math.PI / 6), gloss, 0, gr.y, Math.min(front(gr.y - 0.2), front(gr.y + 0.2)) - 0.02);
    hex.scale.set(1.45, 0.62, 1);
    mirrored((s) => patch(1, s > 0 ? 0.64 : -0.96, s > 0 ? 0.96 : -0.64, 0.34, 0.54, intakeM));
  } else if (gr.type === 'horseshoe') {
    const zz = Math.min(front(gr.y - 0.2), front(gr.y + 0.2)) - 0.02;
    add(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 24).rotateX(Math.PI / 2), gloss, 0, gr.y, zz).scale.set(1, 1.2, 1);
    const ring = add(new THREE.TorusGeometry(0.25, 0.035, 8, 28, Math.PI * 1.55), chrome, 0, gr.y, zz + 0.04);
    ring.rotation.z = -Math.PI * 0.275;
    ring.scale.set(1, 1.2, 1);
    mirrored((s) => patch(1, s > 0 ? 0.45 : -1.0, s > 0 ? 1.0 : -0.45, 0.33, 0.55, intakeM));
  }

  // ---- Headlights: a glossy black lens flush with the surface, the lamps inside it
  const hd = car.head;
  mirrored((s) => {
    const g = lamp(1, s * hd.x, hd.y);
    const b = (w, h, d, mat, x, y, z) => box(w, h, d, mat, x, y, z, g);
    if (hd.type === 'rect') {
      b(0.5, 0.2, 0.06, gloss, 0, 0, -0.025);
      b(0.44, 0.13, 0.06, headM, 0, 0, -0.02);
    } else if (hd.type === 'slim') {
      b(0.54, 0.13, 0.06, gloss, 0, 0, -0.025);
      b(0.48, 0.06, 0.06, headM, 0, 0.01, -0.02);
    } else if (hd.type === 'socket') {
      b(0.52, 0.22, 0.06, gloss, 0, 0, -0.025);
      b(0.38, 0.045, 0.06, headM, -s * 0.04, 0.05, -0.02);
      b(0.045, 0.16, 0.06, headM, s * 0.2, 0, -0.02);
    } else if (hd.type === 'blade') {
      b(0.52, 0.13, 0.06, gloss, 0, 0, -0.025);
      b(0.46, 0.035, 0.06, headM, 0, -0.02, -0.02).rotation.z = s * 0.1;
    } else if (hd.type === 'quad') {
      b(0.46, 0.22, 0.06, gloss, 0, 0, -0.025);
      for (let k = 0; k < 4; k++) b(0.08, 0.06, 0.06, headM, -s * 0.15 + s * k * 0.1, 0.05 - k * 0.035, -0.02);
    } else if (hd.type === 'round') {
      add(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 24).rotateX(Math.PI / 2), gloss, 0, 0, -0.025, g);
      add(new THREE.CylinderGeometry(0.14, 0.14, 0.06, 24).rotateX(Math.PI / 2), headM, 0, 0, -0.02, g);
    } else if (hd.type === 'y') {
      // Y-shaped daytime lights: two arms and a stem
      b(0.42, 0.24, 0.06, gloss, 0, 0, -0.025);
      b(0.24, 0.045, 0.06, headM, -s * 0.08, 0.04, -0.02).rotation.z = s * 0.45;
      b(0.24, 0.045, 0.06, headM, s * 0.08, 0.04, -0.02).rotation.z = -s * 0.45;
      b(0.045, 0.12, 0.06, headM, 0, -0.05, -0.02);
    } else if (hd.type === 'swept') {
      b(0.56, 0.13, 0.06, gloss, 0, 0, -0.025).rotation.z = s * 0.18;
      b(0.5, 0.05, 0.06, headM, 0, 0.01, -0.02).rotation.z = s * 0.18;
    }
  });

  // ---- Tail lights (on the tail a lamp frame's +x points to the car's left, hence the -s)
  const tl = car.tail;
  const tb = (g, w, h, mat, x, y) => box(w, h, 0.06, mat, x, y, -0.02, g);
  if (tl.type === 'sedan') {
    mirrored((s) => {
      tb(lamp(-1, s * 0.66, tl.y), 0.5, 0.2, tailM, 0, 0);
      const zw = rear(tl.y, 0.9) + 0.25;
      box(0.04, 0.18, 0.3, tailM, s * (sideX(B, zw, tl.y) + 0.003), tl.y, zw);
    });
    strip(-1, tl.y - 0.02, -0.35, 0.35, 0.12, 0.06, chrome, 0.025);
  } else if (tl.type === 'bar') {
    patch(-1, -0.8, 0.8, tl.y - 0.03, tl.y + 0.03, tailM, 0.008);
    mirrored((s) => tb(lamp(-1, s * 0.72, tl.y - 0.04), 0.34, 0.16, tailM, 0, 0));
  } else if (tl.type === 'c') {
    patch(-1, -0.6, 0.6, tl.y - 0.13, tl.y + 0.13, intakeM);
    mirrored((s) => {
      const g = lamp(-1, s * 0.72, tl.y);
      tb(g, 0.05, 0.28, tailM, -s * 0.14, 0);
      tb(g, 0.3, 0.05, tailM, 0, 0.12);
      tb(g, 0.3, 0.05, tailM, 0, -0.12);
    });
  } else if (tl.type === 'y') {
    patch(-1, -0.65, 0.65, tl.y - 0.12, tl.y + 0.12, intakeM);
    mirrored((s) => {
      const g = lamp(-1, s * 0.66, tl.y);
      tb(g, 0.34, 0.05, tailM, 0, 0.06).rotation.z = -s * 0.4;
      tb(g, 0.34, 0.05, tailM, 0, -0.06).rotation.z = s * 0.4;
    });
  } else if (tl.type === 'thin') {
    patch(-1, -0.95, 0.95, tl.y - 0.02, tl.y + 0.02, tailM, 0.008);
    patch(-1, -0.7, 0.7, 0.49, 0.75, intakeM);
  } else if (tl.type === 'round') {
    const disc = new THREE.CylinderGeometry(0.1, 0.1, 0.06, 20).rotateX(Math.PI / 2);
    mirrored((s) => {
      add(disc, tailM, 0, 0, -0.02, lamp(-1, s * 0.56, tl.y));
      add(disc, tailM, 0, 0, -0.02, lamp(-1, s * 0.8, tl.y - 0.02));
    });
    patch(-1, -0.5, 0.5, 0.48, 0.64, intakeM);
  }

  // Rear diffuser: a dark panel low on the tail with a few vertical fins
  patch(-1, -0.78, 0.78, 0.26, 0.42, intakeM);
  for (const fx of [-0.45, -0.15, 0.15, 0.45]) box(0.025, 0.12, 0.18, dark, fx, 0.31, rear(0.32, Math.abs(fx)) + 0.04);

  // ---- Wings
  const wg = car.wing;
  const deck = top(wg.z);
  if (K.wing) { /* the kit's wing, below */ } else if (wg.type === 'tall') {
    const wing = box(2.0, 0.06, 0.44, accent, 0, deck + 0.3, wg.z);
    wing.rotation.x = -0.12;
    wing.castShadow = true;
    mirrored((s) => {
      box(0.06, 0.4, 0.16, gloss, s * 0.6, deck + 0.1, wg.z);
      box(0.04, 0.26, 0.56, paint, s * 1.0, deck + 0.27, wg.z - 0.02);
    });
  } else if (wg.type === 'active') {
    const wing = box(1.76, 0.045, 0.34, accent, 0, deck + 0.1, wg.z);
    wing.rotation.x = -0.08;
    wing.castShadow = true;
    mirrored((s) => box(0.04, 0.1, 0.2, gloss, s * 0.5, deck + 0.04, wg.z + 0.04));
  } else if (wg.type === 'lip') {
    box(1.4, 0.05, 0.14, accent, 0, deck + 0.015, wg.z).rotation.x = -0.25;
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
    const xs = sideX(B, (za + zb) / 2, (ya + yb) / 2);
    mirrored((s) => {
      add(g, sd.type === 'blade' ? new THREE.MeshStandardMaterial({ color: L.accent, metalness: 0.6, roughness: 0.3, side: THREE.DoubleSide }) : panel, s * (xs + 0.008), ya, zb);
      if (sd.type === 'intake') box(0.02, 0.03, len * 0.95, accent, s * (xs + 0.012), yb - 0.03, (za + zb) / 2 + 0.02);
    });
  } else if (sd?.type === 'cline') {
    const g = new THREE.TorusGeometry(0.72, 0.04, 8, 32, Math.PI).rotateZ(-Math.PI / 2).rotateY(Math.PI / 2).scale(1, 0.46, 1);
    const xs = sideX(B, sd.z - 0.3, sd.y);
    mirrored((s) => add(g, chrome, s * (xs + 0.015), sd.y, sd.z));
  }

  // ---- Body kit (garage): carbon aero and painted arches bolted on; looks only, the car drives the same
  if (Object.keys(K).length) {
    const carbon = new THREE.MeshPhysicalMaterial({ color: 0x17181c, metalness: 0.35, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.12 });
    const rod = (a, b, r) => {
      const d = b.clone().sub(a);
      add(new THREE.CylinderGeometry(r, r, d.length(), 6), carbon, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2).quaternion.setFromUnitVectors(UP, d.normalize());
    };
    // front splitter reaching K.splitter past the nose; a long one rests on struts
    if (K.splitter) {
      const ys = S.sill - 0.04;
      splitter(ys, B.W - 0.1, K.splitter, carbon);
      if (K.splitter > 0.1) mirrored((s) => rod(new THREE.Vector3(s * 0.55, ys, front(ys + 0.05, 0.55) + K.splitter - 0.05), new THREE.Vector3(s * 0.5, ys + 0.17, front(ys + 0.17, 0.5) - 0.01), 0.012));
    }
    // side skirts: deeper than stock and standing proud of the sills; a wide body's reach out to its arches
    if (K.skirts) {
      const zm = (zs0 + zs1) / 2, xs = sideX(B, zm, S.sill + 0.05);
      const x0 = xs - 0.03, x1 = K.skirts === 'wide' ? B.flare + 0.08 : xs + 0.05;
      mirrored((s) => box(x1 - x0, 0.13, zs1 - zs0, K.skirts === 'carbon' ? carbon : paint, s * (x0 + x1) / 2, S.sill - 0.005, zm));
    }
    // bolt-on arches over each wheel (the wheels are spaced out to fill them, below)
    if (K.flares) {
      const r0 = B.ra + 0.01, r1 = B.ra + 0.11, a0 = -0.2, a1 = Math.PI + 0.2, n = 18;
      const sh = new THREE.Shape();
      for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; if (i) sh.lineTo(r1 * Math.cos(a), r1 * Math.sin(a)); else sh.moveTo(r1 * Math.cos(a), r1 * Math.sin(a)); }
      for (let i = n; i >= 0; i--) { const a = a0 + ((a1 - a0) * i) / n; sh.lineTo(r0 * Math.cos(a), r0 * Math.sin(a)); }
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2 }).rotateY(Math.PI / 2);
      for (const ax of S.axles) mirrored((s) => {
        const m = add(geo, paint, s * (B.flare - 0.07), B.Rc, ax);
        m.scale.x = s;
        m.castShadow = true;
      });
    }
    // dive planes on the front corners, swept back and tipped up at the outer edge
    for (let k = 0; k < (K.canards || 0); k++) mirrored((s) => {
      const y = S.sill + 0.1 + k * 0.1, x = B.W * 0.8;
      box(0.22, 0.016, 0.12, carbon, s * (x + 0.05), y, front(y, x + 0.05) + 0.01).rotation.set(0, s * 0.4, s * 0.2, 'YXZ');
    });
    // rear wing in place of the car's own: GT on two uprights, a painted ducktail, or Time Attack's tall two-element wing
    if (K.wing === 'gt') {
      const span = Math.min(2, S.width), y = deck + 0.36;
      const w = box(span, 0.05, 0.36, carbon, 0, y, wg.z - 0.04);
      w.rotation.x = 0.1;
      w.castShadow = true;
      mirrored((s) => {
        const yb = topAt(B, wg.z, 0.45);
        box(0.035, y - yb, 0.16, carbon, s * 0.45, (y + yb) / 2, wg.z - 0.02);
        box(0.03, 0.2, 0.44, carbon, s * span / 2, y + 0.02, wg.z - 0.06);
      });
    } else if (K.wing === 'duck') {
      box(Math.min(1.6, S.width - 0.3), 0.05, 0.24, paint, 0, deck + 0.035, wg.z).rotation.x = 0.3;
    } else if (K.wing === 'ta') {
      const span = S.width + 0.04, y = deck + 0.46, z = wg.z - 0.06;
      const w = box(span, 0.05, 0.42, carbon, 0, y, z);
      w.rotation.x = 0.14;
      w.castShadow = true;
      box(span, 0.035, 0.18, carbon, 0, y + 0.08, z - 0.27).rotation.x = 0.5;
      mirrored((s) => {
        const zu = z + 0.08, yb = topAt(B, zu, 0.38);
        box(0.03, y - yb, 0.12, carbon, s * 0.38, (y + yb) / 2, zu);
        box(0.03, 0.3, 0.6, carbon, s * span / 2, y + 0.03, z - 0.08);
      });
    }
    // a carbon lip under the rear bumper
    if (K.valance) box(B.W * 1.5, 0.03, 0.2, carbon, 0, S.sill - 0.04, rear(S.sill + 0.02) - 0.02);
  }

  // Side neon strips, tucked under the sills (none with the underglow off)
  const glowOn = L.glow !== GLOW_OFF;
  const neonLen = zs1 - zs0 - 0.1;
  if (glowOn) mirrored((s) => box(0.03, 0.04, neonLen, neonM, s * (sideX(B, (zs0 + zs1) / 2, S.sill + 0.03) - 0.06), S.sill - 0.01, (zs0 + zs1) / 2));

  // Exhaust pipes
  const exhausts = [];
  for (const [x, y] of car.exhaust) {
    const zr = rear(y, Math.abs(x));
    const ex = add(new THREE.CylinderGeometry(0.075, 0.09, 0.3, 14), chrome, x, y, zr + 0.1);
    ex.rotation.x = Math.PI / 2;
    add(new THREE.CircleGeometry(0.06, 14).rotateY(Math.PI), dark, x, y, zr - 0.051);
    exhausts.push(new THREE.Vector3(x, y, zr - 0.08));
  }

  // Underglow
  const glowMat = new THREE.MeshBasicMaterial({
    color: L.glow, map: softDotTexture(), transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const under = new THREE.Mesh(new THREE.PlaneGeometry(S.width + 1.2, S.len[1] - S.len[0] + 1), glowMat);
  under.rotation.x = -Math.PI / 2;
  under.position.y = 0.06;
  under.visible = glowOn;
  group.add(under);
  // Rainbow cycle: the underglow and side strips run through the colours, in step on every car
  if (L.rainbow) under.onBeforeRender = () => {
    glowMat.color.setHSL((performance.now() / 6000) % 1, 1, 0.5);
    neonM.color.copy(glowMat.color);
    neonM.emissive.copy(glowMat.color);
  };

  // Wheels: rounded tyres, rims in the chosen style over the brake disc, the caliper fixed while the wheel spins
  const wheels = [];
  const half = S.wheelW / 2;
  const rim = rimGeometry(L.rim, G.R);
  for (const z of [S.axles[1], S.axles[0]]) for (const s of [-1, 1]) {
    const x = s * (S.track + (K.flares ? 0.07 : 0));
    const steer = new THREE.Group();
    steer.position.set(x, G.R, z);
    const spin = new THREE.Group();
    steer.add(spin);
    add(G.tyre, tireM, 0, 0, 0, spin).castShadow = true;
    add(G.barrel, panel, 0, 0, 0, spin);
    add(G.rotor, rotorM, -s * 0.03, 0, 0, spin);
    const face = add(rim.face, rimM, s * (half - 0.02), 0, 0, spin);
    if (s < 0) face.rotation.y = Math.PI;
    if (rim.holes) { const h = add(rim.holes, panel, s * (half - 0.02), 0, 0, spin); if (s < 0) h.rotation.y = Math.PI; }
    // brake caliper stays put while the wheel spins
    add(G.caliper, caliperM, s * 0.02, G.R * 0.2, z > 0 ? -G.R * 0.36 : G.R * 0.36, steer);
    group.add(steer);
    wheels.push({ steer, spin, front: z > 0, x, z, r: G.R });
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
    tag.position.set(0, 2.4, 0);
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

  // the body's geometry is shared by every car of this model: left alone rather than copied into each car's merge
  mergeParts(root, { skip: new Set([bodyMesh, ...flames]) });
  for (const w of wheels) mergeParts(w.spin);

  // driver's eye for the cockpit camera: left-hand seat, just under the roof, behind the top of the windshield
  // (the cabin outline is in catalog heights; the body sits DROP lower in the car)
  const [, wsTop] = S.cabin.pts;
  const cockpit = { eye: new THREE.Vector3(0.3, wsTop[1] - DROP - 0.22, wsTop[0] - 0.45) };
  group.userData = { root, wheels, flames, exhausts, flameMatOuter, under, glowMat, tag, shield, skin: car, look: L, isPlayer, tailM, rotorM, track: S.track, rearZ: -S.axles[0], size: { front: S.len[1], rear: -S.len[0], halfW: W }, cockpit };
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

  // Tapered block: a box whose front face (at z0) and rear face (at z1) each get their own width, height and centre
  const taper = (mat, z0, z1, f, r) => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const front = p.getZ(i) > 0, e = front ? f : r;
      p.setXYZ(i, p.getX(i) * e.w + (e.x || 0), p.getY(i) * e.h + e.y, front ? z0 : z1);
    }
    g.computeVertexNormals();
    return add(g, mat);
  };

  // floor: pinched at the nose, wide under the sidepods, narrowing ahead of the rear tyres, trim-coloured edges
  taper(carbon, 2.5, 1.2, { w: 0.5, h: 0.04, y: 0.1 }, { w: 1.5, h: 0.04, y: 0.09 });
  taper(carbon, 1.2, -1.1, { w: 1.5, h: 0.04, y: 0.09 }, { w: 1.5, h: 0.04, y: 0.09 });
  taper(carbon, -1.1, -2.45, { w: 1.1, h: 0.04, y: 0.09 }, { w: 1.0, h: 0.04, y: 0.12 });
  mirrored((s) => taper(trim, 1.1, -1.05, { w: 0.03, h: 0.05, y: 0.11, x: s * 0.73 }, { w: 0.03, h: 0.05, y: 0.11, x: s * 0.75 }));
  // long slim nose dropping toward the front wing, with a trim stripe along its spine
  taper(body, 3.2, 1.5, { w: 0.16, h: 0.1, y: 0.27 }, { w: 0.5, h: 0.32, y: 0.44 });
  taper(trim, 3.05, 1.5, { w: 0.06, h: 0.02, y: 0.33 }, { w: 0.16, h: 0.02, y: 0.61 });
  // survival cell around the cockpit, accent band along its lower half
  taper(body, 1.5, -0.3, { w: 0.5, h: 0.32, y: 0.44 }, { w: 0.66, h: 0.48, y: 0.42 });
  taper(accent, 1.5, -0.3, { w: 0.52, h: 0.1, y: 0.33 }, { w: 0.68, h: 0.12, y: 0.26 });
  // front wing: three elements sweeping up at the tips, tall endplates, pylons up to the nose
  const wing = [];
  mirrored((s) => {
    wing.push(taper(accent, 3.12, 2.78, { w: 0.98, h: 0.035, y: 0.12, x: s * 0.49 }, { w: 0.98, h: 0.035, y: 0.13, x: s * 0.49 }));
    const f1 = taper(body, 2.86, 2.62, { w: 0.9, h: 0.03, y: 0.17, x: s * 0.5 }, { w: 0.9, h: 0.03, y: 0.24, x: s * 0.5 });
    const f2 = taper(trim, 2.7, 2.5, { w: 0.82, h: 0.03, y: 0.23, x: s * 0.54 }, { w: 0.82, h: 0.03, y: 0.32, x: s * 0.54 });
    f1.rotation.z = s * 0.06;
    f2.rotation.z = s * 0.1;
    wing.push(f1, f2);
    wing.push(taper(body, 3.18, 2.5, { w: 0.03, h: 0.16, y: 0.17, x: s * 0.99 }, { w: 0.03, h: 0.34, y: 0.27, x: s * 0.99 }));
    wing.push(taper(carbon, 3.0, 2.9, { w: 0.03, h: 0.18, y: 0.2, x: s * 0.1 }, { w: 0.03, h: 0.18, y: 0.2, x: s * 0.1 }));
  });
  // sidepods: tall intake, deep undercut, then sloping down and in toward the rear (downwash style)
  mirrored((s) => {
    taper(body, 0.85, -0.2, { w: 0.42, h: 0.34, y: 0.42, x: s * 0.6 }, { w: 0.44, h: 0.36, y: 0.38, x: s * 0.6 });
    taper(body, -0.2, -1.5, { w: 0.44, h: 0.36, y: 0.38, x: s * 0.6 }, { w: 0.14, h: 0.12, y: 0.2, x: s * 0.4 });
    taper(carbon, 0.87, 0.83, { w: 0.34, h: 0.12, y: 0.5, x: s * 0.6 }, { w: 0.34, h: 0.12, y: 0.5, x: s * 0.6 }); // intake mouth
    taper(accent, 0.6, -1.2, { w: 0.03, h: 0.1, y: 0.42, x: s * 0.82 }, { w: 0.03, h: 0.04, y: 0.24, x: s * 0.49 }); // livery flash
    taper(carbon, 1.35, 1.0, { w: 0.02, h: 0.24, y: 0.26, x: s * 0.5 }, { w: 0.02, h: 0.2, y: 0.24, x: s * 0.58 }); // turning vane
    box(0.06, 0.05, 0.14, carbon, s * 0.76, 0.66, 0.6); // mirror
    box(0.03, 0.14, 0.03, carbon, s * 0.68, 0.6, 0.6);
  });
  // engine cover: wraps behind the driver and tapers hard into a narrow coke-bottle tail, accent band around it
  taper(body, -0.3, -1.1, { w: 0.62, h: 0.56, y: 0.62 }, { w: 0.5, h: 0.42, y: 0.56 });
  taper(body, -1.1, -2.2, { w: 0.5, h: 0.42, y: 0.56 }, { w: 0.18, h: 0.16, y: 0.42 });
  taper(accent, -0.9, -1.3, { w: 0.55, h: 0.47, y: 0.59 }, { w: 0.47, h: 0.4, y: 0.555 });
  // airbox over the driver's head with a dark inlet and the onboard camera on top
  taper(body, 0.05, -0.6, { w: 0.28, h: 0.24, y: 0.98 }, { w: 0.44, h: 0.3, y: 0.84 });
  taper(carbon, 0.07, 0.03, { w: 0.2, h: 0.16, y: 0.98 }, { w: 0.2, h: 0.16, y: 0.98 });
  box(0.16, 0.05, 0.08, trim, 0, 1.13, -0.05);
  // shark fin carrying the trim colour back to the rear wing
  taper(trim, -0.55, -2.05, { w: 0.025, h: 0.05, y: 1.06 }, { w: 0.025, h: 0.18, y: 0.98 });
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
  // rear wing: swan-neck pylon, mainplane, DRS flap, tall endplates, beam wing, diffuser with strakes
  const plane = (mat, z0, z1, y0, y1, h, w = 1.0) => taper(mat, z0, z1, { w, h, y: y0 }, { w, h, y: y1 });
  plane(accent, -2.12, -2.5, 0.98, 0.94, 0.05);
  plane(trim, -2.36, -2.6, 1.06, 1.16, 0.04, 0.98);
  mirrored((s) => {
    taper(body, -2.1, -2.66, { w: 0.03, h: 0.26, y: 1.0, x: s * 0.52 }, { w: 0.03, h: 0.42, y: 0.98, x: s * 0.52 });
    taper(trim, -2.3, -2.66, { w: 0.035, h: 0.06, y: 1.18, x: s * 0.52 }, { w: 0.035, h: 0.06, y: 1.2, x: s * 0.52 });
  });
  taper(carbon, -2.0, -2.3, { w: 0.05, h: 0.1, y: 0.62 }, { w: 0.05, h: 0.1, y: 0.96 }); // swan neck
  plane(carbon, -2.2, -2.4, 0.46, 0.5, 0.04, 0.86); // beam wing
  taper(carbon, -2.0, -2.62, { w: 1.0, h: 0.06, y: 0.12 }, { w: 1.0, h: 0.06, y: 0.3 });
  for (const x of [-0.36, -0.12, 0.12, 0.36]) taper(carbon, -2.05, -2.62, { w: 0.02, h: 0.1, y: 0.16, x }, { w: 0.02, h: 0.24, y: 0.3, x });
  // rain light plus endplate lights: all flare under braking
  box(0.2, 0.12, 0.05, tailM, 0, 0.42, -2.5);
  mirrored((s) => box(0.035, 0.3, 0.04, tailM, s * 0.54, 0.9, -2.68));

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
  add(new THREE.CylinderGeometry(0.07, 0.08, 0.2, 10).rotateX(Math.PI / 2), carbon, 0, 0.44, -2.3);
  const exhausts = [new THREE.Vector3(0, 0.44, -2.42)];
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

  // the front wing comes off in one piece, so its parts merge among themselves; the driver's body moves as one, as
  // does the steering wheel (less the hands, which come and go)
  const wingParts = mergeParts(root, { only: new Set(wing) });
  mergeParts(root, { skip: new Set([drv, sw, fg, ...arms, ...wingParts]) });
  mergeParts(drv, { skip: new Set([helmet, ...freeArms]) });
  mergeParts(sw, { skip: new Set(hands) });
  for (const w of wheels) mergeParts(w.spin);

  group.userData = { root, wheels, flames: [fg], exhausts, flameMatOuter, under, glowMat, tag, shield, skin: team, isPlayer, tailM, track: 0.82, rearZ: 1.55, size: { front: 3.2, rear: 2.6, halfW: 1.0 }, wing: wingParts, drive, driver: { drv, freeArms, helmet, visor: visorM, setSeated } };
  drive(0);
  return group;
}

// ---------- Menu previews: render each car once into an image ----------
// looks: the garage's per-car looks ({ [car id]: look }), so the cards show the cars as the player made them
export function renderCarThumbs(looks = {}, w = 480, h = 267) { return renderThumbs(CARS, (car) => buildCar(car, { look: looks[car.id] }), w, h); }
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
    m.traverse((o) => { if (o.material) for (const mat of [].concat(o.material)) mat.dispose(); });
    return url;
  });
  env.dispose();
  pmrem.dispose();
  r.dispose();
  r.forceContextLoss();
  return urls;
}
