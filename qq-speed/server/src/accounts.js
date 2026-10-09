// Player accounts with no passwords: a username and an email to sign up, the username alone to log in.
// A device that has proved itself keeps a device token and logs in with it; anywhere else a 6-digit code is emailed first.
// One global Accounts object (SQLite) holds every account. The Worker's /auth API calls api(); rooms and leagues ask
// resolve() whose a session is and isRegistered() whether a guest's name belongs to an account.
//
// Kept: only hashes of device tokens and codes, and of IP addresses (for rate limits). Sessions are signed with
// AUTH_SECRET (a Wrangler secret) and checked here too, so logging out, or out of every device, takes effect at once.
// Login answers the same way whether or not a name is registered: an unknown name gets a stand-in code nobody knows,
// a made-up masked email that stays the same, and the same attempt counting and lockout.
import { DurableObject } from 'cloudflare:workers';
import { USERNAME_RE, EMAIL_RE, EMAIL_MAX, RESEND_GAP } from '../../src/netproto.js';
import { nameProblem } from './names.js';
import { maskEmail, codeMail, changedMail } from './mail.js';

const SESSION_TTL = 30 * 86_400_000;
const CODE_TTL = 10 * 60_000;
const CODE_TRIES = 5;
const GAP = RESEND_GAP * 1000;
const MAX_DEVICES = 20; // per account; the least recently used go first
const TIDY_EVERY = 60 * 60_000;
const MIN = 60_000;
// [requests, per ms] for each kind of request, counted per IP address and per username (or per account)
const LIMITS = {
  'check:ip': [300, 10 * MIN], 'signup:ip': [10, 60 * MIN],
  'login:ip': [60, 10 * MIN], 'login:name': [10, 10 * MIN],
  'verify:ip': [60, 10 * MIN], 'verify:name': [15, 10 * MIN],
  'resend:ip': [20, 10 * MIN], 'resend:name': [6, 60 * MIN],
  'email:acct': [5, 60 * MIN], 'emailverify:acct': [15, 10 * MIN],
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
const view = (a) => ({ username: a.username, email: maskEmail(a.email), created: a.created });
// a stand-in masked email for a name nobody has, the same every time it's asked for
const FAKE_DOMAINS = ['gmail.com', 'gmail.com', 'gmail.com', 'gmail.com', 'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me'];

export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const q of SCHEMA) this.sql.exec(q);
    this.tidyAt = 0;
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
    const acct = this.byName(name);
    return ok({ session: await this.newSession(acct), deviceToken: token, account: view(acct) });
  }

  async login(input, ipKey, canMail) {
    const name = input.username;
    if (typeof name !== 'string' || !USERNAME_RE.test(name)) return fail(400, 'bad_name');
    const wait = this.limit('login:ip', ipKey) || this.limit('login:name', name.toLowerCase());
    if (wait) return slow(wait);
    const hash = typeof input.deviceToken === 'string' && TOKEN_RE.test(input.deviceToken) ? await sha(input.deviceToken) : null;
    const acct = this.byName(name);
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
    return this.sendCode(this.byName(name), name, 'login', { canMail, resend: true });
  }

  async verify(input, ipKey) {
    const name = input.username;
    if (typeof name !== 'string' || !USERNAME_RE.test(name)) return fail(400, 'bad_name');
    const wait = this.limit('verify:ip', ipKey) || this.limit('verify:name', name.toLowerCase());
    if (wait) return slow(wait);
    const acct = this.byName(name);
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
