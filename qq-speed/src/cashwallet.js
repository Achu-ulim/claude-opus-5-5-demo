// The player's cash wallet, from the server's /cash API (server/src/cash.js): real money, completely separate from tokens
// (wallet.js). Nothing about cash is kept in the browser beyond the last answer; the server's word is the only one.
// Hidden unless the server has cash races on (GET /cash/config), and only for a logged-in account.
import { cashConfig, money } from './cash.js';

let base = '', token = null, user = null;
let config = { mode: 'off', cfg: cashConfig(), kyc: false, payments: false };
let state = null; // GET /cash
const listeners = new Set();
let onExpired = null;
let timer = 0;
let configured = null; // GET /cash/config, once it has been asked

// what each refusal means, and the step that fixes it (winnings.js opens it)
export const REASONS = {
  cash_off: ['Cash races aren\'t open right now.'],
  withdraw_only: ['Cash races are paused: no new deposits or entries. You can still withdraw or convert what you have.'],
  login: ['Cash races need an account. Create one or log in first.', 'login'],
  currency_needed: ['Choose your cash wallet\'s currency first.', 'currency'],
  currency_locked: ['Your wallet\'s currency can only change while it\'s empty and nothing is on its way in or out.'],
  currency_mismatch: ['That room races in another currency than your wallet.'],
  age_needed: ['Confirm your date of birth first: cash races are 18+.', 'age'],
  under_age: ['Cash races are only for players 18 and over.'],
  age_blocked: ['Cash races aren\'t available on this account. If your date of birth was entered wrongly, contact support.'],
  kyc_needed: ['Verify your identity (BVN or NIN) before your first withdrawal.', 'kyc'],
  kyc_failed: ['We couldn\'t verify that ID. Check the number and your name as they are on your ID, then try again.', 'kyc'],
  kyc_unavailable: ['Identity checks aren\'t available yet. Try again later.'],
  kyc_locked: ['Too many tries today. Try again tomorrow, or contact support.'],
  bank_needed: ['Add the bank account to pay your winnings into.', 'bank'],
  bank_mismatch: ['That bank account isn\'t in your verified name, so it can\'t be used. Use an account in your own name, or contact support.', 'bank'],
  bank_unresolved: ['The bank couldn\'t find that account number. Check it and the bank, then try again.', 'bank'],
  bank_currency: ['Paystack can\'t pay out to that account in your wallet\'s currency. Contact support.'],
  bad_bank: ['Enter a 10-digit account number and pick the bank.', 'bank'],
  excluded: ['You\'re taking a break from cash races until {until}.'],
  deposit_limit: ['That\'s over your daily deposit limit: {left} left today.', 'limits'],
  entry_limit: ['That\'s over your daily entry limit: {left} left today.', 'limits'],
  short: ['Not enough cash: you need {need} more.', 'deposit'],
  min_deposit: ['The smallest deposit is {min}.'],
  min_withdrawal: ['The smallest withdrawal is {min}.'],
  withdraw_rate: ['You\'ve made the most withdrawals allowed for now. Try again in {retry}.'],
  payments_off: ['Payments aren\'t set up yet. Try again later.'],
  paystack: ['Paystack didn\'t answer. Try again in a moment.'],
  room_not_found: ['No cash room with that code. Check it, or ask for a fresh invite.'],
  room_full: ['That cash room is full.'],
  room_closed: ['That cash room has closed: it started, or it was called off.'],
  left_room: ['You left that room, so you can\'t rejoin it.'],
  in_room: ['You\'re already in a cash room that hasn\'t finished. Finish or leave it first.'],
  report_closed: ['The report window for that race has closed.'],
  slow_down: ['Too many tries. Wait a few minutes, then try again.'],
  unreachable: ['Can\'t reach the server. Check your connection and try again.'],
};

// "Not enough cash: you need ₦200 more." from a refusal { error, need, left, … }
export function explain(r) {
  const [text, step] = REASONS[r?.error] || [r?.error ? `Something went wrong (${r.error}).` : REASONS.unreachable[0]];
  const cur = state?.currency || 'NGN';
  const until = r?.until ? new Date(r.until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : '';
  const mins = Math.ceil((r?.retryIn || 0) / 60);
  return {
    text: text.replace('{until}', until).replace('{left}', money(r?.left ?? 0, cur)).replace('{need}', money(r?.need ?? 0, cur))
      .replace('{min}', money(r?.min ?? 0, cur)).replace('{retry}', mins > 90 ? `${Math.ceil(mins / 60)} hours` : `${mins} min`),
    step: step || null,
  };
}

// ---------- reading ----------
export const cfg = () => config.cfg;
export const mode = () => config.mode;
export const enabled = () => config.mode !== 'off';
export const get = () => state;
export const isAccount = () => !!token;
export const currency = () => state?.currency || null;
// the lobby's cash pill: cash on, an account, and 18+ confirmed
export const showPill = () => enabled() && !!token && state?.checks?.age === 'done';
export const fmt = (minor) => money(minor, state?.currency || 'NGN');
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) fn(); }

// a call to the server's /cash API: { ok: true, ...answer } or { ok: false, error, ...answer }
export async function call(path, body) {
  if (!token) return { ok: false, error: 'login' };
  const t = token;
  let res;
  try {
    res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${t}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch { return { ok: false, error: 'unreachable' }; }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'session' && token === t) onExpired?.();
  // most answers carry the whole wallet: keep it
  if (res.ok && data.balance && data.checks && token === t) { state = data; changed(); }
  return res.ok ? { ok: true, ...data } : { ok: false, ...data, error: data.error || 'unreachable' };
}

// ---------- setup ----------
// the server's cash rules and whether cash is on at all (any visitor)
export function init(serverBase) {
  base = serverBase;
  if (!base) return (configured = Promise.resolve());
  configured = (async () => {
    try {
      const r = await fetch(base + '/cash/config');
      const d = await r.json();
      config = { mode: d.mode || 'off', cfg: cashConfig(d.cfg), kyc: !!d.kyc, payments: !!d.payments };
    } catch { /* off until the next look */ }
    changed();
    if (token) refresh();
  })();
  return configured;
}
// resolves once the server has said whether cash is on (an invite link can arrive before it has)
export const loaded = () => configured || Promise.resolve();

export function useAccount({ base: b, token: t, user: u, expired }) {
  base = b;
  onExpired = expired;
  if (user !== u) state = null;
  token = t;
  user = u;
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && enabled()) refresh(); }, 30_000);
  changed();
  return refresh();
}

export function useGuest() {
  token = null;
  user = null;
  state = null;
  clearInterval(timer);
  changed();
}

export async function refresh() {
  if (!token || !enabled()) return { ok: false };
  return call('/cash');
}

// ---------- actions ----------
export const setCurrency = (c) => call('/cash/currency', { currency: c });
export const setAge = (dob) => call('/cash/age', { dob });
export const verifyId = (input) => call('/cash/kyc', input);
export const banks = () => call('/cash/banks');
export const setBank = (bankCode, accountNumber) => call('/cash/bank', { bankCode, accountNumber });
export const setLimits = (limits) => call('/cash/limits', limits);
export const takeBreak = (days) => call('/cash/exclude', { days });
export const depositInit = (amount) => call('/cash/deposit/init', { amount });
export const depositStatus = (ref) => call('/cash/deposit/status/' + encodeURIComponent(ref));
export const withdraw = (amount) => call('/cash/withdraw', { amount });
export const convert = (amount) => call('/cash/convert', { amount });
export const createRoom = (o) => call('/cash/rooms', o);
export const joinRoom = (code) => call('/cash/rooms/join', { code });
export const room = (code) => call('/cash/rooms/' + encodeURIComponent(code));
export const report = (code, reason) => call('/cash/rooms/report', { code, reason });
