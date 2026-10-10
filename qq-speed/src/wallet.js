// The player's tokens, the cars and parts they have bought, and the look fitted to each car.
// For now it all lives in this browser (localStorage) with a stand-in balance. The next step moves it to the server
// behind these same functions, which is why spend() and equip() already return promises: the Garage awaits them.
// Free items, and the ones earned from cups and daily challenges, are not stored here (see Game.has in main.js).
import { CAR_ITEMS, item } from './catalog.js';
import { cleanLook } from './netproto.js';

const KEY = 'driftbolt.wallet.v1';
const START_BALANCE = 1250; // until tokens can be bought or earned
const CAR_IDS = new Set(CAR_ITEMS.map((c) => c.car));

function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch { /* no wallet yet, or storage is off */ }
  const looks = {};
  for (const [car, l] of Object.entries(d?.looks || {})) {
    const look = cleanLook(l);
    if (CAR_IDS.has(car) && Object.keys(look).length) looks[car] = look;
  }
  return {
    balance: Number.isInteger(d?.balance) && d.balance >= 0 ? d.balance : START_BALANCE,
    owned: new Set((Array.isArray(d?.owned) ? d.owned : []).filter((id) => item(id))),
    looks,
  };
}

const W = load();
const listeners = new Set();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ balance: W.balance, owned: [...W.owned], looks: W.looks })); } catch { /* private mode: keep it for this visit */ }
  for (const fn of listeners) fn();
}

export function getBalance() { return W.balance; }

// free, or bought with tokens
export function owns(id) { return item(id)?.price === 0 || W.owned.has(id); }

// buy a car or part: { ok: true, balance } or { ok: false, error: 'unknown' | 'short', need }
export async function spend(id) {
  const it = item(id);
  if (!it) return { ok: false, error: 'unknown' };
  if (owns(id)) return { ok: true, balance: W.balance };
  if (W.balance < it.price) return { ok: false, error: 'short', need: it.price - W.balance };
  W.balance -= it.price;
  W.owned.add(id);
  save();
  return { ok: true, balance: W.balance };
}

// fit a look to a car (car id from carModel.js CARS); the caller checks the player has each part
export async function equip(carId, look) {
  if (!CAR_IDS.has(carId)) return;
  const clean = cleanLook(look);
  if (Object.keys(clean).length) W.looks[carId] = clean; else delete W.looks[carId];
  save();
}

// the look fitted to a car: { paint, wheels, bodykit, glow } part ids, factory parts left out
export function equipped(carId) { return { ...W.looks[carId] }; }

// called after any change to the balance, what's owned or a look; returns a function that stops it
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
