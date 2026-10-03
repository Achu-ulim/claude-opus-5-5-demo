// Online play: what the game client and the multiplayer server (server/src/index.js) agree on.
// Imported by both sides, so it must stay free of browser, three.js and Workers dependencies.

export const MAX_PLAYERS = 6; // the grid and the points table are built for six racers
export const SNAPSHOT_HZ = 15; // car state updates per second from each racer
export const CODE_LEN = 5;
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to misread when a code is read out
export const RACE_MAPS = ['city', 'aegean', 'egypt', 'snow', 'neon', 'bay', 'dune'];
export const RACE_MODES = ['speed', 'item'];
export const LAP_OPTIONS = [1, 2, 3, 5];
export const CAR_COUNT = 10;
export const FINISH_GRACE = 20; // seconds the rest of the field gets once the winner crosses the line
export const COUNTDOWN = 3; // seconds of 3-2-1 before GO
// Centerline length of each track (m). A lap faster than length / MAX_SPEED can't be driven, so the server rejects it.
export const TRACK_LEN = { city: 2355, aegean: 2499, egypt: 2430, snow: 2151, neon: 2460, bay: 2077, dune: 2455 };
export const MAX_SPEED = 90; // m/s, above the 86 m/s every boost combined is capped at
export const ITEM_EVENTS = ['banana', 'bananaHit', 'missile', 'hit', 'wreck'];

// Names end up in innerHTML and on canvas name tags: keep them short and plain (same rule as league.js)
export function cleanName(s) {
  return String(s || '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

export function normCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
}

// ---------- Car state snapshots ----------
// One compact array per update: [t, x, y, z, h, m, s, vy, d, lat, steer, flags, laps]
// t is the sender's estimate of server time (ms); d and lat place the car on the track; laps is laps done (-1 on the grid)
export const SNAP_LEN = 13;
export const F = { DRIFT: 1, LEFT: 2, AIR: 4, NITRO: 8, BOOST: 16, BRAKE: 32, SHIELD: 64, SPIN: 128, GHOST: 256, WRECK: 512, MAGNET: 1024, FIN: 2048 };

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

export function encodeSnap(c, t) {
  let f = 0;
  if (c.drifting) f |= F.DRIFT;
  if (c.driftDir > 0) f |= F.LEFT;
  if (c.airborne) f |= F.AIR;
  if (c.nitroTime > 0) f |= F.NITRO;
  if (c.smallBoost > 0 || c.padTime > 0 || c.startBoost > 0) f |= F.BOOST;
  if (c.braking) f |= F.BRAKE;
  if (c.shield > 0) f |= F.SHIELD;
  if (c.spin > 0) f |= F.SPIN;
  if (c.ghost > 0) f |= F.GHOST;
  if (c.wreck > 0) f |= F.WRECK;
  if (c.magnet > 0) f |= F.MAGNET;
  if (c.finished) f |= F.FIN;
  return [Math.round(t), r2(c.x), r2(c.y), r2(c.z), r3(wrap(c.h)), r3(wrap(c.m)), r2(c.s), r2(c.vy), r2(c.d), r2(c.lat), r2(c.steer), f, c.lapsDone];
}

export function validSnap(p) {
  if (!Array.isArray(p) || p.length !== SNAP_LEN) return false;
  for (const v of p) if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e13) return false;
  return true;
}

export function decodeSnap(p) {
  return { t: p[0], x: p[1], y: p[2], z: p[3], h: p[4], m: p[5], s: p[6], vy: p[7], d: p[8], lat: p[9], steer: p[10], flags: p[11], laps: p[12] };
}
