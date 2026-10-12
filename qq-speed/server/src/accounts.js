// Player accounts with no passwords: a username and an email to sign up, the username alone to log in.
// A device that has proved itself keeps a device token and logs in with it; anywhere else a 6-digit code is emailed first.
// One global Accounts object (SQLite) holds every account, its token wallet (wallet.js) and its cash wallet (cash.js).
// The Worker's /auth API calls api(), its /wallet and /pay API wallet() and its /cash API cashApi(); rooms and leagues
// ask resolve() whose a session is and isRegistered() whether a guest's name belongs to an account, report races and
// league wins for the wallet, and cash rooms move their money through the cash* methods.
//
// Kept: only hashes of device tokens and codes, and of IP addresses (for rate limits). Sessions are signed with
// AUTH_SECRET (a Wrangler secret) and checked here too, so logging out, or out of every device, takes effect at once.
// Login answers the same way whether or not a name is registered: an unknown name gets a stand-in code nobody knows,
// a made-up masked email that stays the same, and the same attempt counting and lockout.
// Players in Lagos Life's Games app (vatar.js) get an account with no email, made from their Vatar player: they never
// log in, ask for codes or change an email here, so for those an account with no email is treated as no account at all.
import { DurableObject } from 'cloudflare:workers';
import { USERNAME_RE, EMAIL_RE, EMAIL_MAX, RESEND_GAP } from '../../src/netproto.js';
import { nameProblem } from './names.js';
import { maskEmail, codeMail, changedMail } from './mail.js';
import { Wallet, WALLET_SCHEMA } from './wallet.js';
import { Cash, CASH_SCHEMA } from './cash.js';
import { vatar, vatarReady, PLAYER_ID_RE } from './vatar.js';

const SESSION_TTL = 30 * 86_400_000;
const CODE_TTL = 10 * 60_000;
const CODE_TRIES = 5;
const GAP = RESEND_GAP * 1000;
const MAX_DEVICES = 20; // per account; the least recently used go first
const TIDY_EVERY = 60 * 60_000;
const MIN = 60_000, DAY = 24 * 60 * MIN;
// [requests, per ms] for each kind of request, counted per IP address and per username (or per account)
const LIMITS = {
  'check:ip': [300, 10 * MIN], 'signup:ip': [10, 60 * MIN],
  'login:ip': [60, 10 * MIN], 'login:name': [10, 10 * MIN],
  'verify:ip': [60, 10 * MIN], 'verify:name': [15, 10 * MIN],
  'resend:ip': [20, 10 * MIN], 'resend:name': [6, 60 * MIN],
  'email:acct': [5, 60 * MIN], 'emailverify:acct': [15, 10 * MIN],
  'wallet:acct': [120, 10 * MIN], 'walletget:acct': [240, 10 * MIN], 'pay:acct': [20, 10 * MIN],
  'cash:acct': [120, 10 * MIN], 'cashget:acct': [300, 10 * MIN], 'kyc:acct': [5, DAY], 'bank:acct': [10, 60 * MIN], 'admin:ip': [120, 10 * MIN],
  // Lagos Life players on mobile data share addresses, so this one is generous; Vatar's API has its own limit too
  'vatar:ip': [300, 10 * MIN],
};
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL, created INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 0)`,
  // the device tokens an account trusts: a hash of each, and when it was last used
  `CREATE TABLE IF NOT EXISTS devices (hash TEXT PRIMARY KEY, account TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS devices_account ON devices (account)',
  // pending codes, by account id ('x:<name>' for a name nobody has); purpose 'login' or 'email' (data: the new address)
  `CREATE TABLE IF NOT EXISTS codes (key TEXT NOT NULL, purpose TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL,
    attempts INTEGER NOT NULL, sent INTEGER NOT NULL, data TEXT, PRIMARY KEY (key, purpose))`,
  // sessions logged out before they expire
  'CREATE TABLE IF NOT EXISTS revoked (sid TEXT PRIMARY KEY, until INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)',
  // the account of each Lagos Life player (Vatar's per-game pseudonym: p_… live, t_… sandbox)
  'CREATE TABLE IF NOT EXISTS vatar_players (player_id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, created INTEGER NOT NULL)',
];

const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc(s)));
const sameBytes = (a, b) => a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
const rid = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
function newCode() {
  const b = new Uint32Array(1);
  do crypto.getRandomValues(b); while (b[0] >= 4_294_000_000); // no modulo bias
  return String(b[0] % 1_000_000).padStart(6, '0');
}
const cleanEmail = (s) => {
  const e = typeof s === 'string' ? s.trim().toLowerCase() : '';
  return e.length <= EMAIL_MAX && EMAIL_RE.test(e) ? e : '';
};
const ok = (body) => ({ status: 200, body });
const fail = (status, error, extra) => ({ status, body: { error, ...extra } });
const slow = (ms) => fail(429, 'slow_down', { retryIn: Math.ceil(ms / 1000) });
const view = (a) => ({ username: a.username, email: a.email ? maskEmail(a.email) : '', created: a.created });
// the account behind a name as far as logging in goes: one with no email (a Lagos Life player's) can't
const mailable = (a) => (a?.email ? a : null);
// a stand-in masked email for a name nobody has, the same every time it's asked for
const FAKE_DOMAINS = ['gmail.com', 'gmail.com', 'gmail.com', 'gmail.com', 'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me'];

export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const q of [...SCHEMA, ...WALLET_SCHEMA, ...CASH_SCHEMA]) this.sql.exec(q);
    this.tidyAt = 0;
    this.wallet = new Wallet(this);
    this.cash = new Cash(this);
  }

  row(q, ...args) { return this.sql.exec(q, ...args).toArray()[0] || null; }
  byName(name) { return this.row('SELECT * FROM accounts WHERE name_key = ?', name.toLowerCase()); }
  get ready() { return typeof this.env.AUTH_SECRET === 'string' && this.env.AUTH_SECRET.length >= 16; }

  key() {
    this.hmacKey ||= crypto.subtle.importKey('raw', enc(this.env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return this.hmacKey;
  }
  async mac(s) { return new Uint8Array(await crypto.subtle.sign('HMAC', await this.key(), enc(s))); }

  // ---------- for rooms and leagues ----------
  // { id, username } for a valid session, else null
  async resolve(token) {
    if (!this.ready) return null;
    const s = await this.readSession(token);
    return s && { id: s.acct.id, username: s.acct.username };
  }

  // whether a name (as a guest typed it) is an account's
  isRegistered(name) {
    return typeof name === 'string' && USERNAME_RE.test(name) && !!this.byName(name);
  }

  // ---------- the /auth API ----------
  // Returns { status, body, mail? }: the Worker sends `mail` after answering, so the reply takes as long either way.
  // ip is the caller's address (kept only as a keyed hash); canMail: whether email can go out from this server.
  async api(action, input, session, ip, canMail) {
    if (!this.ready) return fail(503, 'not_configured');
    this.tidy();
    const ipKey = hex(await this.mac('ip:' + ip)).slice(0, 24);
    switch (action) {
      case 'check-name': return this.checkName(input, ipKey);
      case 'signup': return this.signup(input, ipKey);
      case 'login': return this.login(input, ipKey, canMail);
      case 'resend': return this.resend(input, ipKey, canMail);
      case 'verify': return this.verify(input, ipKey);
      case 'forget': return this.forget(input);
    }
    const me = await this.readSession(session);
    if (!me) return fail(401, 'session');
    const A = me.acct;
    switch (action) {
      case 'me': return ok({ account: view(A) });
      case 'logout':
        this.sql.exec('INSERT OR REPLACE INTO revoked (sid, until) VALUES (?, ?)', me.sid, me.exp);
        return ok({});
      case 'logout-all':
        // every session ends (they carry the old epoch) and every device needs a code again
        this.sql.exec('UPDATE accounts SET epoch = epoch + 1 WHERE id = ?', A.id);
        this.sql.exec('DELETE FROM devices WHERE account = ?', A.id);
        this.sql.exec('DELETE FROM codes WHERE key = ?', A.id);
        return ok({});
      case 'email': return this.changeEmail(A, input, canMail);
      case 'email/verify': return this.confirmEmail(A, input);
    }
    return fail(404, 'not_found');
  }

  async checkName(input, ipKey) {
    const wait = this.limit('check:ip', ipKey);
    if (wait) return slow(wait);
    const problem = nameProblem(input.username);
    if (problem) return ok({ available: false, reason: problem });
    return this.byName(input.username) ? ok({ available: false, reason: 'taken' }) : ok({ available: true });
  }

  async signup(input, ipKey) {
    const name = input.username, email = cleanEmail(input.email);
    const problem = nameProblem(name);
    if (problem) return fail(400, problem === 'format' ? 'bad_name' : 'name_not_allowed');
    if (!email) return fail(400, 'bad_email');
    const wait = this.limit('signup:ip', ipKey);
    if (wait) return slow(wait);
    const token = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await sha(token);
    // from here to the insert nothing waits, so no other request can take the name in between (and name_key is UNIQUE)
    if (this.byName(name)) return fail(409, 'name_taken');
    const now = Date.now();
    let id;
    do id = rid(12); while (this.row('SELECT 1 AS y FROM accounts WHERE id = ?', id));
    this.sql.exec('INSERT INTO accounts (id, username, name_key, email, created, epoch) VALUES (?, ?, ?, ?, ?, 0)', id, name, name.toLowerCase(), email, now);
    this.sql.exec('INSERT INTO devices (hash, account, created, used) VALUES (?, ?, ?, ?)', hash, id, now, now);
    this.sql.exec('DELETE FROM codes WHERE key = ?', 'x:' + name.toLowerCase());
    // signed up from a friend's invite link: both get tokens once this player has raced (wallet.js)
    const inviter = typeof input.invite === 'string' && USERNAME_RE.test(input.invite) ? this.byName(input.invite) : null;
    if (inviter) this.wallet.invited(id, inviter.id);
    const acct = this.byName(name);
    return ok({ session: await this.newSession(acct), deviceToken: token, account: view(acct) });
  }

  async login(input, ipKey, canMail) {
    const name = input.username;
    if (typeof name !== 'string' || !USERNAME_RE.test(name)) return fail(400, 'bad_name');
    const wait = this.limit('login:ip', ipKey) || this.limit('login:name', name.toLowerCase());
    if (wait) return slow(wait);
    const hash = typeof input.deviceToken === 'string' && TOKEN_RE.test(input.deviceToken) ? await sha(input.deviceToken) : null;
    const acct = mailable(this.byName(name));
    if (acct && hash && this.row('SELECT 1 AS y FROM devices WHERE hash = ? AND account = ?', hash, acct.id)) {
      this.sql.exec('UPDATE devices SET used = ? WHERE hash = ?', Date.now(), hash);
      return ok({ session: await this.newSession(acct), account: view(acct) });
    }
    return this.sendCode(acct, name, 'login', { canMail });
  }

  async resend(input, ipKey, canMail) {
    const name = input.username;
    if (typeof name !== 'string' || !USERNAME_RE.test(name)) return fail(400, 'bad_name');
    const wait = this.limit('resend:ip', ipKey) || this.limit('resend:name', name.toLowerCase());
    if (wait) return slow(wait);
    return this.sendCode(mailable(this.byName(name)), name, 'login', { canMail, resend: true });
  }

  async verify(input, ipKey) {
    const name = input.username;
    if (typeof name !== 'string' || !USERNAME_RE.test(name)) return fail(400, 'bad_name');
    const wait = this.limit('verify:ip', ipKey) || this.limit('verify:name', name.toLowerCase());
    if (wait) return slow(wait);
    const acct = mailable(this.byName(name));
    const r = await this.checkCode(acct ? acct.id : 'x:' + name.toLowerCase(), 'login', input.code);
    if (r.error) return r.error;
    if (!acct) return fail(400, 'bad_code', { left: 0 }); // a stand-in code can't really be guessed, but just in case
    const body = { session: await this.newSession(acct), account: view(acct) };
    if (input.remember === true) body.deviceToken = await this.newDevice(acct.id);
    return ok(body);
  }

  // a device that no longer wants to log in as this account (its tile was removed): its token stops working
  async forget(input) {
    const acct = typeof input.username === 'string' && USERNAME_RE.test(input.username) ? this.byName(input.username) : null;
    if (acct && typeof input.deviceToken === 'string' && TOKEN_RE.test(input.deviceToken)) {
      this.sql.exec('DELETE FROM devices WHERE hash = ? AND account = ?', await sha(input.deviceToken), acct.id);
    }
    return ok({});
  }

  // a code to the new address: it only changes once that code comes back
  async changeEmail(A, input, canMail) {
    if (!A.email) return fail(403, 'lagoslife');
    const email = cleanEmail(input.email);
    if (!email) return fail(400, 'bad_email');
    if (email === A.email) return fail(400, 'same_email');
    const wait = this.limit('email:acct', A.id);
    if (wait) return slow(wait);
    return this.sendCode(A, A.username, 'email', { canMail, resend: true, to: email });
  }

  async confirmEmail(A, input) {
    const wait = this.limit('emailverify:acct', A.id);
    if (wait) return slow(wait);
    const r = await this.checkCode(A.id, 'email', input.code);
    if (r.error) return r.error;
    const email = r.row.data;
    this.sql.exec('UPDATE accounts SET email = ? WHERE id = ?', email, A.id);
    // the old address hears about it, in case it wasn't the owner
    return { ...ok({ account: view({ ...A, email }) }), mail: changedMail(A.email, A.username, maskEmail(email)) };
  }

  // ---------- the wallet (wallet.js) ----------
  // The /wallet and /pay API, for the session's account. Returns { status, body }.
  async walletApi(action, input, session) {
    if (!this.ready) return fail(503, 'not_configured');
    const me = await this.readSession(session);
    if (!me) return fail(401, 'session');
    const A = me.acct, W = this.wallet;
    const wait = this.limit(action === 'get' || action === 'pay/status' ? 'walletget:acct' : action === 'pay/init' || action === 'vatar/claim' ? 'pay:acct' : 'wallet:acct', A.id);
    if (wait) return slow(wait);
    W.ensure(A);
    switch (action) {
      case 'get': return ok(W.view(A));
      case 'unlock': return W.unlock(A, input.itemId);
      case 'equip': return W.equip(A, input.carId, input.look);
      case 'earn': return W.earn(A, input.kind, input.proof);
      case 'claim': return W.claimEarned(A, input.items);
      case 'move': return W.move(A, input);
      case 'logo': return W.logoUpload(A, input);
      // a Lagos Life player pays on Lagos Life's own pay sheet, never Paystack (and has no email for it)
      case 'pay/init': return A.email ? W.payInit(A, input.packId, input.origin) : fail(403, 'lagoslife');
      case 'pay/status': return W.payStatus(A, input.reference);
      case 'vatar/claim': return W.vatarClaim(A, input.purchaseId);
    }
    return fail(404, 'not_found');
  }

  // a player's logo for GET /logo/<key>: { mime, data } or null
  logo(key) { return this.ready ? this.wallet.logo(key) : null; }

  // Paystack's webhook said a charge succeeded (the Worker has checked its signature)
  async payConfirm(reference) { await this.wallet.payConfirm(reference); }
  // Vatar's webhook said a Lagos Life purchase was paid (the Worker has checked its signature)
  async vatarPaid(purchaseId) { await this.wallet.vatarPaid(purchaseId); }

  // ---------- Lagos Life (vatar.js) ----------
  // POST /vatar/session { session }: the Vatar session token the game got in Lagos Life's frame, checked with Vatar's
  // API. Each Vatar player has one account here, made on their first visit with a name from their display name and no
  // email. Answers like signup, without a device token: { session, account, mode }.
  async vatarLogin(token, ip) {
    if (!this.ready) return fail(503, 'not_configured');
    if (!vatarReady(this.env)) return fail(503, 'vatar_off');
    if (typeof token !== 'string' || token.length > 4000 || !/^[\x21-\x7e]+$/.test(token)) return fail(400, 'bad_session');
    this.tidy();
    const wait = this.limit('vatar:ip', hex(await this.mac('ip:' + ip)).slice(0, 24));
    if (wait) return slow(wait);
    const v = await vatar(this.env, '/session/verify', { session: token });
    // expired, forged, or for the other mode than this server's secret
    if (v.http === 401 || v.http === 403) return fail(401, 'vatar_session', { reason: String(v.error || '').slice(0, 40) });
    if (v.http !== 200 || typeof v.playerId !== 'string' || !PLAYER_ID_RE.test(v.playerId)) {
      console.error(`vatar: session check failed (${v.http} ${v.error || ''})`);
      return fail(502, 'vatar');
    }
    // from the lookup to the insert nothing waits, so two first visits at once still make one account
    let link = this.row('SELECT account_id FROM vatar_players WHERE player_id = ?', v.playerId);
    if (!link) {
      const now = Date.now(), name = this.vatarName(v.name, v.mode);
      let id;
      do id = rid(12); while (this.row('SELECT 1 AS y FROM accounts WHERE id = ?', id));
      this.sql.exec("INSERT INTO accounts (id, username, name_key, email, created, epoch) VALUES (?, ?, ?, '', ?, 0)", id, name, name.toLowerCase(), now);
      this.sql.exec('INSERT INTO vatar_players (player_id, account_id, created) VALUES (?, ?, ?)', v.playerId, id, now);
      link = { account_id: id };
    }
    const acct = this.row('SELECT * FROM accounts WHERE id = ?', link.account_id);
    return ok({ session: await this.newSession(acct), account: view(acct), mode: v.mode === 'live' ? 'live' : 'test' });
  }

  // the Lagos Life player behind an account: { player_id }, or null for an ordinary account
  vatarPlayer(accountId) { return this.row('SELECT player_id FROM vatar_players WHERE account_id = ?', accountId); }

  // A free username from a Vatar display name: "Tolú Adé" becomes Tolu_Ade, or Tolu_Ade42 if that's taken. Names the
  // signup rules refuse become Racer. Sandbox players are Test_…, so they don't take the names live players will want.
  vatarName(display, mode) {
    const clean = String(display ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const trim = (s, n) => s.slice(0, n).replace(/_+$/, '');
    let full = (mode === 'test' ? 'Test_' : '') + (clean.length >= 3 ? clean : 'Racer');
    if (nameProblem(trim(full, 16))) full = mode === 'test' ? 'Test_Racer' : 'Racer';
    const free = (n) => !nameProblem(n) && !this.byName(n);
    if (free(trim(full, 16))) return trim(full, 16);
    // room for up to four digits
    const base = trim(full, 12);
    for (let i = 0; i < 40; i++) {
      const n = base + (10 + (crypto.getRandomValues(new Uint16Array(1))[0] % (i < 20 ? 90 : 9990)));
      if (free(n)) return n;
    }
    return 'Racer' + rid(8);
  }
  // a league race win, from the League object
  grant(accountId, reason, ref, amount) { return this.wallet.grant(accountId, reason, ref, amount); }
  // accounts that finished an online race, from a Room
  raceFinished(accountIds) { if (Array.isArray(accountIds)) this.wallet.raceFinished(accountIds.filter((id) => typeof id === 'string')); }

  // ---------- cash (cash.js) ----------
  // The /cash API, for the session's account. ctx: { origin, local } of the request. Returns { status, body }.
  async cashApi(action, input, session, ctx) {
    if (!this.ready) return fail(503, 'not_configured');
    const me = await this.readSession(session);
    if (!me) return fail(401, 'session');
    const A = me.acct;
    // Lagos Life players (no email, vatar.js): its rules allow no real-money play in its frame
    if (!A.email) return fail(403, 'lagoslife');
    const wait = this.limit(action === 'get' || action === 'rooms/get' || action === 'deposit/status' ? 'cashget:acct' : 'cash:acct', A.id);
    if (wait) return slow(wait);
    const r = await this.cash.api(A, action, input, ctx);
    await this.schedule();
    return r;
  }

  // from the Worker and the Room of a cash race (the code is the room's)
  cashRoomState(code) { return this.cash.roomState(code); }
  async cashStart(code) { const r = this.cash.startRoom(code); await this.schedule(); return r; }
  async cashLeave(code, account, why) { const r = this.cash.leaveRoom(code, account, why); await this.schedule(); return r; }
  async cashCancel(code, why) { this.cash.cancelRoom(code, why); await this.schedule(); }
  // the Room's own fill timer ran out: refunded if it really has expired
  async cashExpire(code) { await this.cash.tick(); await this.schedule(); return this.cash.roomState(code); }
  async cashResult(code, payload) { const r = this.cash.raceResult(code, payload); await this.schedule(); return r; }
  // Paystack's webhook (the Worker has checked its signature)
  async cashDepositConfirm(reference) { await this.cash.depositConfirm(reference); }
  async cashTransferEvent(reference, event) { await this.cash.transferEvent(reference, event); await this.schedule(); }

  // ---------- admin (/admin) ----------
  // An admin is an account named in ADMIN_USERS (a var) that also sends the ADMIN_KEY secret; both, or nothing.
  async adminApi(action, input, session, key, ip) {
    if (!this.ready) return fail(503, 'not_configured');
    const wait = this.limit('admin:ip', hex(await this.mac('ip:' + ip)).slice(0, 24));
    if (wait) return slow(wait);
    const admins = String(this.env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const secret = this.env.ADMIN_KEY;
    if (!admins.length || typeof secret !== 'string' || secret.length < 16) return fail(503, 'admin_off');
    const me = await this.readSession(session);
    const keyOk = typeof key === 'string' && key.length < 400 && sameBytes(await this.mac('admin:' + key), await this.mac('admin:' + secret));
    if (!me || !keyOk || !admins.includes(me.acct.username.toLowerCase())) return fail(403, 'not_admin');
    switch (action) {
      case 'list': return ok({ admin: me.acct.username, ...this.cash.adminList() });
      case 'replay': return ok({ replay: this.cash.adminReplay(input.code) });
      case 'act': return this.cash.adminAct(me.acct.username, input.action, input.target, input.note);
    }
    return fail(404, 'not_found');
  }

  // the cash clock: room fill times, report windows, and payments and transfers to check with Paystack
  async alarm() {
    await this.cash.tick();
    await this.schedule();
  }

  async schedule() {
    const at = this.cash.nextTick();
    if (at) await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, at));
    else await this.ctx.storage.deleteAlarm();
  }

  // ---------- codes ----------
  // Emails a new code (or says one is on its way). With no account behind the name, a stand-in code is kept the same way
  // and nothing is sent. Codes go out at most once a minute: login quietly keeps the last one, resend is told to wait.
  async sendCode(acct, name, purpose, { canMail, resend = false, to = null }) {
    const key = acct ? acct.id : 'x:' + name.toLowerCase();
    const masked = to ? maskEmail(to) : acct ? maskEmail(acct.email) : await this.fakeMask(name.toLowerCase());
    const code = newCode();
    const hash = hex(await this.mac(`code:${key}:${purpose}:${code}`));
    const now = Date.now();
    const prev = this.row('SELECT sent FROM codes WHERE key = ? AND purpose = ?', key, purpose);
    const since = prev ? now - prev.sent : Infinity;
    if (since < GAP) {
      const retryIn = Math.ceil((GAP - since) / 1000);
      return resend ? fail(429, 'too_soon', { retryIn }) : ok({ needsCode: true, maskedEmail: masked, resendIn: retryIn });
    }
    if (!canMail) return fail(503, 'email_unavailable');
    this.sql.exec('INSERT OR REPLACE INTO codes (key, purpose, hash, expires, attempts, sent, data) VALUES (?, ?, ?, ?, 0, ?, ?)',
      key, purpose, hash, now + CODE_TTL, now, to);
    const res = ok({ needsCode: true, maskedEmail: masked, resendIn: RESEND_GAP });
    return acct ? { ...res, mail: codeMail(to || acct.email, acct.username, code, purpose) } : res;
  }

  // { row } when the code is right (and it's used up), { error } otherwise. Each try is counted before the code is
  // compared, so tries sent in parallel can't get past the limit either.
  async checkCode(key, purpose, code) {
    const row = this.row('SELECT * FROM codes WHERE key = ? AND purpose = ?', key, purpose);
    if (!row || row.expires <= Date.now()) return { error: fail(410, 'code_expired') };
    if (row.attempts >= CODE_TRIES) return { error: fail(403, 'code_locked') };
    this.sql.exec('UPDATE codes SET attempts = attempts + 1 WHERE key = ? AND purpose = ?', key, purpose);
    const tries = row.attempts + 1;
    const given = typeof code === 'string' && /^\d{6}$/.test(code) ? await this.mac(`code:${key}:${purpose}:${code}`) : null;
    if (!given || !sameBytes(given, Uint8Array.from(row.hash.match(/../g), (h) => parseInt(h, 16)))) {
      return { error: tries >= CODE_TRIES ? fail(403, 'code_locked') : fail(400, 'bad_code', { left: CODE_TRIES - tries }) };
    }
    this.sql.exec('DELETE FROM codes WHERE key = ? AND purpose = ? AND hash = ?', key, purpose, row.hash);
    return { row };
  }

  async fakeMask(nameKey) {
    const b = await this.mac('fake:' + nameKey);
    const az = 'abcdefghijklmnopqrstuvwxyz';
    const letters = nameKey.replace(/[^a-z]/g, '');
    // people often use their name in their address: so do some of the stand-ins
    const start = b[0] < 90 && letters.length >= 2 ? letters.slice(0, 2) : az[b[1] % 26] + az[b[2] % 26];
    return start + '•••••@' + FAKE_DOMAINS[b[3] % FAKE_DOMAINS.length];
  }

  // ---------- sessions and devices ----------
  // "s1.<payload>.<signature>": payload { a: account id, s: session id, e: the account's epoch, x: expiry (ms) }
  async newSession(acct) {
    const payload = b64u(enc(JSON.stringify({ a: acct.id, s: rid(16), e: acct.epoch, x: Date.now() + SESSION_TTL })));
    return `s1.${payload}.${b64u(await this.mac('session:' + payload))}`;
  }

  async readSession(token) {
    const m = typeof token === 'string' && token.length < 400 ? /^s1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token) : null;
    if (!m) return null;
    let p;
    try {
      if (!sameBytes(unb64u(m[2]), await this.mac('session:' + m[1]))) return null;
      p = JSON.parse(new TextDecoder().decode(unb64u(m[1])));
    } catch { return null; }
    if (!p || typeof p.a !== 'string' || typeof p.s !== 'string' || !(p.x > Date.now())) return null;
    const acct = this.row('SELECT * FROM accounts WHERE id = ?', p.a);
    if (!acct || acct.epoch !== p.e || this.row('SELECT 1 AS y FROM revoked WHERE sid = ?', p.s)) return null;
    return { acct, sid: p.s, exp: p.x };
  }

  async newDevice(account) {
    const token = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await sha(token);
    const now = Date.now();
    this.sql.exec('INSERT INTO devices (hash, account, created, used) VALUES (?, ?, ?, ?)', hash, account, now, now);
    this.sql.exec('DELETE FROM devices WHERE account = ? AND hash NOT IN (SELECT hash FROM devices WHERE account = ? ORDER BY used DESC LIMIT ?)', account, account, MAX_DEVICES);
    return token;
  }

  // ---------- upkeep ----------
  // fixed-window counter: 0 if this request may go ahead, else ms until it may
  limit(kind, who) {
    const [max, per] = LIMITS[kind];
    const key = kind + ':' + who, now = Date.now();
    const r = this.row('SELECT n, reset FROM limits WHERE key = ?', key);
    if (!r || r.reset <= now) {
      this.sql.exec('INSERT OR REPLACE INTO limits (key, n, reset) VALUES (?, 1, ?)', key, now + per);
      return 0;
    }
    if (r.n >= max) return r.reset - now;
    this.sql.exec('UPDATE limits SET n = n + 1 WHERE key = ?', key);
    return 0;
  }

  // expired counters, codes and logged-out sessions, at most once an hour
  tidy() {
    const now = Date.now();
    if (now < this.tidyAt) return;
    this.tidyAt = now + TIDY_EVERY;
    this.sql.exec('DELETE FROM limits WHERE reset <= ?', now);
    this.sql.exec('DELETE FROM codes WHERE expires <= ?', now - GAP);
    this.sql.exec('DELETE FROM revoked WHERE until <= ?', now);
  }
}
