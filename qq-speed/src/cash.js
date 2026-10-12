// Cash races: what the game and the server (server/src/cash.js, the Room in server/src/index.js) agree on.
// Real money, completely separate from tokens. A player's cash wallet is in naira or US dollars (their choice); every
// amount is a whole number of minor units: kobo for NGN, cents for USD (₦1 = 100 kobo, $1 = 100 cents).
// Imported by both sides, so it must stay free of browser, three.js and Workers code.
//
// Every number below is a default. The server's CASH_CONFIG var (JSON) can override any key, and the game reads the
// server's values from GET /cash/config, so these only show until that answers.
import { RACE_MAPS, SPEED_CAP } from './netproto.js';

// the CASH_RACES var: 'on', 'withdraw-only' (nothing new goes in, players can still take their money out), anything else is off
export const cashMode = (v) => (v === 'on' || v === 'withdraw-only' ? v : 'off');

export const CURRENCIES = {
  NGN: { symbol: '₦', name: 'Naira' },
  USD: { symbol: '$', name: 'US dollars' },
};

// prize splits; pct is what each place gets of the prize (the pool less the platform fee)
export const SPLITS = {
  wta: { name: 'Winner takes all', pct: [100], minPlayers: 2 },
  top3: { name: 'Top 3 · 60 / 30 / 10', pct: [60, 30, 10], minPlayers: 4 },
};

export const CASH_DEFAULTS = {
  currencies: ['NGN', 'USD'],
  feePct: 10, // the platform's share of each pool
  // entry per player, by currency
  entries: { NGN: [10_000, 20_000, 50_000, 100_000], USD: [100, 200, 500, 1_000] },
  seats: [2, 4, 6],
  splits: ['wta', 'top3'],
  maps: RACE_MAPS,
  laps: [1, 2, 3],
  car: 'gt', // everyone races this car with its stock tune (carModel.js CARS); items are always off
  // the most a player can put in over any 24 hours; each player can set lower limits of their own (raising one waits a day)
  limits: { NGN: { deposit: 5_000_000, entry: 2_000_000 }, USD: { deposit: 5_000, entry: 2_000 } },
  minDeposit: { NGN: 10_000, USD: 100 },
  minWithdrawal: { NGN: 50_000, USD: 500 },
  // Paystack's transfer fee, taken from the amount withdrawn: [up to this amount, fee] in minor units
  transferFee: { NGN: [[500_000, 1_000], [5_000_000, 2_500], [Infinity, 5_000]], USD: [[Infinity, 0]] },
  withdrawalsPerDay: 3,
  withdrawGapMs: 10 * 60_000,
  // converting winnings to tokens: tokens per whole naira or dollar, plus a bonus over buying tokens (₦100 buys 500)
  convertRate: { NGN: 5, USD: 7_500 },
  convertBonusPct: 20,
  exclusionDays: [7, 30, 90],
  minAge: 18,
  fillMs: 10 * 60_000, // a room that isn't full this long after it opened is called off and refunded
  startMs: 3 * 60_000, // a full room that hasn't started this long after filling is called off too
  reportMs: 10 * 60_000, // winnings wait this long for reports before they're paid
  // fair play: the cash car can't beat SPEED_CAP; laps can be this much shorter than the centerline (the racing line);
  // a lap is cut into this many checkpoints, each of which must be passed in order
  topSpeed: SPEED_CAP,
  speedTolerance: 0.1,
  lapMargin: 0.9,
  checkpoints: 8,
};

const plain = (o) => o && typeof o === 'object' && !Array.isArray(o);
// the defaults with an override on top (one level deep: { entries: { NGN: [...] } } keeps the USD entries)
export function cashConfig(override) {
  let o = override;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  const out = { ...CASH_DEFAULTS };
  if (!plain(o)) return out;
  for (const [k, v] of Object.entries(o)) {
    if (!Object.hasOwn(CASH_DEFAULTS, k)) continue;
    out[k] = plain(v) && plain(CASH_DEFAULTS[k]) ? { ...CASH_DEFAULTS[k], ...v } : v;
  }
  // a fee tier written as null in JSON is the open-ended last one
  for (const cur of Object.keys(out.transferFee)) out.transferFee[cur] = out.transferFee[cur].map(([upTo, fee]) => [upTo ?? Infinity, fee]);
  return out;
}

// "₦1,250", "$12.50": minor units shown with the currency's symbol, with the cents only when there are any
export function money(minor, currency = 'NGN') {
  const sym = CURRENCIES[currency]?.symbol ?? '';
  const v = Math.abs(minor) / 100;
  return (minor < 0 ? '−' : '') + sym + v.toLocaleString('en-US', { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

// ---------- payouts ----------
// the pool is every entry; the fee is rounded down so players never lose a part of a kobo to it
export function prizePool(entry, players, feePct) {
  const pool = entry * players;
  const fee = Math.floor((pool * feePct) / 100);
  return { pool, fee, prize: pool - fee };
}

// what each place gets; whatever doesn't divide evenly goes to 1st
export function placeShares(prize, splitId) {
  const shares = (SPLITS[splitId] || SPLITS.wta).pct.map((p) => Math.floor((prize * p) / 100));
  shares[0] += prize - shares.reduce((a, b) => a + b, 0);
  return shares;
}

// the split a room can use: top 3 needs at least 4 players
export const splitAllowed = (splitId, players) => Object.hasOwn(SPLITS, splitId) && players >= SPLITS[splitId].minPlayers;

// finishers: [{ account, time }] in finishing order. Racers on exactly the same time (to the millisecond) share the
// places they tie for equally; the shares of places nobody finished in go to the winner(s). Returns
// [{ account, place, amount }] for everyone who gets something, adding up to the whole prize (an empty list when
// nobody finished).
export function awardPrizes(prize, splitId, finishers) {
  if (!finishers.length) return [];
  const shares = placeShares(prize, splitId);
  const ms = (t) => Math.round(t * 1000);
  const groups = [];
  for (const f of finishers) {
    const g = groups[groups.length - 1];
    if (g && ms(g[0].time) === ms(f.time)) g.push(f);
    else groups.push([f]);
  }
  const unclaimed = shares.slice(finishers.length).reduce((a, b) => a + b, 0);
  const out = [];
  let place = 0;
  groups.forEach((g, gi) => {
    const pot = shares.slice(place, place + g.length).reduce((a, b) => a + b, 0) + (gi === 0 ? unclaimed : 0);
    const each = Math.floor(pot / g.length);
    let rest = pot - each * g.length;
    for (const f of [...g].sort((a, b) => (a.account < b.account ? -1 : 1))) {
      out.push({ account: f.account, place: place + 1, amount: each + (rest > 0 ? 1 : 0) });
      if (rest > 0) rest--;
    }
    place += g.length;
  });
  return out.filter((a) => a.amount > 0);
}

// Paystack's fee for sending this much to a bank
export function transferFee(amount, currency, cfg = CASH_DEFAULTS) {
  const tiers = cfg.transferFee[currency] || [[Infinity, 0]];
  return (tiers.find(([upTo]) => amount <= upTo) || tiers[tiers.length - 1])[1];
}

// tokens for converting this much cash
export function tokensFor(amount, currency, cfg = CASH_DEFAULTS) {
  const rate = cfg.convertRate[currency] || 0;
  return Math.floor(((amount / 100) * rate * (100 + cfg.convertBonusPct)) / 100);
}

// ---------- the game's display names for a cash room's car ----------
// a cash race's car never changes how it drives, but each seat gets its own free paint so the racers can tell each other apart
export const SEAT_PAINTS = ['paint.rosso', 'paint.bolt', 'paint.ice', 'paint.lime', 'paint.violet', 'paint.factory'];

// "C4M9X" → "C-4M9X": how a cash room's code is shown (it's typed and linked without the dash)
export const showCashCode = (code) => (code && code[0] === 'C' ? `C-${code.slice(1)}` : code);
