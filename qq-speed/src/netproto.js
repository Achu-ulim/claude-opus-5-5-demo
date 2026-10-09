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
// what a racer's game tells the others about its car: item use and hits, takedowns, and the winner's celebration
export const CAR_EVENTS = ['banana', 'bananaHit', 'missile', 'hit', 'wreck', 'celeb'];
export const CELEBRATIONS = ['burnout', 'donuts', 'fireworks', 'driver'];

// Names end up in innerHTML and on canvas name tags: keep them short and plain (same rule as league.js).
// League names use the same rule with more room.
export function cleanName(s, max = 16) {
  return String(s || '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------- Car looks (the garage) ----------
// Paint, rims, tyres, trim and a race number a player picks for a car. Looks only: they never change how a car drives.
// A glow of 0 (black) means the underglow is off.
export const FINISHES = ['gloss', 'metallic', 'matte', 'pearl', 'chrome'];
export const RIM_STYLES = ['star', 'six', 'split', 'mesh', 'turbine', 'dish'];
export const TYRE_STYLES = ['street', 'redline', 'whitewall', 'letters'];
const COLOR_KEYS = ['paint', 'accent', 'rimColor', 'caliper', 'glow'];

// keeps only well-formed fields, so a look from storage or another player can't break a car
export function cleanLook(l) {
  const out = {};
  if (!l || typeof l !== 'object') return out;
  for (const k of COLOR_KEYS) if (Number.isInteger(l[k]) && l[k] >= 0 && l[k] <= 0xffffff) out[k] = l[k];
  if (FINISHES.includes(l.finish)) out.finish = l.finish;
  if (RIM_STYLES.includes(l.rim)) out.rim = l.rim;
  if (TYRE_STYLES.includes(l.tyre)) out.tyre = l.tyre;
  if (typeof l.stripes === 'boolean') out.stripes = l.stripes;
  // race number on the roof and doors; looks from older games have none, which shows no number
  if (Number.isInteger(l.number) && l.number >= 0 && l.number <= 99) out.number = l.number;
  return out;
}

export function normCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
}

// ---------- Accounts ----------
// A username is 3-16 letters, digits or _, unique ignoring case. The server also turns down reserved and offensive ones.
export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const EMAIL_MAX = 254;
export const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
export const LOGIN_CODE_LEN = 6;
export const RESEND_GAP = 60; // seconds between emailed codes

// ---------- Leagues ----------
// A league is a season of races on a weekly race night, addressed by an invite code like L-7QM4 (room-code characters).
export const LEAGUE_CODE_LEN = 4;
export const LEAGUE_NAME_LEN = 32;
export const LEAGUE_LOBBY_OPEN = 15 * 60_000; // a race night's room opens this long before the start
// what each format allows, and its points for 1st, 2nd, …
export const LEAGUE_FORMATS = {
  f1: { rounds: [6, 12, 24], players: [6, 8, 11], points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1] },
  arcade: { rounds: [4, 8, 12], players: [4, 6], points: [10, 7, 5, 3, 2, 1] },
};
// quick chat: the only messages members can post to a league's feed
export const LEAGUE_CHAT = ['GG', 'Rematch?', 'See you on race night', 'Nice lap', 'Good luck!', "I'm in"];

// "L-7QM4", "l 7qm4" or "7QM4" → "L-7QM4"; anything else → ''
export function normLeagueCode(s) {
  let c = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length === LEAGUE_CODE_LEN + 1 && c[0] === 'L') c = c.slice(1);
  return c.length === LEAGUE_CODE_LEN && [...c].every((ch) => CODE_CHARS.includes(ch)) ? 'L-' + c : '';
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
