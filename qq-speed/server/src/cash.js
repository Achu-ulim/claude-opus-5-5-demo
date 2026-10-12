// Cash wallets and cash races, in the Accounts object's SQLite next to the token wallet (accounts.js owns the tables and
// calls these). Real money, kept completely apart from tokens: the only bridge is converting cash to tokens, one way.
// Behind the CASH_RACES var: 'on'; 'withdraw-only' (no deposits or entries, money can still go out); anything else off.
//
// The ledger is double-entry. Every movement is a set of rows sharing one txn key that add up to zero, between players'
// accounts (their account id) and accounts of our own:
//   room:<code>      a race's holding pot: entries go in when they're held and come out as refunds, prizes and the fee
//   house:fees       the platform's fees
//   ext:paystack     money from outside (deposits)
//   ext:bank         money sent to players' banks (withdrawals)
//   ext:transfer_fees  Paystack's transfer fees on withdrawals
//   ext:tokens       cash converted to tokens
// A balance is the sum of an account's rows, never a stored number, and amounts are whole kobo (or cents for USD).
// A txn key ('hold:C4M9X:<account>', 'dep:<reference>', …) can only be posted once, which makes every movement
// exactly-once however often a webhook, a retry or an alarm asks for it.
import { cashConfig, cashMode, CURRENCIES, splitAllowed, prizePool, awardPrizes, transferFee, tokensFor, money } from '../../src/cash.js';
import { CODE_CHARS, TRACK_LEN } from '../../src/netproto.js';
import { paystack, paymentsReady } from './pay.js';
import { verifyIdentity, kycReady, namesMatch, fullName, ID_TYPES } from './kyc.js';
import { sendMail, cashMail } from './mail.js';

export const CASH_SCHEMA = [
  // amount_kobo is in the currency's minor unit (kobo for NGN, cents for USD); kind: deposit | entry_hold | entry_refund |
  // prize | fee | withdrawal | withdrawal_reversal | convert; ref: what it was for (a room code, a payment reference)
  `CREATE TABLE IF NOT EXISTS cash_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, txn TEXT NOT NULL, account_id TEXT NOT NULL,
    currency TEXT NOT NULL, amount_kobo INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS cash_ledger_txn ON cash_ledger (txn, account_id)',
  'CREATE INDEX IF NOT EXISTS cash_ledger_account ON cash_ledger (account_id, currency, created_at)',
  // a player's cash settings and checks. Identity: only the result, the name the provider returned and when; never the
  // ID number. Bank: the bank, the last 4 digits, the account's name and Paystack's transfer recipient.
  `CREATE TABLE IF NOT EXISTS cash_profiles (account_id TEXT PRIMARY KEY, currency TEXT, dob TEXT, age_ok_at INTEGER,
    age_blocked INTEGER NOT NULL DEFAULT 0, kyc_status TEXT, kyc_type TEXT, kyc_name TEXT, kyc_at INTEGER, kyc_reason TEXT,
    bank_code TEXT, bank_name TEXT, bank_last4 TEXT, bank_account_name TEXT, recipient_code TEXT, bank_at INTEGER, bank_changed_at INTEGER,
    deposit_limit INTEGER, entry_limit INTEGER, limit_pending TEXT, excluded_until INTEGER, created_at INTEGER NOT NULL)`,
  // status: pending | paid | failed | abandoned
  `CREATE TABLE IF NOT EXISTS cash_deposits (reference TEXT PRIMARY KEY, account_id TEXT NOT NULL, currency TEXT NOT NULL,
    amount_kobo INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL DEFAULT 0, note TEXT)`,
  'CREATE INDEX IF NOT EXISTS cash_deposits_account ON cash_deposits (account_id, created_at)',
  // status: review (flagged, not sent) | pending (sent to Paystack) | paid | failed | reversed | rejected
  `CREATE TABLE IF NOT EXISTS cash_withdrawals (reference TEXT PRIMARY KEY, account_id TEXT NOT NULL, currency TEXT NOT NULL,
    amount_kobo INTEGER NOT NULL, fee_kobo INTEGER NOT NULL, status TEXT NOT NULL, flags TEXT, bank TEXT, recipient_code TEXT,
    transfer_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0, note TEXT)`,
  'CREATE INDEX IF NOT EXISTS cash_withdrawals_account ON cash_withdrawals (account_id, created_at)',
  // status: open → racing → window (the report window) → settled; or refunded; or review (frozen until an admin decides)
  `CREATE TABLE IF NOT EXISTS cash_rooms (code TEXT PRIMARY KEY, host TEXT NOT NULL, currency TEXT NOT NULL, entry_kobo INTEGER NOT NULL,
    seats INTEGER NOT NULL, split TEXT NOT NULL, map TEXT NOT NULL, laps INTEGER NOT NULL, fee_pct REAL NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, full_at INTEGER, started_at INTEGER, release_at INTEGER, settled_at INTEGER,
    result TEXT, plan TEXT, flags TEXT, reports TEXT, note TEXT)`,
  'CREATE INDEX IF NOT EXISTS cash_rooms_status ON cash_rooms (status)',
  // who paid into a room; left_at once their entry was refunded before the start
  `CREATE TABLE IF NOT EXISTS cash_seats (code TEXT NOT NULL, account_id TEXT NOT NULL, username TEXT NOT NULL, joined_at INTEGER NOT NULL,
    left_at INTEGER, PRIMARY KEY (code, account_id))`,
  'CREATE INDEX IF NOT EXISTS cash_seats_account ON cash_seats (account_id, joined_at)',
  // what the server recorded of a cash race, for review (fair.js replayOf)
  'CREATE TABLE IF NOT EXISTS cash_replays (code TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)',
  // every admin action
  `CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, admin TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT NOT NULL, note TEXT)`,
];

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const SYS = { fees: 'house:fees', paystack: 'ext:paystack', bank: 'ext:bank', transferFees: 'ext:transfer_fees', tokens: 'ext:tokens' };
const roomAcct = (code) => 'room:' + code;
const ACTIVE = ['open', 'racing', 'window', 'review'];
const RACE_STUCK = 30 * MIN; // a race that hasn't reported this long after it started goes to review
const CHECK_EVERY = 5 * MIN; // pending deposits and transfers are checked with Paystack this often
const DEPOSIT_GIVE_UP = DAY;
const DOB_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEPOSIT_RE = /^DC-[A-Z0-9]{6}-\d{4}$/;
const WITHDRAW_RE = /^dbw-[a-z0-9]{16}$/;
const ok = (body) => ({ status: 200, body });
const fail = (status, error, extra) => ({ status, body: { error, ...extra } });
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const rand = (n, chars) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => chars[x % chars.length]).join('');
const ddmm = (d = new Date()) => `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const metaKind = (d) => (typeof d?.metadata === 'string' ? parse(d.metadata, {}) : d?.metadata || {})?.kind;

// the refusal codes the game turns into the next step to take (src/cashwallet.js)
const NEEDS = {
  currency: () => fail(409, 'currency_needed'),
  age: () => fail(403, 'age_needed'),
  ageBlocked: () => fail(403, 'age_blocked'),
  kyc: () => fail(403, 'kyc_needed'),
  bank: () => fail(403, 'bank_needed'),
};

export class Cash {
  // A: the Accounts object (its sql, row(), ctx, env, wallet)
  constructor(A) {
    this.A = A;
    this.sql = A.sql;
    this.inTxn = false;
    this.banks = null; // { at, list } Paystack's bank list, per currency
  }

  get env() { return this.A.env; }
  get mode() { return cashMode(this.env.CASH_RACES); }
  get cfg() {
    const raw = this.env.CASH_CONFIG;
    const key = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
    if (this.cfgKey !== key) { this.cfgKey = key; this.cfgVal = cashConfig(raw); }
    return this.cfgVal;
  }
  row(q, ...args) { return this.A.row(q, ...args); }
  all(q, ...args) { return this.sql.exec(q, ...args).toArray(); }
  // one SQLite transaction (nested calls join the outer one)
  atomic(fn) {
    if (this.inTxn) return fn();
    this.inTxn = true;
    try { return this.A.ctx.storage.transactionSync(fn); } finally { this.inTxn = false; }
  }

  // ---------- the ledger ----------
  balance(account, currency) {
    return this.row('SELECT COALESCE(SUM(amount_kobo), 0) AS b FROM cash_ledger WHERE account_id = ? AND currency = ?', account, currency).b;
  }
  posted(txn) { return !!this.row('SELECT 1 AS y FROM cash_ledger WHERE txn = ? LIMIT 1', txn); }
  // legs: [[account, amount], …] adding up to zero. Posts once per txn key: false if it was already posted.
  post(txn, kind, ref, currency, legs, at = Date.now()) {
    const rows = legs.filter(([, amt]) => amt !== 0);
    if (rows.some(([, amt]) => !Number.isInteger(amt)) || rows.reduce((s, [, amt]) => s + amt, 0) !== 0) throw new Error(`cash: unbalanced ${txn}`);
    return this.atomic(() => {
      if (this.posted(txn)) return false;
      for (const [acct, amt] of rows) {
        this.sql.exec('INSERT INTO cash_ledger (txn, account_id, currency, amount_kobo, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', txn, acct, currency, amt, kind, ref, at);
      }
      return true;
    });
  }

  // ---------- profiles and checks ----------
  profile(id) {
    let p = this.row('SELECT * FROM cash_profiles WHERE account_id = ?', id);
    if (!p) {
      this.sql.exec('INSERT OR IGNORE INTO cash_profiles (account_id, created_at) VALUES (?, ?)', id, Date.now());
      p = this.row('SELECT * FROM cash_profiles WHERE account_id = ?', id);
    }
    // a raised limit takes effect a day after it was asked for
    const pend = parse(p.limit_pending);
    if (pend && pend.at <= Date.now()) {
      this.sql.exec('UPDATE cash_profiles SET deposit_limit = ?, entry_limit = ?, limit_pending = NULL WHERE account_id = ?',
        pend.deposit ?? p.deposit_limit, pend.entry ?? p.entry_limit, id);
      p = this.row('SELECT * FROM cash_profiles WHERE account_id = ?', id);
    }
    return p;
  }

  // the player's own limits, never above the platform's
  limits(p) {
    const cap = this.cfg.limits[p.currency] || { deposit: 0, entry: 0 };
    return { deposit: Math.min(p.deposit_limit ?? cap.deposit, cap.deposit), entry: Math.min(p.entry_limit ?? cap.entry, cap.entry), cap };
  }
  depositedIn24h(id) {
    return this.row(`SELECT COALESCE(SUM(amount_kobo), 0) AS s FROM cash_deposits WHERE account_id = ? AND status IN ('pending', 'paid') AND created_at > ?`, id, Date.now() - DAY).s;
  }
  // entries put up in the last 24 hours, less the ones that were refunded
  enteredIn24h(id, currency) {
    return Math.max(0, -this.row(`SELECT COALESCE(SUM(amount_kobo), 0) AS s FROM cash_ledger WHERE account_id = ? AND currency = ?
      AND kind IN ('entry_hold', 'entry_refund') AND created_at > ?`, id, currency, Date.now() - DAY).s);
  }
  excluded(p) { return p.excluded_until && p.excluded_until > Date.now() ? p.excluded_until : 0; }

  // what moving money in needs: cash on, a currency, 18+, no self-exclusion
  canPutIn(p) {
    if (this.mode !== 'on') return fail(403, this.mode === 'withdraw-only' ? 'withdraw_only' : 'cash_off');
    if (!p.currency) return NEEDS.currency();
    if (p.age_blocked) return NEEDS.ageBlocked();
    if (!p.age_ok_at) return NEEDS.age();
    const until = this.excluded(p);
    if (until) return fail(403, 'excluded', { until });
    return null;
  }

  // an entry for a room: the above, the entry limit and enough balance
  canEnter(p, amount) {
    const no = this.canPutIn(p);
    if (no) return no;
    const used = this.enteredIn24h(p.account_id, p.currency), lim = this.limits(p).entry;
    if (used + amount > lim) return fail(403, 'entry_limit', { left: Math.max(0, lim - used), limit: lim });
    const bal = this.balance(p.account_id, p.currency);
    if (bal < amount) return fail(402, 'short', { need: amount - bal, balance: bal });
    return null;
  }

  // ---------- the /cash API ----------
  // A: the session's account. ctx: { origin, local } from the Worker (local: the request came from this machine).
  async api(A, action, input, ctx) {
    this.local = ctx.local; // only for showing whether identity checks are on (kycReady)
    if (action === 'get') return ok(this.view(A));
    if (this.mode === 'off') return fail(404, 'cash_off');
    const p = this.profile(A.id);
    switch (action) {
      case 'currency': return this.setCurrency(A, p, input.currency);
      case 'age': return this.setAge(A, p, input.dob);
      case 'kyc': return this.checkIdentity(A, p, input, ctx);
      case 'banks': return this.bankList(p);
      case 'bank': return this.setBank(A, p, input);
      case 'limits': return this.setLimits(A, p, input);
      case 'exclude': return this.exclude(A, p, input.days);
      case 'deposit/init': return this.depositInit(A, p, input.amount, ctx.origin);
      case 'deposit/status': return this.depositStatus(A, input.reference);
      case 'withdraw': return this.withdraw(A, p, input.amount);
      case 'convert': return this.convert(A, p, input.amount);
      case 'rooms/create': return this.createRoom(A, p, input);
      case 'rooms/join': return this.joinRoom(A, p, input.code);
      case 'rooms/get': return this.roomFor(A, input.code);
      case 'rooms/report': return this.report(A, input.code, input.reason);
    }
    return fail(404, 'not_found');
  }

  // GET /cash: everything the Winnings screen and the lobby pill show
  view(A) {
    const p = this.profile(A.id), cur = p.currency, now = Date.now(), cfg = this.cfg;
    const available = cur ? this.balance(A.id, cur) : 0;
    // prizes waiting out the report window (or held for review)
    const arriving = [];
    for (const r of this.all(`SELECT code, status, release_at, plan, currency FROM cash_rooms WHERE status IN ('window', 'review') AND code IN
      (SELECT code FROM cash_seats WHERE account_id = ?)`, A.id)) {
      const award = parse(r.plan)?.awards?.find((a) => a.account === A.id);
      if (award) arriving.push({ code: r.code, amount: award.amount, currency: r.currency, releaseAt: r.status === 'window' ? r.release_at : null, held: r.status === 'review' });
    }
    const lim = cur ? this.limits(p) : null;
    const age = p.age_ok_at ? 'done' : p.age_blocked ? 'blocked' : 'needed';
    const kyc = p.kyc_status === 'verified' ? 'done' : p.kyc_status === 'failed' ? 'failed' : 'needed';
    const bank = p.recipient_code ? 'done' : 'needed';
    const rooms = this.all(`SELECT r.code, r.status, r.entry_kobo AS entry, r.seats, r.currency, r.expires_at AS expiresAt, r.release_at AS releaseAt,
      (SELECT COUNT(*) FROM cash_seats s WHERE s.code = r.code AND s.left_at IS NULL) AS paid
      FROM cash_rooms r WHERE r.status IN ('open', 'racing', 'window', 'review') AND r.code IN (SELECT code FROM cash_seats WHERE account_id = ? AND left_at IS NULL)
      ORDER BY r.created_at DESC LIMIT 5`, A.id);
    return {
      mode: this.mode, currency: cur || null,
      balance: { available, arriving, total: available + arriving.reduce((s, a) => s + a.amount, 0) },
      checks: {
        age, dob: p.dob || null,
        kyc, kycName: p.kyc_name || null, kycType: p.kyc_type ? ID_TYPES[p.kyc_type] : null, kycAt: p.kyc_at || null, kycReason: p.kyc_reason || null,
        bank, bankName: p.bank_name || null, bankLast4: p.bank_last4 || null, bankAccountName: p.bank_account_name || null,
        kycReady: kycReady(this.env, !!this.local),
      },
      limits: lim && { deposit: lim.deposit, entry: lim.entry, depositMax: lim.cap.deposit, entryMax: lim.cap.entry,
        depositUsed: this.depositedIn24h(A.id), entryUsed: this.enteredIn24h(A.id, cur), pending: parse(p.limit_pending) },
      excludedUntil: this.excluded(p) || null,
      withdrawals: this.all(`SELECT reference, amount_kobo AS amount, fee_kobo AS fee, currency, status, bank, created_at AS at, updated_at AS updated
        FROM cash_withdrawals WHERE account_id = ? ORDER BY created_at DESC LIMIT 10`, A.id),
      deposits: this.all(`SELECT reference, amount_kobo AS amount, currency, status, created_at AS at FROM cash_deposits
        WHERE account_id = ? AND status != 'paid' AND created_at > ? ORDER BY created_at DESC LIMIT 10`, A.id, now - 7 * DAY),
      rooms,
      history: this.all(`SELECT kind, amount_kobo AS amount, currency, ref, created_at AS at FROM cash_ledger WHERE account_id = ?
        ORDER BY id DESC LIMIT 40`, A.id),
      payments: paymentsReady(this.env),
    };
  }

  // ---------- currency, age ----------
  // a wallet's currency can change only while it's empty and nothing is on its way in or out
  setCurrency(A, p, currency) {
    if (!this.cfg.currencies.includes(currency) || !Object.hasOwn(CURRENCIES, currency)) return fail(400, 'bad_currency');
    if (p.currency === currency) return ok(this.view(A));
    if (p.currency) {
      const busy = this.balance(A.id, p.currency) !== 0
        || this.row(`SELECT 1 AS y FROM cash_seats s JOIN cash_rooms r ON r.code = s.code WHERE s.account_id = ? AND s.left_at IS NULL AND r.status IN ('open', 'racing', 'window', 'review')`, A.id)
        || this.row(`SELECT 1 AS y FROM cash_deposits WHERE account_id = ? AND status = 'pending'`, A.id)
        || this.row(`SELECT 1 AS y FROM cash_withdrawals WHERE account_id = ? AND status IN ('review', 'pending')`, A.id);
      if (busy) return fail(409, 'currency_locked');
    }
    // limits were in the old currency's money: back to the platform's for the new one
    this.sql.exec('UPDATE cash_profiles SET currency = ?, deposit_limit = NULL, entry_limit = NULL, limit_pending = NULL WHERE account_id = ?', currency, A.id);
    return ok(this.view(A));
  }

  // date of birth, once: 18+ unlocks cash; under 18 locks it on this account (support can look at a mistake)
  setAge(A, p, dob) {
    if (p.dob) return p.age_ok_at ? ok(this.view(A)) : NEEDS.ageBlocked();
    const m = typeof dob === 'string' ? DOB_RE.exec(dob) : null;
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || +m[1] < 1900 || d > new Date()) return fail(400, 'bad_dob');
    const now = new Date();
    let age = now.getUTCFullYear() - d.getUTCFullYear();
    if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
    const adult = age >= this.cfg.minAge;
    this.sql.exec('UPDATE cash_profiles SET dob = ?, age_ok_at = ?, age_blocked = ? WHERE account_id = ?', dob, adult ? Date.now() : null, adult ? 0 : 1, A.id);
    return adult ? ok(this.view(A)) : fail(403, 'under_age');
  }

  // ---------- identity (kyc.js) ----------
  async checkIdentity(A, p, input, ctx) {
    if (!p.age_ok_at) return p.age_blocked ? NEEDS.ageBlocked() : NEEDS.age();
    if (p.kyc_status === 'verified') return ok(this.view(A));
    const type = input.type, number = typeof input.number === 'string' ? input.number.replace(/\D/g, '') : '';
    const name = (k) => (typeof input[k] === 'string' ? input[k].replace(/[^\p{L}\s'-]/gu, '').trim().slice(0, 40) : '');
    const who = { first: name('firstName'), middle: name('middleName'), last: name('lastName') };
    if (!Object.hasOwn(ID_TYPES, type)) return fail(400, 'bad_id_type');
    if (!/^\d{11}$/.test(number)) return fail(400, 'bad_id');
    if (!who.first || !who.last) return fail(400, 'bad_name');
    if (!kycReady(this.env, ctx.local)) return fail(503, 'kyc_unavailable');
    const wait = this.A.limit('kyc:acct', A.id);
    if (wait) return fail(429, 'kyc_locked', { retryIn: Math.ceil(wait / 1000) });
    const r = await verifyIdentity(this.env, ctx.local, { type, number, firstName: who.first, middleName: who.middle, lastName: who.last, dob: p.dob });
    const now = Date.now();
    if (r.ok && r.dob && r.dob !== p.dob) r.ok = false, r.reason = 'dob_mismatch';
    if (!r.ok) {
      if (r.reason === 'unavailable') return fail(503, 'kyc_unavailable');
      this.sql.exec("UPDATE cash_profiles SET kyc_status = 'failed', kyc_type = ?, kyc_reason = ?, kyc_at = ? WHERE account_id = ?", type, r.reason || 'failed', now, A.id);
      return fail(422, 'kyc_failed', { reason: r.reason || 'failed' });
    }
    this.sql.exec("UPDATE cash_profiles SET kyc_status = 'verified', kyc_type = ?, kyc_name = ?, kyc_at = ?, kyc_reason = NULL WHERE account_id = ?",
      type, fullName(r.name), now, A.id);
    return ok(this.view(A));
  }

  // ---------- bank account (Paystack: /bank, /bank/resolve, /transferrecipient) ----------
  async bankList(p) {
    const cur = p.currency || 'NGN';
    if (!paymentsReady(this.env)) return fail(503, 'payments_off');
    const c = this.banks?.[cur];
    if (c && Date.now() - c.at < 6 * HOUR) return ok({ banks: c.list });
    try {
      const d = await paystack(this.env, `/bank?currency=${cur}&perPage=200`);
      const list = (Array.isArray(d) ? d : []).filter((b) => b.active !== false && typeof b.code === 'string')
        .map((b) => ({ code: b.code, name: String(b.name).slice(0, 60) })).sort((a, b) => a.name.localeCompare(b.name));
      (this.banks ||= {})[cur] = { at: Date.now(), list };
      return ok({ banks: list });
    } catch { return fail(502, 'paystack'); }
  }

  // the account's name at the bank has to be the verified person's; Paystack's transfer recipient is made once here
  async setBank(A, p, input) {
    if (!p.age_ok_at) return p.age_blocked ? NEEDS.ageBlocked() : NEEDS.age();
    if (p.kyc_status !== 'verified') return NEEDS.kyc();
    if (!p.currency) return NEEDS.currency();
    const number = typeof input.accountNumber === 'string' ? input.accountNumber.replace(/\D/g, '') : '';
    const code = typeof input.bankCode === 'string' && /^[0-9A-Za-z]{2,12}$/.test(input.bankCode) ? input.bankCode : '';
    if (!/^\d{10}$/.test(number) || !code) return fail(400, 'bad_bank');
    if (!paymentsReady(this.env)) return fail(503, 'payments_off');
    const wait = this.A.limit('bank:acct', A.id);
    if (wait) return fail(429, 'slow_down', { retryIn: Math.ceil(wait / 1000) });
    // Paystack turning an account down (validation_error, or 422 from the stand-in) means the bank doesn't know it; any
    // other failure (its limits, an outage) is Paystack's, to try again later
    const refused = (e) => e?.type === 'validation_error' || (e?.status === 422 && !e?.type);
    let accountName;
    try {
      const d = await paystack(this.env, `/bank/resolve?account_number=${number}&bank_code=${encodeURIComponent(code)}`);
      accountName = String(d.account_name || '').trim();
    } catch (e) { return refused(e) ? fail(422, 'bank_unresolved') : fail(502, 'paystack'); }
    if (!accountName) return fail(422, 'bank_unresolved');
    if (!namesMatch(p.kyc_name, accountName)) return fail(422, 'bank_mismatch', { accountName, verifiedName: p.kyc_name });
    let recipient;
    try {
      const d = await paystack(this.env, '/transferrecipient', { type: 'nuban', name: accountName, account_number: number, bank_code: code, currency: p.currency });
      recipient = d.recipient_code;
    } catch (e) { return !refused(e) ? fail(502, 'paystack') : p.currency !== 'NGN' ? fail(502, 'bank_currency') : fail(422, 'bank_unresolved'); }
    if (typeof recipient !== 'string') return fail(502, 'paystack');
    if (!this.banks?.[p.currency]) await this.bankList(p);
    const bankName = (this.banks?.[p.currency]?.list || []).find((b) => b.code === code)?.name || 'Bank';
    const now = Date.now();
    this.sql.exec(`UPDATE cash_profiles SET bank_code = ?, bank_name = ?, bank_last4 = ?, bank_account_name = ?, recipient_code = ?, bank_at = ?,
      bank_changed_at = ? WHERE account_id = ?`, code, bankName, number.slice(-4), accountName, recipient, now, p.recipient_code ? now : p.bank_changed_at, A.id);
    return ok(this.view(A));
  }

  // ---------- responsible play ----------
  // lowering a limit works at once; raising one waits 24 hours
  setLimits(A, p, input) {
    if (!p.currency) return NEEDS.currency();
    const lim = this.limits(p), now = Date.now();
    const next = {}, pending = parse(p.limit_pending) || {};
    for (const k of ['deposit', 'entry']) {
      const v = input[k];
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v <= 0) return fail(400, 'bad_limit', { which: k });
      const val = Math.min(v, lim.cap[k]);
      if (val <= lim[k]) { next[k] = val; delete pending[k]; } else pending[k] = val;
    }
    const keep = Object.keys(pending).some((k) => k !== 'at');
    if (keep) pending.at = pending.at && pending.at > now ? pending.at : now + DAY;
    this.sql.exec('UPDATE cash_profiles SET deposit_limit = ?, entry_limit = ?, limit_pending = ? WHERE account_id = ?',
      next.deposit ?? p.deposit_limit, next.entry ?? p.entry_limit, keep ? JSON.stringify(pending) : null, A.id);
    return ok(this.view(A));
  }

  // a break from cash races: no entries or deposits until it's over (it can't be ended early)
  exclude(A, p, days) {
    if (!this.cfg.exclusionDays.includes(days)) return fail(400, 'bad_days');
    const until = Math.max(p.excluded_until || 0, Date.now() + days * DAY);
    this.sql.exec('UPDATE cash_profiles SET excluded_until = ? WHERE account_id = ?', until, A.id);
    return ok(this.view(A));
  }

  // ---------- deposits (Paystack, as token purchases in wallet.js, but metadata.kind = 'cash_deposit') ----------
  async depositInit(A, p, amount, origin) {
    const no = this.canPutIn(p);
    if (no) return no;
    if (!paymentsReady(this.env)) return fail(503, 'payments_off');
    const min = this.cfg.minDeposit[p.currency] || 1;
    if (!Number.isInteger(amount) || amount < min) return fail(400, 'min_deposit', { min });
    const lim = this.limits(p).deposit, used = this.depositedIn24h(A.id);
    if (used + amount > lim) return fail(403, 'deposit_limit', { left: Math.max(0, lim - used), limit: lim });
    let reference;
    do reference = `DC-${rand(6, CODE_CHARS)}-${ddmm()}`; while (this.row('SELECT 1 AS y FROM cash_deposits WHERE reference = ?', reference));
    const now = Date.now();
    this.sql.exec(`INSERT INTO cash_deposits (reference, account_id, currency, amount_kobo, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      reference, A.id, p.currency, amount, now, now);
    try {
      const d = await paystack(this.env, '/transaction/initialize', {
        email: A.email, amount, currency: p.currency, reference,
        metadata: { kind: 'cash_deposit', accountId: A.id }, callback_url: `${origin}/?cashpay=${reference}`,
      });
      if (typeof d.access_code !== 'string') throw new Error('no access code');
      await this.A.schedule();
      return ok({ reference, access_code: d.access_code });
    } catch (e) {
      console.error(`cash: deposit initialize failed for ${reference} (${e.message})`);
      this.sql.exec("UPDATE cash_deposits SET status = 'failed', note = 'init', updated_at = ? WHERE reference = ?", Date.now(), reference);
      return fail(502, 'paystack');
    }
  }

  async depositStatus(A, reference) {
    if (typeof reference !== 'string' || !DEPOSIT_RE.test(reference)) return fail(400, 'bad_reference');
    let d = this.row('SELECT * FROM cash_deposits WHERE reference = ? AND account_id = ?', reference, A.id);
    if (!d) return fail(404, 'not_found');
    const now = Date.now();
    if (d.status === 'pending' && now - d.created_at > 2 * MIN && now - d.checked_at > MIN && paymentsReady(this.env)) {
      await this.verifyDeposit(reference);
      d = this.row('SELECT * FROM cash_deposits WHERE reference = ?', reference);
    }
    return ok({ status: d.status, amount: d.amount_kobo, currency: d.currency, balance: this.balance(A.id, d.currency) });
  }

  // the webhook's charge.success for a cash deposit: Paystack's own verify decides
  async depositConfirm(reference) {
    if (typeof reference !== 'string' || !DEPOSIT_RE.test(reference)) return;
    const d = this.row('SELECT status FROM cash_deposits WHERE reference = ?', reference);
    if (d && d.status !== 'paid') await this.verifyDeposit(reference);
  }

  async verifyDeposit(reference) {
    this.sql.exec('UPDATE cash_deposits SET checked_at = ? WHERE reference = ?', Date.now(), reference);
    let d;
    try { d = await paystack(this.env, '/transaction/verify/' + encodeURIComponent(reference)); } catch (e) {
      console.error(`cash: verify failed for ${reference} (${e.message})`);
      return;
    }
    const mail = this.settleDeposit(reference, d);
    if (mail) await sendMail(this.env, mail);
  }

  // credited once, and only for a successful cash deposit of exactly our amount and currency
  settleDeposit(reference, d) {
    const dep = this.row('SELECT * FROM cash_deposits WHERE reference = ?', reference);
    const now = Date.now();
    if (!dep || dep.status === 'paid') return null;
    if (d.status === 'success') {
      if (d.amount !== dep.amount_kobo || d.currency !== dep.currency || d.reference !== reference || metaKind(d) !== 'cash_deposit') {
        console.error(`cash: deposit ${reference} doesn't match (${d.amount} ${d.currency} ${metaKind(d)}): not credited`);
        this.sql.exec("UPDATE cash_deposits SET status = 'failed', note = 'mismatch', updated_at = ? WHERE reference = ?", now, reference);
        return null;
      }
      const fresh = this.atomic(() => {
        const f = this.post('dep:' + reference, 'deposit', reference, dep.currency, [[dep.account_id, dep.amount_kobo], [SYS.paystack, -dep.amount_kobo]], now);
        this.sql.exec("UPDATE cash_deposits SET status = 'paid', updated_at = ? WHERE reference = ?", now, reference);
        return f;
      });
      const acct = fresh && this.row('SELECT username, email FROM accounts WHERE id = ?', dep.account_id);
      return acct ? cashMail(acct.email, acct.username, 'Cash added', `Your deposit is in your Driftbolt cash balance.`,
        [['Amount', money(dep.amount_kobo, dep.currency)], ['Reference', reference], ['Date', when(now)]]) : null;
    }
    const status = d.status === 'abandoned' ? 'abandoned' : ['failed', 'reversed'].includes(d.status) ? 'failed' : 'pending';
    const gaveUp = status === 'pending' && now - dep.created_at > DEPOSIT_GIVE_UP;
    this.sql.exec('UPDATE cash_deposits SET status = ?, updated_at = ? WHERE reference = ?', gaveUp ? 'abandoned' : status, now, reference);
    return null;
  }

  // ---------- withdrawals (Paystack transfers) ----------
  async withdraw(A, p, amount) {
    if (this.mode === 'off') return fail(404, 'cash_off');
    if (!p.currency) return NEEDS.currency();
    if (!p.age_ok_at) return p.age_blocked ? NEEDS.ageBlocked() : NEEDS.age();
    if (p.kyc_status !== 'verified') return NEEDS.kyc();
    if (!p.recipient_code) return NEEDS.bank();
    if (!paymentsReady(this.env)) return fail(503, 'payments_off');
    const cfg = this.cfg, cur = p.currency, min = cfg.minWithdrawal[cur] || 1;
    if (!Number.isInteger(amount) || amount < min) return fail(400, 'min_withdrawal', { min });
    const now = Date.now();
    const recent = this.all(`SELECT created_at FROM cash_withdrawals WHERE account_id = ? AND status NOT IN ('failed', 'rejected') AND created_at > ? ORDER BY created_at DESC`, A.id, now - DAY);
    if (recent.length >= cfg.withdrawalsPerDay) return fail(429, 'withdraw_rate', { retryIn: Math.ceil((recent[recent.length - 1].created_at + DAY - now) / 1000) });
    if (recent.length && now - recent[0].created_at < cfg.withdrawGapMs) return fail(429, 'withdraw_rate', { retryIn: Math.ceil((recent[0].created_at + cfg.withdrawGapMs - now) / 1000) });
    const fee = transferFee(amount, cur, cfg);
    if (amount - fee <= 0) return fail(400, 'min_withdrawal', { min });
    // unusual patterns hold a withdrawal for a person to look at; the money still leaves the balance at once
    const flags = [];
    const lastDep = this.row(`SELECT MAX(created_at) AS t FROM cash_ledger WHERE account_id = ? AND kind = 'deposit' AND created_at > ?`, A.id, now - 7 * DAY).t;
    if (lastDep && !this.row(`SELECT 1 AS y FROM cash_ledger WHERE account_id = ? AND kind = 'entry_hold' AND created_at > ?`, A.id, lastDep)) flags.push('deposit_no_play');
    if (p.bank_changed_at && now - p.bank_changed_at < DAY) flags.push('new_bank');
    let reference;
    do reference = 'dbw-' + rand(16, 'abcdefghijklmnopqrstuvwxyz0123456789'); while (this.row('SELECT 1 AS y FROM cash_withdrawals WHERE reference = ?', reference));
    const bank = `${p.bank_name} ·••• ${p.bank_last4}`;
    const posted = this.atomic(() => {
      if (this.balance(A.id, cur) < amount) return false;
      this.post('wd:' + reference, 'withdrawal', reference, cur, [[A.id, -amount], [SYS.bank, amount - fee], [SYS.transferFees, fee]], now);
      this.sql.exec(`INSERT INTO cash_withdrawals (reference, account_id, currency, amount_kobo, fee_kobo, status, flags, bank, recipient_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, reference, A.id, cur, amount, fee, flags.length ? 'review' : 'pending', flags.length ? JSON.stringify(flags) : null, bank, p.recipient_code, now, now);
      return true;
    });
    if (!posted) {
      const bal = this.balance(A.id, cur);
      return fail(402, 'short', { need: amount - bal, balance: bal });
    }
    if (!flags.length) await this.sendTransfer(reference);
    await this.A.schedule();
    const w = this.row('SELECT status FROM cash_withdrawals WHERE reference = ?', reference);
    return ok({ reference, status: w.status, fee, amount, ...this.view(A) });
  }

  // POST /transfer for a withdrawal. A clear refusal reverses it at once; no answer leaves it pending, to verify later.
  async sendTransfer(reference) {
    const w = this.row('SELECT * FROM cash_withdrawals WHERE reference = ?', reference);
    if (!w || !['pending', 'review'].includes(w.status)) return;
    this.sql.exec("UPDATE cash_withdrawals SET status = 'pending', checked_at = ?, updated_at = ? WHERE reference = ?", Date.now(), Date.now(), reference);
    let res;
    try {
      res = await fetch((this.env.PAYSTACK_API || 'https://api.paystack.co') + '/transfer', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.env.PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'balance', amount: w.amount_kobo - w.fee_kobo, recipient: w.recipient_code, reference, currency: w.currency, reason: 'Driftbolt winnings' }),
      });
    } catch (e) {
      console.error(`cash: transfer ${reference} got no answer (${e.message}); it will be checked`);
      return;
    }
    const out = await res.json().catch(() => null);
    if (res.ok && out?.status === true) {
      const s = out.data?.status;
      this.sql.exec('UPDATE cash_withdrawals SET transfer_code = ?, note = ?, updated_at = ? WHERE reference = ?', out.data?.transfer_code || null, s || null, Date.now(), reference);
      if (s === 'success') await this.transferDone(reference, 'success');
      else if (s === 'failed' || s === 'reversed') await this.transferDone(reference, s);
      return;
    }
    // Paystack said no (not enough balance, a bad recipient, …): nothing was sent
    console.error(`cash: transfer ${reference} refused (${res.status} ${out?.message || ''})`);
    await this.transferDone(reference, 'failed', String(out?.message || res.status).slice(0, 120));
  }

  // the webhook's transfer.success / transfer.failed / transfer.reversed: Paystack's verify decides when it answers
  async transferEvent(reference, event) {
    if (typeof reference !== 'string' || !WITHDRAW_RE.test(reference)) return;
    const w = this.row('SELECT status FROM cash_withdrawals WHERE reference = ?', reference);
    if (!w) return;
    let status = { 'transfer.success': 'success', 'transfer.failed': 'failed', 'transfer.reversed': 'reversed' }[event];
    try {
      const d = await paystack(this.env, '/transfer/verify/' + encodeURIComponent(reference));
      if (['success', 'failed', 'reversed'].includes(d.status)) status = d.status;
    } catch { /* the signed event stands */ }
    if (status) await this.transferDone(reference, status);
  }

  async verifyTransfer(reference) {
    this.sql.exec('UPDATE cash_withdrawals SET checked_at = ? WHERE reference = ?', Date.now(), reference);
    let res;
    try {
      res = await fetch((this.env.PAYSTACK_API || 'https://api.paystack.co') + '/transfer/verify/' + encodeURIComponent(reference), {
        headers: { authorization: `Bearer ${this.env.PAYSTACK_SECRET_KEY}` },
      });
    } catch { return; }
    const out = await res.json().catch(() => null);
    if (res.ok && out?.status === true) {
      const s = out.data?.status;
      if (['success', 'failed', 'reversed'].includes(s)) await this.transferDone(reference, s);
    } else if (res.status === 404) {
      // Paystack never got it (the first call got no answer): nothing was sent, so the money comes back
      const w = this.row('SELECT created_at FROM cash_withdrawals WHERE reference = ?', reference);
      if (w && Date.now() - w.created_at > 30 * MIN) await this.transferDone(reference, 'failed', 'not at Paystack');
    }
  }

  // a transfer's end: paid (receipt), or failed / reversed (the money goes back to the player, once)
  async transferDone(reference, outcome, note = null) {
    const w = this.row('SELECT * FROM cash_withdrawals WHERE reference = ?', reference);
    if (!w || ['paid', 'reversed', 'failed', 'rejected'].includes(w.status) && !(w.status === 'paid' && outcome === 'reversed')) return;
    const now = Date.now();
    const acct = this.row('SELECT username, email FROM accounts WHERE id = ?', w.account_id);
    if (outcome === 'success') {
      this.sql.exec("UPDATE cash_withdrawals SET status = 'paid', updated_at = ? WHERE reference = ?", now, reference);
      if (acct) await sendMail(this.env, cashMail(acct.email, acct.username, 'Withdrawal sent', 'Your winnings are on their way to your bank.', [
        ['Amount', money(w.amount_kobo, w.currency)], ['Transfer fee', money(w.fee_kobo, w.currency)], ['You receive', money(w.amount_kobo - w.fee_kobo, w.currency)],
        ['To', w.bank], ['Reference', reference], ['Date', when(now)]]));
      return;
    }
    const status = outcome === 'reversed' ? 'reversed' : outcome === 'rejected' ? 'rejected' : 'failed';
    const back = this.atomic(() => {
      const f = this.post('wdrev:' + reference, 'withdrawal_reversal', reference, w.currency,
        [[w.account_id, w.amount_kobo], [SYS.bank, -(w.amount_kobo - w.fee_kobo)], [SYS.transferFees, -w.fee_kobo]], now);
      this.sql.exec('UPDATE cash_withdrawals SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE reference = ?', status, note, now, reference);
      return f;
    });
    if (back && acct) await sendMail(this.env, cashMail(acct.email, acct.username, 'Withdrawal returned', `Your withdrawal didn't go through, so ${money(w.amount_kobo, w.currency)} is back in your Driftbolt cash balance.`,
      [['Amount', money(w.amount_kobo, w.currency)], ['Reference', reference], ['Date', when(now)]]));
  }

  // ---------- converting cash to tokens (one way) ----------
  convert(A, p, amount) {
    if (this.mode === 'off') return fail(404, 'cash_off');
    if (!p.currency) return NEEDS.currency();
    if (!Number.isInteger(amount) || amount <= 0) return fail(400, 'bad_amount');
    const tokens = tokensFor(amount, p.currency, this.cfg);
    if (tokens < 1) return fail(400, 'bad_amount');
    const id = rand(12, 'abcdefghijklmnopqrstuvwxyz0123456789');
    const now = Date.now();
    const done = this.atomic(() => {
      if (this.balance(A.id, p.currency) < amount) return false;
      this.A.wallet.ensure(A);
      this.post('conv:' + id, 'convert', id, p.currency, [[A.id, -amount], [SYS.tokens, amount]], now);
      this.A.wallet.add(A.id, tokens, 'earned', 'cash:' + id, now);
      return true;
    });
    if (!done) {
      const bal = this.balance(A.id, p.currency);
      return fail(402, 'short', { need: amount - bal, balance: bal });
    }
    return ok({ tokens, tokenBalance: this.A.wallet.balance(A.id), ...this.view(A) });
  }

  // ---------- cash race rooms ----------
  roomRow(code) { return typeof code === 'string' && /^C[A-Z0-9]{4}$/.test(code) ? this.row('SELECT * FROM cash_rooms WHERE code = ?', code) : null; }
  seated(code) { return this.all('SELECT account_id AS account, username AS name, joined_at AS joined FROM cash_seats WHERE code = ? AND left_at IS NULL ORDER BY joined_at', code); }

  // what a Room (and a seated player) is told about a cash room
  roomInfo(r) {
    const { pool, fee, prize } = prizePool(r.entry_kobo, r.seats, r.fee_pct);
    return {
      code: r.code, host: r.host, currency: r.currency, entry: r.entry_kobo, seats: r.seats, split: r.split, map: r.map, laps: r.laps, feePct: r.fee_pct,
      car: this.cfg.car, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, fullAt: r.full_at, startedAt: r.started_at,
      releaseAt: r.release_at, settledAt: r.settled_at, pool, fee, prize, seated: this.seated(r.code), plan: parse(r.plan), flagged: !!parse(r.flags)?.length,
      reports: (parse(r.reports) || []).length, note: r.note,
    };
  }

  // POST /cash/rooms: a new room with the host's entry held
  createRoom(A, p, input) {
    const cfg = this.cfg;
    const entry = input.entry, seats = input.seats, split = input.split, map = input.map, laps = input.laps;
    const no = this.canPutIn(p);
    if (no) return no;
    if (!(cfg.entries[p.currency] || []).includes(entry)) return fail(400, 'bad_entry');
    if (!cfg.seats.includes(seats)) return fail(400, 'bad_seats');
    if (!cfg.splits.includes(split) || !splitAllowed(split, seats)) return fail(400, 'bad_split');
    if (!cfg.maps.includes(map) || !TRACK_LEN[map]) return fail(400, 'bad_map');
    if (!cfg.laps.includes(laps)) return fail(400, 'bad_laps');
    const busy = this.row(`SELECT r.code FROM cash_seats s JOIN cash_rooms r ON r.code = s.code WHERE s.account_id = ? AND s.left_at IS NULL AND r.status IN ('open', 'racing')`, A.id);
    if (busy) return fail(409, 'in_room', { code: busy.code });
    const bad = this.canEnter(p, entry);
    if (bad) return bad;
    let code;
    do code = 'C' + rand(4, CODE_CHARS); while (this.row('SELECT 1 AS y FROM cash_rooms WHERE code = ?', code));
    const now = Date.now();
    this.atomic(() => {
      this.sql.exec(`INSERT INTO cash_rooms (code, host, currency, entry_kobo, seats, split, map, laps, fee_pct, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`, code, A.id, p.currency, entry, seats, split, map, laps, cfg.feePct, now, now + cfg.fillMs);
      this.sql.exec('INSERT INTO cash_seats (code, account_id, username, joined_at) VALUES (?, ?, ?, ?)', code, A.id, A.username, now);
      this.post(`hold:${code}:${A.id}`, 'entry_hold', code, p.currency, [[A.id, -entry], [roomAcct(code), entry]], now);
    });
    return this.roomFor(A, code);
  }

  // POST /cash/rooms/join: the player's entry is held and they have a seat; the seat check and the hold are one transaction
  joinRoom(A, p, code) {
    const r = this.roomRow(code);
    if (!r) return fail(404, 'room_not_found');
    const seat = this.row('SELECT * FROM cash_seats WHERE code = ? AND account_id = ?', code, A.id);
    if (seat && !seat.left_at) return this.roomFor(A, code); // already in: nothing more to pay
    if (seat) return fail(409, 'left_room');
    if (r.status !== 'open' || r.expires_at <= Date.now()) return fail(409, 'room_closed');
    if (p.currency && p.currency !== r.currency) return fail(409, 'currency_mismatch', { currency: r.currency });
    const seatsTaken = () => this.row('SELECT COUNT(*) AS n FROM cash_seats WHERE code = ? AND left_at IS NULL', code).n;
    if (seatsTaken() >= r.seats) return fail(409, 'room_full');
    const busy = this.row(`SELECT r.code FROM cash_seats s JOIN cash_rooms r ON r.code = s.code WHERE s.account_id = ? AND s.left_at IS NULL AND r.status IN ('open', 'racing')`, A.id);
    if (busy) return fail(409, 'in_room', { code: busy.code });
    const bad = this.canEnter(p, r.entry_kobo);
    if (bad) return bad;
    const now = Date.now();
    const res = this.atomic(() => {
      const n = seatsTaken();
      if (n >= r.seats) return fail(409, 'room_full');
      this.sql.exec('INSERT INTO cash_seats (code, account_id, username, joined_at) VALUES (?, ?, ?, ?)', code, A.id, A.username, now);
      this.post(`hold:${code}:${A.id}`, 'entry_hold', code, r.currency, [[A.id, -r.entry_kobo], [roomAcct(code), r.entry_kobo]], now);
      // the last seat: the race has to start within startMs, even if that's past the fill time
      if (n + 1 === r.seats) this.sql.exec('UPDATE cash_rooms SET full_at = ?, expires_at = MAX(expires_at, ?) WHERE code = ?', now, now + this.cfg.startMs, code);
      return null;
    });
    return res || this.roomFor(A, code);
  }

  // GET /cash/rooms/<code>: for a player who paid into it (results, payout and the report window). Other players are
  // named, never identified by their account ids.
  roomFor(A, code) {
    const r = this.roomRow(code);
    if (!r) return fail(404, 'room_not_found');
    const info = this.roomInfo(r);
    // someone with the code who hasn't paid in: the room's terms, to decide whether to join
    if (!this.row('SELECT 1 AS y FROM cash_seats WHERE code = ? AND account_id = ?', code, A.id)) {
      return ok({ room: { preview: true, code, status: r.status, currency: r.currency, entry: r.entry_kobo, seats: r.seats, paid: info.seated.length, split: r.split,
        map: r.map, laps: r.laps, feePct: r.fee_pct, pool: info.pool, fee: info.fee, prize: info.prize, expiresAt: r.expires_at,
        hostName: info.seated.find((x) => x.account === r.host)?.name || '' } });
    }
    const names = Object.fromEntries(this.all('SELECT account_id, username FROM cash_seats WHERE code = ?', code).map((s) => [s.account_id, s.username]));
    const reports = parse(r.reports) || [];
    const plan = info.plan && { pool: info.plan.pool, fee: info.plan.fee, prize: info.plan.prize,
      awards: info.plan.awards.map((a) => ({ name: names[a.account] || '?', place: a.place, amount: a.amount, me: a.account === A.id })) };
    const result = (parse(r.result) || []).map(({ account, ...x }) => ({ ...x, me: account === A.id, payout: info.plan?.awards.find((a) => a.account === account)?.amount || 0 }));
    return ok({ room: {
      ...info, host: undefined, hostName: names[r.host] || '', seated: info.seated.map((s) => ({ name: s.name, me: s.account === A.id })), plan, result,
      mine: plan?.awards.find((a) => a.me) || null, reported: reports.some((x) => x.account === A.id), canReport: r.status === 'window' && r.release_at > Date.now(),
    } });
  }

  // a racer in the room reports the race during the report window: the payout is held for review
  report(A, code, reason) {
    const r = this.roomRow(code);
    const seat = r && this.row('SELECT 1 AS y FROM cash_seats WHERE code = ? AND account_id = ? AND left_at IS NULL', code, A.id);
    if (!seat) return fail(404, 'room_not_found');
    const reports = parse(r.reports) || [];
    if (reports.some((x) => x.account === A.id)) return this.roomFor(A, code);
    if (!(r.status === 'window' && r.release_at > Date.now()) && r.status !== 'review') return fail(409, 'report_closed');
    reports.push({ account: A.id, name: A.username, reason: typeof reason === 'string' ? reason.slice(0, 280) : '', at: Date.now() });
    this.sql.exec("UPDATE cash_rooms SET status = 'review', reports = ? WHERE code = ?", JSON.stringify(reports), code);
    this.notifyRoom(code);
    return this.roomFor(A, code);
  }

  // ---------- from the Room ----------
  roomState(code) { const r = this.roomRow(code); return r ? this.roomInfo(r) : null; }

  // the host starts the race: only a full, open room, and only once (expiry and the start can't both happen)
  startRoom(code) {
    const r = this.roomRow(code);
    if (!r) return { error: 'room_not_found' };
    if (r.status !== 'open') return { error: 'room_closed', room: this.roomInfo(r) };
    if (r.expires_at <= Date.now()) { this.refundAll(code, 'expired'); return { error: 'room_closed', room: this.roomInfo(this.roomRow(code)) }; }
    const n = this.row('SELECT COUNT(*) AS n FROM cash_seats WHERE code = ? AND left_at IS NULL', code).n;
    if (n !== r.seats) return { error: 'not_full', room: this.roomInfo(r) };
    this.sql.exec("UPDATE cash_rooms SET status = 'racing', started_at = ? WHERE code = ? AND status = 'open'", Date.now(), code);
    return { room: this.roomInfo(this.roomRow(code)) };
  }

  // a player leaves (or is removed) before the start: their entry back; the host leaving calls the room off
  leaveRoom(code, account, why = 'left') {
    const r = this.roomRow(code);
    if (!r || r.status !== 'open') return r ? this.roomInfo(r) : null;
    if (account === r.host) { this.refundAll(code, 'cancelled'); return this.roomInfo(this.roomRow(code)); }
    this.atomic(() => {
      const seat = this.row('SELECT * FROM cash_seats WHERE code = ? AND account_id = ? AND left_at IS NULL', code, account);
      if (!seat) return;
      this.post(`refund:${code}:${account}`, 'entry_refund', code, r.currency, [[account, r.entry_kobo], [roomAcct(code), -r.entry_kobo]]);
      this.sql.exec('UPDATE cash_seats SET left_at = ? WHERE code = ? AND account_id = ?', Date.now(), code, account);
      this.sql.exec('UPDATE cash_rooms SET full_at = NULL, expires_at = ?, note = ? WHERE code = ?', r.created_at + this.cfg.fillMs, why, code);
    });
    return this.roomInfo(this.roomRow(code));
  }

  // every held entry back, once each; the room is done
  refundAll(code, why) {
    const r = this.roomRow(code);
    if (!r || r.status === 'refunded' || r.status === 'settled') return;
    this.atomic(() => {
      for (const s of this.all('SELECT account_id FROM cash_seats WHERE code = ?', code)) {
        if (!this.posted(`hold:${code}:${s.account_id}`)) continue;
        this.post(`refund:${code}:${s.account_id}`, 'entry_refund', code, r.currency, [[s.account_id, r.entry_kobo], [roomAcct(code), -r.entry_kobo]]);
      }
      this.sql.exec("UPDATE cash_rooms SET status = 'refunded', settled_at = ?, note = ? WHERE code = ?", Date.now(), why, code);
    });
  }

  // the race is over and the Room has checked it (fair.js). payload: { rows: [{ account, name, finished, out, time, place }],
  // flags: [{ account, name, check, detail }], replay }. Once per room: a repeat gets the room as it is.
  raceResult(code, payload) {
    const r = this.roomRow(code);
    if (!r) return null;
    if (r.status !== 'racing') return this.roomInfo(r);
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const flags = Array.isArray(payload?.flags) ? payload.flags : [];
    const seats = new Set(this.seated(code).map((s) => s.account));
    const finishers = rows.filter((x) => x.finished && seats.has(x.account) && Number.isFinite(x.time)).sort((a, b) => a.time - b.time)
      .map((x) => ({ account: x.account, time: x.time }));
    const pool = this.balance(roomAcct(code), r.currency);
    const { fee, prize } = prizePool(pool, 1, r.fee_pct);
    const awards = awardPrizes(prize, r.split, finishers);
    const now = Date.now();
    const plan = { pool, fee, prize, awards };
    this.atomic(() => {
      this.sql.exec('INSERT OR REPLACE INTO cash_replays (code, data, created_at) VALUES (?, ?, ?)', code, JSON.stringify(payload?.replay || null), now);
      this.sql.exec('UPDATE cash_rooms SET result = ?, plan = ?, flags = ? WHERE code = ?', JSON.stringify(rows.slice(0, 12)), JSON.stringify(plan), JSON.stringify(flags.slice(0, 50)), code);
      if (flags.length) this.sql.exec("UPDATE cash_rooms SET status = 'review', note = 'flagged' WHERE code = ?", code);
      else if (!finishers.length) this.refundAll(code, 'no_finishers');
      else this.sql.exec("UPDATE cash_rooms SET status = 'window', release_at = ? WHERE code = ?", now + this.cfg.reportMs, code);
    });
    return this.roomInfo(this.roomRow(code));
  }

  // the payout as planned: prizes to the winners, the fee to the platform, the room's pot back to zero. One transaction.
  release(code) {
    const r = this.roomRow(code);
    const plan = r && parse(r.plan);
    if (!r || !plan || !['window', 'review'].includes(r.status)) return false;
    return this.atomic(() => {
      const pot = roomAcct(code);
      for (const a of plan.awards) this.post(`prize:${code}:${a.account}`, 'prize', code, r.currency, [[a.account, a.amount], [pot, -a.amount]]);
      this.post(`fee:${code}`, 'fee', code, r.currency, [[SYS.fees, plan.fee], [pot, -plan.fee]]);
      const left = this.balance(pot, r.currency);
      if (left !== 0) throw new Error(`cash: room ${code} pot not empty after payout (${left})`);
      this.sql.exec("UPDATE cash_rooms SET status = 'settled', settled_at = ? WHERE code = ?", Date.now(), code);
      return true;
    });
  }

  // a Room couldn't take the code (it's a normal room's): the room never existed, so everything goes back
  cancelRoom(code, why) { this.refundAll(code, why); }

  // tell the room's Durable Object (and through it the players) that the money side changed
  notifyRoom(code) {
    const info = this.roomState(code);
    if (!info) return;
    const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(code));
    const p = stub.cashSync(info).catch(() => { /* the room asks again when someone connects */ });
    this.A.ctx.waitUntil?.(p);
  }

  // ---------- the clock (Accounts' alarm) ----------
  // rooms that didn't fill or start, payouts whose report window has closed, races that never reported, and payments
  // and transfers Paystack hasn't told us about yet. Returns when to look again.
  async tick() {
    const now = Date.now();
    for (const r of this.all("SELECT code FROM cash_rooms WHERE status = 'open' AND expires_at <= ?", now)) { this.refundAll(r.code, 'expired'); this.notifyRoom(r.code); }
    for (const r of this.all("SELECT code FROM cash_rooms WHERE status = 'window' AND release_at <= ?", now)) {
      try { if (this.release(r.code)) this.notifyRoom(r.code); } catch (e) { console.error(e.message); this.sql.exec("UPDATE cash_rooms SET status = 'review', note = 'payout_error' WHERE code = ?", r.code); }
    }
    for (const r of this.all("SELECT code FROM cash_rooms WHERE status = 'racing' AND started_at <= ?", now - RACE_STUCK)) {
      this.sql.exec("UPDATE cash_rooms SET status = 'review', note = 'no_result' WHERE code = ?", r.code);
    }
    if (paymentsReady(this.env)) {
      for (const d of this.all("SELECT reference FROM cash_deposits WHERE status = 'pending' AND created_at <= ? AND checked_at <= ? LIMIT 20", now - 2 * MIN, now - CHECK_EVERY)) await this.verifyDeposit(d.reference);
      for (const w of this.all("SELECT reference FROM cash_withdrawals WHERE status = 'pending' AND checked_at <= ? LIMIT 20", now - CHECK_EVERY)) await this.verifyTransfer(w.reference);
    }
    return this.nextTick();
  }

  nextTick() {
    const t = [];
    const q = (sql, ...a) => this.row(sql, ...a)?.t;
    t.push(q("SELECT MIN(expires_at) AS t FROM cash_rooms WHERE status = 'open'"));
    t.push(q("SELECT MIN(release_at) AS t FROM cash_rooms WHERE status = 'window'"));
    const s = q("SELECT MIN(started_at) AS t FROM cash_rooms WHERE status = 'racing'");
    if (s) t.push(s + RACE_STUCK);
    if (paymentsReady(this.env)) {
      const d = q("SELECT MIN(MAX(created_at + ?, checked_at + ?)) AS t FROM cash_deposits WHERE status = 'pending'", 2 * MIN, CHECK_EVERY);
      const w = q("SELECT MIN(checked_at + ?) AS t FROM cash_withdrawals WHERE status = 'pending'", CHECK_EVERY);
      t.push(d, w);
    }
    const next = t.filter((x) => Number.isFinite(x));
    return next.length ? Math.min(...next) : 0;
  }

  // ---------- admin (/admin) ----------
  adminList() {
    const rooms = this.all("SELECT * FROM cash_rooms WHERE status = 'review' ORDER BY created_at").map((r) => ({
      ...this.roomInfo(r), result: parse(r.result), flags: parse(r.flags) || [], reportList: parse(r.reports) || [],
    }));
    const withdrawals = this.all(`SELECT w.reference, w.account_id AS account, a.username, w.currency, w.amount_kobo AS amount, w.fee_kobo AS fee, w.status, w.flags,
      w.bank, w.created_at AS at, w.note FROM cash_withdrawals w LEFT JOIN accounts a ON a.id = w.account_id WHERE w.status IN ('review', 'pending') ORDER BY w.created_at`)
      .map((w) => ({ ...w, flags: parse(w.flags) || [] }));
    const log = this.all('SELECT at, admin, action, target, note FROM admin_log ORDER BY id DESC LIMIT 50');
    // the books, per currency: every txn adds up to zero, so net must always be 0; held is what's in room pots now
    const books = Object.fromEntries(this.all(`SELECT currency, SUM(amount_kobo) AS net, SUM(CASE WHEN account_id = ? THEN amount_kobo ELSE 0 END) AS fees,
      SUM(CASE WHEN account_id LIKE 'room:%' THEN amount_kobo ELSE 0 END) AS held FROM cash_ledger GROUP BY currency`, SYS.fees).map((r) => [r.currency, { net: r.net, fees: r.fees, held: r.held }]));
    return { rooms, withdrawals, log, books, mode: this.mode };
  }

  adminReplay(code) {
    const row = this.row('SELECT data FROM cash_replays WHERE code = ?', code);
    return row ? parse(row.data) : null;
  }

  async adminAct(admin, action, target, note) {
    const now = Date.now();
    const log = () => this.sql.exec('INSERT INTO admin_log (at, admin, action, target, note) VALUES (?, ?, ?, ?, ?)', now, admin, action, target, typeof note === 'string' ? note.slice(0, 280) : null);
    if (action === 'release' || action === 'refund') {
      const r = this.roomRow(target);
      if (!r || r.status !== 'review') return fail(409, 'not_in_review');
      if (action === 'release' && !parse(r.plan)?.awards?.length) return fail(409, 'nothing_to_release');
      try {
        this.atomic(() => {
          if (action === 'release') this.release(target);
          else this.refundAll(target, 'admin_refund');
          log();
        });
      } catch (e) { return fail(500, 'payout_error', { message: e.message }); }
      this.notifyRoom(target);
      return ok(this.adminList());
    }
    if (action === 'approve' || action === 'reject') {
      const w = this.row('SELECT status FROM cash_withdrawals WHERE reference = ?', target);
      if (!w || w.status !== 'review') return fail(409, 'not_in_review');
      log();
      if (action === 'approve') await this.sendTransfer(target);
      else await this.transferDone(target, 'rejected', 'admin');
      await this.A.schedule();
      return ok(this.adminList());
    }
    return fail(400, 'bad_action');
  }
}

const when = (t) => new Date(t).toUTCString().replace(/:\d\d GMT$/, ' UTC');
