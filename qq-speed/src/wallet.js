// The player's tokens, the cars and parts they own and the look fitted to each car, behind one set of functions.
// A logged-in player's wallet is on the server (server/src/wallet.js): it is cached here, so the game starts with it
// and keeps it offline, and changes show at once (optimistically) before the server's answer, its balance, takes over.
// A guest's wallet lives in this browser and never moves to an account (only bought cars and parts can, once, on sign-up).
// Earned-free cars and parts (cups, daily challenges) are the league's to say (Game.has in main.js).
import { item, CAR_ITEMS, REWARDS, DAILY_EARN_CAP, earnAmount, packById } from './catalog.js';
import { cleanLook } from './netproto.js';

const GUEST = 'driftbolt.wallet.v1'; // { balance, owned, looks, ledger: [{ delta, reason, ref, at, label }], held: [claims] }
const CACHE = 'driftbolt.wallet.acct'; // the last account's: { user, snap (GET /wallet), held, watch }
const CAR_IDS = new Set(CAR_ITEMS.map((c) => c.car));
const LEDGER_MAX = 200;
const DAY = 86_400_000;
const POLL = 30_000; // pending payments and waiting rewards are checked this often while the game is open

const read = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage off: this visit only */ } };
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
function cleanLooks(o) {
  const out = {};
  for (const [car, l] of Object.entries(o && typeof o === 'object' ? o : {})) {
    const look = cleanLook(l);
    if (CAR_IDS.has(car) && Object.keys(look).length) out[car] = look;
  }
  return out;
}
// a held claim: { kind, proof, amount, label, at }
const cleanHeld = (h) => (Array.isArray(h) ? h.filter((c) => c && earnAmount(c.kind, c.proof) > 0).slice(-30) : []);

// ---------- the guest wallet ----------
function loadGuest() {
  const d = read(GUEST);
  if (!d) {
    // a new guest starts with the welcome bonus, like a new account
    return { balance: REWARDS.welcome, owned: new Set(), looks: {}, ledger: [{ delta: REWARDS.welcome, reason: 'welcome', ref: 'welcome', at: Date.now() }], held: [] };
  }
  return {
    balance: Number.isInteger(d.balance) && d.balance >= 0 ? d.balance : 0,
    owned: new Set((Array.isArray(d.owned) ? d.owned : []).filter((id) => item(id))),
    looks: cleanLooks(d.looks),
    ledger: Array.isArray(d.ledger) ? d.ledger.filter((r) => r && Number.isInteger(r.delta) && typeof r.ref === 'string').slice(-LEDGER_MAX) : [],
    held: cleanHeld(d.held),
  };
}
const guest = loadGuest();
const saveGuest = () => write(GUEST, { balance: guest.balance, owned: [...guest.owned], looks: guest.looks, ledger: guest.ledger.slice(-LEDGER_MAX), held: guest.held });
function log(delta, reason, ref, label) { guest.ledger.push({ delta, reason, ref, at: Date.now(), ...(label && { label }) }); }
saveGuest();

// ---------- the account wallet ----------
// acct: { base, token, user, snap, owned: Set, held, watch: [references], loaded (the server's or a cached copy),
//   known (seen holds what was already there, so anything new can be announced), seen: Set of ledger rows }
let acct = null;
const listeners = new Set(), creditListeners = new Set();
let onExpired = null;
let timer = 0;

const EMPTY = { balance: 0, earned: 0, bought: 0, owned: [], looks: {}, logos: [], history: [], payments: [], today: 0, cap: DAILY_EARN_CAP, starterUsed: false, invited: null, friends: { joined: 0, rewarded: 0 } };
const rowKey = (r) => `${r.reason}|${r.ref}`;
// what a reward the server added on its own was for
function labelFor(r) {
  if (r.reason === 'league') return 'League race win';
  if (r.reason === 'invite') return r.ref === 'invited' ? 'Invite reward' : 'Your invited friend raced';
  if (r.reason === 'purchase') return `${packById(r.pack)?.name || 'Token'} pack`;
  return 'Reward';
}
function saveAcct() { if (acct) write(CACHE, { user: acct.user, snap: acct.snap, held: acct.held, watch: acct.watch }); }

function changed() {
  if (acct) saveAcct(); else saveGuest();
  for (const fn of listeners) fn();
}
function credit(amount, label) { for (const fn of creditListeners) fn({ amount, label }); }

// a call to the server's /wallet or /pay API: { ok: true, ...answer } or { ok: false, error, ...answer }
async function call(path, body) {
  const a = acct;
  if (!a) return { ok: false, error: 'guest' };
  let res;
  try {
    res = await fetch(a.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${a.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch { return { ok: false, error: 'unreachable' }; }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'session' && acct === a) onExpired?.();
  return res.ok ? { ok: true, ...data } : { ok: false, ...data, error: data.error || 'unreachable' };
}

// ---------- reading ----------
export const isAccount = () => !!acct;
// whether the account's wallet has come from the server at least once (a guest's always has)
export const ready = () => !acct || acct.loaded;
export const getBalance = () => (acct ? acct.snap.balance : guest.balance);
// free, or bought with tokens (on this account, or by this guest)
export function owns(id) {
  const it = item(id);
  return !!it && (it.price === 0 || (acct ? acct.owned : guest.owned).has(id));
}
// the look fitted to a car: part ids per slot (factory parts left out) and the player's colour, plate and logo
export const equipped = (carId) => ({ ...(acct ? acct.snap.looks[carId] : guest.looks[carId]) });
// the logos on the account (keys, newest first); a guest's stay on the device (logos.js)
export const logos = () => (acct ? [...(acct.snap.logos || [])] : []);
// rewards waiting to be added (offline, or over today's cap)
export const held = () => [...(acct ? acct.held : guest.held)];
export function totals() {
  if (acct) { const s = acct.snap; return { earned: s.earned, bought: s.bought, today: s.today, cap: s.cap }; }
  const earned = guest.ledger.filter((r) => ['welcome', 'earn'].includes(r.reason)).reduce((n, r) => n + r.delta, 0);
  return { earned, bought: 0, today: guestToday(), cap: DAILY_EARN_CAP };
}
// newest first: { at, reason, ref, delta, label?, pack?, amount?, status }: the ledger, plus payments still pending or that failed
export function history() {
  if (!acct) return guest.ledger.map((r) => ({ ...r, status: 'done' })).reverse();
  const s = acct.snap;
  const rows = s.history.map((r) => ({ ...r, status: r.reason === 'purchase' ? 'paid' : 'done' }));
  for (const p of s.payments) rows.push({ at: p.at, reason: 'payment', ref: p.reference, delta: p.status === 'pending' ? p.tokens : 0, pack: p.pack, amount: p.amount, status: p.status });
  return rows.sort((x, y) => y.at - x.at);
}
// the rest of what GET /wallet says (starter pack used, invites)
export const info = () => (acct ? acct.snap : null);
export const user = () => acct?.user || null;

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// tokens that arrived on their own: a reward that had to wait, a purchase, a league win or an invite reward
export function onCredit(fn) { creditListeners.add(fn); return () => creditListeners.delete(fn); }

// ---------- whose wallet ----------
// base: the server (http…), token: the session. A wallet cached for this account shows straight away.
export function useAccount({ base, token, user: name, expired }) {
  onExpired = expired;
  if (acct?.user === name) { acct.token = token; acct.base = base; return refresh(); }
  const c = read(CACHE);
  const mine = c?.user === name ? c : null;
  const snap = { ...EMPTY, ...(mine?.snap || {}), looks: cleanLooks(mine?.snap?.looks) };
  acct = {
    base, token, user: name, snap, owned: new Set(snap.owned), held: cleanHeld(mine?.held), watch: Array.isArray(mine?.watch) ? mine.watch.slice(-10) : [],
    loaded: !!mine, known: !!mine, seen: new Set(snap.history.map(rowKey)),
  };
  clearInterval(timer);
  timer = setInterval(tick, POLL);
  changed();
  return refresh();
}

export function useGuest() {
  if (!acct) return;
  acct = null;
  onExpired = null;
  clearInterval(timer);
  timer = setInterval(tick, POLL);
  changed();
}

// the server's wallet, now. Rows that weren't there before and added tokens are announced (league wins, invites, purchases).
export async function refresh() {
  const a = acct;
  if (!a) return { ok: true };
  const r = await call('/wallet');
  if (!r.ok || acct !== a) return r;
  a.snap = { ...EMPTY, ...r, looks: cleanLooks(r.looks) };
  a.owned = new Set(r.owned);
  a.loaded = true;
  for (const row of r.history) {
    const k = rowKey(row);
    if (a.seen.has(k)) continue;
    a.seen.add(k);
    // a purchase this game was waiting for is always announced; the rest only once there was a "before" to compare with
    const waited = row.reason === 'purchase' && a.watch.includes(row.ref.slice(4));
    if (waited) unwatch(row.ref.slice(4));
    if (waited || (a.known && row.delta > 0 && ['league', 'invite', 'purchase'].includes(row.reason))) credit(row.delta, labelFor(row));
  }
  a.known = true;
  changed();
  return r;
}

// ---------- spending ----------
// buy a car or part: { ok, balance } or { ok: false, error: 'short' (need), 'unreachable', 'session', … }
export async function spend(id) {
  const it = item(id);
  if (!it) return { ok: false, error: 'bad_item' };
  if (owns(id)) return { ok: true, balance: getBalance() };
  if (getBalance() < it.price) return { ok: false, error: 'short', need: it.price - getBalance() };
  if (!acct) {
    guest.balance -= it.price;
    guest.owned.add(id);
    log(-it.price, 'unlock', 'unlock:' + id);
    changed();
    return { ok: true, balance: guest.balance };
  }
  // shown as spent straight away; the server's answer decides
  const a = acct, before = a.snap.balance;
  a.snap.balance -= it.price;
  a.owned.add(id);
  changed();
  const r = await call('/wallet/unlock', { itemId: id });
  if (acct !== a) return { ok: false, error: 'session' };
  if (r.ok) {
    a.snap.balance = r.balance;
    a.owned = new Set(r.owned);
    changed();
    refresh();
    return { ok: true, balance: r.balance };
  }
  a.snap.balance = Number.isInteger(r.balance) ? r.balance : before;
  a.owned.delete(id);
  changed();
  return { ok: false, error: r.error, need: r.need };
}

// fit a look to a car (the caller checks the player has each part): { ok } or { ok: false, error, item }
export async function equip(carId, look) {
  if (!CAR_IDS.has(carId)) return { ok: false, error: 'bad_car' };
  const clean = cleanLook(look);
  const looks = acct ? acct.snap.looks : guest.looks;
  const prev = looks[carId];
  if (Object.keys(clean).length) looks[carId] = clean; else delete looks[carId];
  changed();
  if (!acct) return { ok: true };
  const a = acct;
  const r = await call('/wallet/equip', { carId, look: clean });
  if (acct !== a) return { ok: false, error: 'session' };
  if (r.ok) {
    // the server's copy of the look (a refresh that answered meanwhile may have had the old one)
    if (Object.keys(r.look).length) a.snap.looks[carId] = r.look; else delete a.snap.looks[carId];
    a.snap.balance = r.balance;
    changed();
    return { ok: true };
  }
  if (prev) a.snap.looks[carId] = prev; else delete a.snap.looks[carId];
  changed();
  return { ok: false, error: r.error, item: r.item };
}

// a logo the player made (logos.js), up to the account so other players can load it: { ok } or { ok: false, error }.
// url: this device's copy (a data URL). A guest's logo stays on the device, so for a guest there's nothing to do.
export async function uploadLogo(key, url) {
  if (!acct || acct.snap.logos?.includes(key)) return { ok: true };
  if (!url) return { ok: false, error: 'missing' };
  const a = acct;
  const r = await call('/wallet/logo', { image: url.slice(url.indexOf(',') + 1) });
  if (acct !== a) return { ok: false, error: 'session' };
  if (r.ok) {
    a.snap.logos = [r.key, ...(a.snap.logos || []).filter((k) => k !== r.key)];
    changed();
  }
  return r;
}

// ---------- earning ----------
// A reward the game just won (kind and proof as POST /wallet/earn takes them; label names it in the history):
// { ok, amount } once added; { ok: false, held: true } when it has to wait (offline, or over today's cap) and is tried
// again later; { ok: false, error: 'claimed' } when it already was.
export async function earn(kind, proof, label) {
  const amount = earnAmount(kind, proof);
  if (!amount) return { ok: false, error: 'bad_proof' };
  const claim = { kind, proof, amount, label, at: Date.now() };
  const r = acct ? await sendClaim(claim) : guestEarn(claim);
  changed();
  return r;
}

const claimRef = (c) => `${c.kind}:${c.kind === 'challenge' ? `${c.proof.day}:${c.proof.tier}` : c.proof.day || c.proof.run}`;
const stale = (c) => (c.kind === 'challenge' || c.kind === 'streak') && c.proof.day < utcDay(Date.now() - 2 * DAY);
function hold(list, c) { if (!list.some((x) => claimRef(x) === claimRef(c))) list.push(c); }
function unhold(list, c) { const i = list.findIndex((x) => claimRef(x) === claimRef(c)); if (i >= 0) list.splice(i, 1); }

async function sendClaim(c) {
  const a = acct;
  const r = await call('/wallet/earn', { kind: c.kind, proof: c.proof });
  if (acct !== a) return { ok: false, error: 'session' };
  if (r.ok) {
    unhold(a.held, c);
    a.snap.balance = r.balance;
    a.snap.today += r.amount;
    a.seen.add(`earn|${claimRef(c)}`);
    refresh();
    return { ok: true, amount: r.amount, balance: r.balance };
  }
  if (Number.isInteger(r.balance)) a.snap.balance = r.balance;
  // offline or over the cap: it waits; already claimed or no longer claimable: it's done with
  if ((r.error === 'unreachable' || r.error === 'cap' || r.error === 'slow_down') && !stale(c)) { hold(a.held, c); return { ok: false, held: true, error: r.error }; }
  unhold(a.held, c);
  return { ok: false, error: r.error };
}

// a guest's rewards follow the server's rules, in this browser
function guestToday() {
  const start = Date.parse(utcDay());
  return guest.ledger.filter((r) => r.reason === 'earn' && r.at >= start).reduce((n, r) => n + r.delta, 0);
}
function guestEarn(c) {
  const ref = claimRef(c);
  if (guest.ledger.some((r) => r.ref === ref)) { unhold(guest.held, c); return { ok: false, error: 'claimed' }; }
  if (c.kind === 'streak' && guest.ledger.some((r) => r.ref.startsWith('streak:') && r.at > Date.now() - 6 * DAY)) { unhold(guest.held, c); return { ok: false, error: 'claimed' }; }
  if (guestToday() + c.amount > DAILY_EARN_CAP) {
    if (stale(c)) { unhold(guest.held, c); return { ok: false, error: 'too_old' }; }
    hold(guest.held, c);
    return { ok: false, held: true, error: 'cap' };
  }
  unhold(guest.held, c);
  guest.balance += c.amount;
  log(c.amount, 'earn', ref, c.label);
  return { ok: true, amount: c.amount, balance: guest.balance };
}

// rewards that had to wait: try them again (on a new day the cap has room again)
export async function retryHeld() {
  const list = held();
  let added = 0;
  for (const c of list) {
    const r = acct ? await sendClaim(c) : guestEarn(c);
    if (r.ok) { added += r.amount; credit(r.amount, c.label); }
  }
  if (list.length) changed();
  return added;
}

// cars and parts a cup or challenge unlocked on this device go onto the account, so its looks can use them
export async function claimEarned(ids) {
  const want = ids.filter((id) => acct && !acct.owned.has(id));
  if (!want.length) return;
  const a = acct;
  const r = await call('/wallet/claim', { items: want });
  if (r.ok && acct === a) { a.owned = new Set(r.owned); a.snap.owned = r.owned; changed(); }
}

// ---------- a guest garage moving to a new account ----------
// what a guest has bought and fitted, to offer on sign-up (tokens never move)
export function guestGarage() {
  const items = [...guest.owned].filter((id) => item(id)?.price > 0);
  return { items, looks: guest.looks, count: items.length + Object.keys(guest.looks).length };
}
export async function moveGuestGarage() {
  const g = guestGarage();
  const r = await call('/wallet/move', { items: g.items, looks: g.looks });
  if (r.ok) await refresh();
  return r;
}

// ---------- payments (shop.js) ----------
export const payInit = (packId) => call('/pay/init', { packId });
export async function payStatus(reference) {
  const r = await call('/pay/status/' + encodeURIComponent(reference));
  if (r.ok && acct) {
    acct.snap.balance = r.balance;
    // paid: the refresh finds its ledger row (and announces it if this game was waiting for it)
    if (r.status === 'paid') await refresh();
    else if (r.status !== 'pending') unwatch(reference);
    changed();
  }
  return r;
}
// A pack bought on Lagos Life's pay sheet (vatar.js): the server checks it with Vatar and adds its tokens once.
// { ok, pack, tokens, balance, credited } or { ok: false, error }. announce: tell the lobby when this call added them
// (the purchase finished while the game was away); the shop shows its own card instead.
export async function vatarClaim(purchaseId, { announce = false } = {}) {
  const a = acct;
  const r = await call('/vatar/claim', { purchaseId });
  if (r.ok && acct === a) {
    a.seen.add(`purchase|vtr:${purchaseId}`);
    acct.snap.balance = r.balance;
    if (announce && r.credited) credit(r.tokens, `${packById(r.pack)?.name || 'Token'} pack`);
    await refresh();
  }
  return r;
}

// a payment still on its way (a bank transfer): checked every 30 s while the game is open, and announced when it lands
export function watch(reference) { if (acct && !acct.watch.includes(reference)) { acct.watch.push(reference); changed(); } }
export function unwatch(reference) { if (acct) acct.watch = acct.watch.filter((r) => r !== reference); }

async function tick() {
  if (document.hidden) return;
  if (acct) {
    for (const ref of [...acct.watch]) await payStatus(ref);
    if (acct?.held.length) retryHeld();
  } else if (guest.held.length) retryHeld();
}
timer = setInterval(tick, POLL);
