// Each account's token wallet, kept in the Accounts object's SQLite (accounts.js owns the tables and calls these):
// a ledger of every change to a balance (the balance is their sum), the cars and parts an account owns, the look
// fitted to each car, Paystack payments and friend invites. Prices, rewards and packs come from src/catalog.js here on
// the server, never from the browser.
import { item, CAR_ITEMS, REWARDS, EARN_KINDS, DAILY_EARN_CAP, INVITE_RACES, MOVE_CAP, earnAmount, packById, naira } from '../../src/catalog.js';
import { cleanLook, cleanPlate, LOOK_DATA, LOGO_KEY_RE } from '../../src/netproto.js';
import { paystack, paymentsReady, newReference, REFERENCE_RE } from './pay.js';
import { vatar, vatarReady, VATAR_ID_RE } from './vatar.js';
import { receiptMail, sendMail } from './mail.js';

export const WALLET_SCHEMA = [
  // reason: welcome | earn | league | invite | earned (cash winnings converted, cash.js) (all earned), purchase (bought),
  // unlock (spent), move (a guest garage moved in, 0)
  // ref: what the change was for ('unlock:paint.chrome', 'pay:DB-7QM4-2210', 'challenge:2026-10-10:hard', …), once each
  `CREATE TABLE IF NOT EXISTS wallet_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, delta INTEGER NOT NULL,
    reason TEXT NOT NULL, ref TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_ref ON wallet_ledger (account_id, ref)',
  // source: bought | earned (a cup or challenge on the player's device) | moved (from a guest garage) | purchase (a pack's gift)
  `CREATE TABLE IF NOT EXISTS owned_items (account_id TEXT NOT NULL, item_id TEXT NOT NULL, acquired_at INTEGER NOT NULL,
    source TEXT NOT NULL, PRIMARY KEY (account_id, item_id))`,
  'CREATE TABLE IF NOT EXISTS looks (account_id TEXT NOT NULL, car_id TEXT NOT NULL, look_json TEXT NOT NULL, PRIMARY KEY (account_id, car_id))',
  // status: pending | paid | failed | abandoned; note says why one failed ('init', 'mismatch'); checked_at: the last verify.
  // Lagos Life purchases are here too, already paid: their reference is Vatar's purchase id and note 'vatar:<mode>'
  `CREATE TABLE IF NOT EXISTS payments (reference TEXT PRIMARY KEY, account_id TEXT NOT NULL, pack_id TEXT NOT NULL, amount_kobo INTEGER NOT NULL,
    currency TEXT NOT NULL, tokens INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL DEFAULT 0, note TEXT)`,
  'CREATE INDEX IF NOT EXISTS payments_account ON payments (account_id, created_at)',
  // players' uploaded logos (the Garage's Logo parts), served to everyone at GET /logo/<key>; key: the first 16 bytes
  // of the picture's SHA-256 in hex, so the same picture is stored once
  'CREATE TABLE IF NOT EXISTS logos (key TEXT PRIMARY KEY, account_id TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS logos_account ON logos (account_id, created_at)',
  // a player who signed up from a friend's invite, and their online races so far (the reward comes at INVITE_RACES)
  'CREATE TABLE IF NOT EXISTS invites (account_id TEXT PRIMARY KEY, inviter_id TEXT NOT NULL, races INTEGER NOT NULL DEFAULT 0, rewarded_at INTEGER)',
  'CREATE INDEX IF NOT EXISTS invites_inviter ON invites (inviter_id)',
];

const MIN = 60_000, DAY = 86_400_000;
export const LOGO_MAX = 48 * 1024; // bytes (logos.js makes them smaller)
const LOGOS_KEPT = 6; // per account; the oldest one no car shows goes when there are more
// what a picture is, from its first bytes: only these three are served
function imageType(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}
function fromBase64(s) {
  try {
    const bin = atob(s);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  } catch { return null; }
}
const HISTORY = 50;
const CAR_IDS = new Set(CAR_ITEMS.map((c) => c.car));
const TIERS = ['easy', 'medium', 'hard'];
const RUN_RE = /^[a-z0-9]{8,32}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ok = (body) => ({ status: 200, body });
const fail = (status, error, extra) => ({ status, body: { error, ...extra } });
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

export class Wallet {
  // A: the Accounts object (its sql, row(), ctx and env)
  constructor(A) {
    this.A = A;
    this.sql = A.sql;
  }

  get env() { return this.A.env; }
  row(q, ...args) { return this.A.row(q, ...args); }
  all(q, ...args) { return this.sql.exec(q, ...args).toArray(); }
  atomic(fn) { return this.A.ctx.storage.transactionSync(fn); }

  balance(id) { return this.row('SELECT COALESCE(SUM(delta), 0) AS b FROM wallet_ledger WHERE account_id = ?', id).b; }
  has(id, ref) { return !!this.row('SELECT 1 AS y FROM wallet_ledger WHERE account_id = ? AND ref = ?', id, ref); }
  // a change to a balance that counts once per ref: false if that ref is already in the ledger
  add(id, delta, reason, ref, at = Date.now()) {
    if (this.has(id, ref)) return false;
    this.sql.exec('INSERT INTO wallet_ledger (account_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)', id, delta, reason, ref, at);
    return true;
  }
  give(id, itemId, source, at = Date.now()) {
    this.sql.exec('INSERT OR IGNORE INTO owned_items (account_id, item_id, acquired_at, source) VALUES (?, ?, ?, ?)', id, itemId, at, source);
  }
  // free things are everyone's
  owns(id, itemId) {
    const it = item(itemId);
    return !!it && (it.price === 0 || !!this.row('SELECT 1 AS y FROM owned_items WHERE account_id = ? AND item_id = ?', id, itemId));
  }
  ownedList(id) { return this.all('SELECT item_id FROM owned_items WHERE account_id = ?', id).map((r) => r.item_id); }
  earnedToday(id) {
    const start = Date.parse(utcDay(Date.now()));
    return this.row("SELECT COALESCE(SUM(delta), 0) AS s FROM wallet_ledger WHERE account_id = ? AND reason = 'earn' AND created_at >= ?", id, start).s;
  }
  starterUsed(id) { return !!this.row("SELECT 1 AS y FROM payments WHERE account_id = ? AND status = 'paid'", id); }

  // every account gets the welcome bonus once, whenever it first uses its wallet
  ensure(A) { this.add(A.id, REWARDS.welcome, 'welcome', 'welcome'); }

  // ---------- GET /wallet ----------
  view(A) {
    const id = A.id;
    const s = this.row(`SELECT COALESCE(SUM(delta), 0) AS balance,
      COALESCE(SUM(CASE WHEN reason IN ('welcome', 'earn', 'league', 'invite', 'earned') THEN delta END), 0) AS earned,
      COALESCE(SUM(CASE WHEN reason = 'purchase' THEN delta END), 0) AS bought FROM wallet_ledger WHERE account_id = ?`, id);
    const looks = {};
    for (const r of this.all('SELECT car_id, look_json FROM looks WHERE account_id = ?', id)) looks[r.car_id] = cleanLook(JSON.parse(r.look_json));
    // a purchase row carries its pack and price
    const history = this.all(`SELECT l.delta, l.reason, l.ref, l.created_at AS at, p.pack_id AS pack, p.amount_kobo AS amount
      FROM wallet_ledger l LEFT JOIN payments p ON l.reason = 'purchase' AND p.reference = substr(l.ref, 5)
      WHERE l.account_id = ? ORDER BY l.id DESC LIMIT ?`, id, HISTORY);
    // payments that haven't added tokens: waiting for the bank, failed or abandoned
    const payments = this.all(`SELECT reference, pack_id AS pack, amount_kobo AS amount, tokens, status, created_at AS at FROM payments
      WHERE account_id = ? AND status != 'paid' ORDER BY created_at DESC LIMIT 20`, id);
    const invited = this.row('SELECT races, rewarded_at FROM invites WHERE account_id = ?', id);
    const friends = this.row('SELECT COUNT(*) AS n, COUNT(rewarded_at) AS done FROM invites WHERE inviter_id = ?', id);
    const logos = this.all('SELECT key FROM logos WHERE account_id = ? ORDER BY created_at DESC', id).map((r) => r.key);
    return {
      balance: s.balance, earned: s.earned, bought: s.bought, owned: this.ownedList(id), looks, logos, history, payments,
      today: this.earnedToday(id), cap: DAILY_EARN_CAP, starterUsed: this.starterUsed(id),
      invited: invited && { races: invited.races, done: !!invited.rewarded_at }, friends: { joined: friends.n, rewarded: friends.done },
    };
  }

  // ---------- POST /wallet/unlock { itemId } ----------
  // the price is the catalog's; owning it already is fine (nothing is spent twice)
  unlock(A, itemId) {
    const it = item(itemId);
    if (!it) return fail(400, 'bad_item');
    if (this.owns(A.id, itemId)) return ok({ balance: this.balance(A.id), owned: this.ownedList(A.id) });
    return this.atomic(() => {
      const bal = this.balance(A.id);
      if (bal < it.price) return fail(402, 'short', { need: it.price - bal, balance: bal });
      this.add(A.id, -it.price, 'unlock', 'unlock:' + itemId);
      this.give(A.id, itemId, 'bought');
      return ok({ balance: bal - it.price, owned: this.ownedList(A.id) });
    });
  }

  // ---------- POST /wallet/equip { carId, look } ----------
  // only on a car the account has, and only parts it owns
  equip(A, carId, look) {
    if (!CAR_IDS.has(carId)) return fail(400, 'bad_car');
    if (!this.owns(A.id, 'car.' + carId)) return fail(403, 'not_owned', { item: 'car.' + carId });
    if (look != null && (typeof look !== 'object' || Array.isArray(look))) return fail(400, 'bad_look');
    const clean = cleanLook(look);
    // a part the catalog doesn't have for that slot is an error, not quietly the factory part
    for (const [slot, id] of Object.entries(look || {})) {
      if (!LOOK_DATA.includes(slot) && id !== clean[slot] && item(id)?.price !== 0) return fail(400, 'bad_look', { item: String(id).slice(0, 40) });
    }
    // a plate number that's offensive (or empty after cleaning) is turned down, so the player can pick another
    if (clean.plate && typeof look.plateText === 'string' && look.plateText.trim() && cleanPlate(look.plateText) !== look.plateText.trim().toUpperCase().replace(/\s+/g, ' ')) return fail(400, 'bad_plate');
    // a logo has to be on the server (uploaded first), so other players can load it
    if (clean.logoKey && !this.row('SELECT 1 AS y FROM logos WHERE key = ?', clean.logoKey)) return fail(400, 'logo_missing');
    const missing = Object.entries(clean).find(([k, id]) => !LOOK_DATA.includes(k) && !this.owns(A.id, id))?.[1];
    if (missing) return fail(403, 'not_owned', { item: missing });
    if (Object.keys(clean).length) this.sql.exec('INSERT OR REPLACE INTO looks (account_id, car_id, look_json) VALUES (?, ?, ?)', A.id, carId, JSON.stringify(clean));
    else this.sql.exec('DELETE FROM looks WHERE account_id = ? AND car_id = ?', A.id, carId);
    return ok({ carId, look: clean, balance: this.balance(A.id) });
  }

  // ---------- POST /wallet/logo { image } ----------
  // A logo picture (base64 PNG, WebP or JPEG, up to LOGO_MAX bytes) for an account that owns a Logo part. Returns its
  // key; the same picture again is the same key and stored once.
  async logoUpload(A, input) {
    if (!this.all("SELECT item_id FROM owned_items WHERE account_id = ? AND item_id LIKE 'logo.%'", A.id).some((r) => item(r.item_id)?.decal)) return fail(403, 'not_owned', { item: 'logo.hood' });
    const bytes = typeof input.image === 'string' && input.image.length <= Math.ceil(LOGO_MAX / 3) * 4 + 4 ? fromBase64(input.image) : null;
    if (!bytes || !bytes.length) return fail(400, 'bad_image');
    if (bytes.length > LOGO_MAX) return fail(413, 'too_big');
    const mime = imageType(bytes);
    if (!mime) return fail(400, 'bad_image');
    const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return this.atomic(() => {
      const now = Date.now();
      const had = this.row('SELECT account_id FROM logos WHERE key = ?', key);
      if (!had) this.sql.exec('INSERT INTO logos (key, account_id, mime, data, created_at) VALUES (?, ?, ?, ?, ?)', key, A.id, mime, bytes.buffer, now);
      else if (had.account_id === A.id) this.sql.exec('UPDATE logos SET created_at = ? WHERE key = ?', now, key);
      // past LOGOS_KEPT, the oldest that no car of this account shows goes
      const mine = this.all('SELECT key FROM logos WHERE account_id = ? ORDER BY created_at DESC', A.id).map((r) => r.key);
      if (mine.length > LOGOS_KEPT) {
        const used = new Set(this.all('SELECT look_json FROM looks WHERE account_id = ?', A.id).map((r) => cleanLook(JSON.parse(r.look_json)).logoKey).filter(Boolean));
        for (const k of mine.slice(LOGOS_KEPT).filter((k) => k !== key && !used.has(k))) this.sql.exec('DELETE FROM logos WHERE key = ?', k);
      }
      return ok({ key });
    });
  }

  // GET /logo/<key>: { mime, data } or null
  logo(key) {
    if (typeof key !== 'string' || !LOGO_KEY_RE.test(key)) return null;
    const r = this.row('SELECT mime, data FROM logos WHERE key = ?', key);
    return r ? { mime: r.mime, data: r.data } : null;
  }

  // ---------- POST /wallet/claim { items } ----------
  // cars and parts a cup win or a daily challenge unlocked free on the player's device (league.js keeps those): only
  // things the catalog says can be earned, so a claim can't reach anything else
  claimEarned(A, items) {
    if (!Array.isArray(items) || items.length > 20) return fail(400, 'bad_items');
    for (const id of items) if (item(id)?.earn && item(id).price > 0) this.give(A.id, id, 'earned');
    return ok({ owned: this.ownedList(A.id) });
  }

  // ---------- POST /wallet/move { items, looks } ----------
  // A new account's guest garage: the cars and parts the guest bought (up to MOVE_CAP tokens' worth, in the order given)
  // and their looks. Once, and only in the account's first day. Guest token balances never move.
  move(A, input) {
    if (Date.now() - A.created > DAY) return fail(403, 'too_late');
    if (this.has(A.id, 'move')) return fail(409, 'moved');
    const ids = Array.isArray(input.items) ? input.items.slice(0, 60) : [];
    const looks = input.looks && typeof input.looks === 'object' && !Array.isArray(input.looks) ? input.looks : {};
    return this.atomic(() => {
      const moved = [];
      let worth = 0;
      for (const id of ids) {
        const it = item(id);
        if (!it || it.price <= 0 || moved.includes(id) || this.owns(A.id, id) || worth + it.price > MOVE_CAP) continue;
        worth += it.price;
        moved.push(id);
        this.give(A.id, id, 'moved');
      }
      // each car's look, without the parts that didn't come along; a look the account already has stays
      let cars = 0;
      for (const [carId, l] of Object.entries(looks)) {
        if (!CAR_IDS.has(carId) || !this.owns(A.id, 'car.' + carId) || this.row('SELECT 1 AS y FROM looks WHERE account_id = ? AND car_id = ?', A.id, carId)) continue;
        const clean = Object.fromEntries(Object.entries(cleanLook(l)).filter(([, id]) => this.owns(A.id, id)));
        if (!Object.keys(clean).length) continue;
        this.sql.exec('INSERT INTO looks (account_id, car_id, look_json) VALUES (?, ?, ?)', A.id, carId, JSON.stringify(clean));
        cars++;
      }
      this.add(A.id, 0, 'move', 'move');
      return ok({ moved, skipped: ids.length - moved.length, cars, owned: this.ownedList(A.id) });
    });
  }

  // ---------- POST /wallet/earn { kind, proof } ----------
  // A reward the player's game says was won. Games run on the player's device, so the server can't see the race: what it
  // checks is that the reward exists, that it hasn't been claimed before (a challenge once per day, a cup or
  // championship once per run) and that it fits under the day's cap. What doesn't fit can be claimed the next day.
  earn(A, kind, proof) {
    if (!EARN_KINDS.includes(kind)) return fail(400, 'bad_kind');
    const amount = earnAmount(kind, proof), ref = this.earnRef(kind, proof);
    if (!amount || !ref) return fail(400, 'bad_proof');
    const now = Date.now();
    // a day's challenge or streak, claimed within a couple of days of it (any time zone)
    if ((kind === 'challenge' || kind === 'streak') && (proof.day < utcDay(now - 2 * DAY) || proof.day > utcDay(now + DAY))) return fail(400, 'too_old');
    if (this.has(A.id, ref)) return fail(409, 'claimed', { balance: this.balance(A.id) });
    // a streak bonus at most once a week
    if (kind === 'streak' && this.row("SELECT 1 AS y FROM wallet_ledger WHERE account_id = ? AND ref LIKE 'streak:%' AND created_at > ?", A.id, now - 6 * DAY)) {
      return fail(409, 'claimed', { balance: this.balance(A.id) });
    }
    const today = this.earnedToday(A.id);
    if (today + amount > DAILY_EARN_CAP) return fail(429, 'cap', { left: Math.max(0, DAILY_EARN_CAP - today), balance: this.balance(A.id) });
    this.add(A.id, amount, 'earn', ref, now);
    return ok({ amount, balance: this.balance(A.id) });
  }

  earnRef(kind, p) {
    if (!p || typeof p !== 'object') return null;
    if (kind === 'challenge') return DAY_RE.test(p.day) && TIERS.includes(p.tier) ? `challenge:${p.day}:${p.tier}` : null;
    if (kind === 'streak') return DAY_RE.test(p.day) ? `streak:${p.day}` : null;
    if (kind === 'cup' || kind === 'f1') return typeof p.run === 'string' && RUN_RE.test(p.run) ? `${kind}:${p.run}` : null;
    return null;
  }

  // ---------- granted by the server itself ----------
  // league race wins (the League object): once per ref
  grant(accountId, reason, ref, amount) {
    if (!this.row('SELECT 1 AS y FROM accounts WHERE id = ?', accountId)) return false;
    return this.add(accountId, amount, reason, ref);
  }

  // a signup from a friend's invite link
  invited(accountId, inviterId) {
    if (accountId !== inviterId) this.sql.exec('INSERT OR IGNORE INTO invites (account_id, inviter_id) VALUES (?, ?)', accountId, inviterId);
  }

  // accounts that just finished an online race (a Room reports them): an invited player's third race pays both players
  raceFinished(ids) {
    const now = Date.now();
    for (const id of new Set(ids)) {
      const inv = this.row('SELECT inviter_id, races FROM invites WHERE account_id = ? AND rewarded_at IS NULL', id);
      if (!inv) continue;
      const races = inv.races + 1;
      this.atomic(() => {
        this.sql.exec('UPDATE invites SET races = ?, rewarded_at = ? WHERE account_id = ?', races, races >= INVITE_RACES ? now : null, id);
        if (races < INVITE_RACES) return;
        this.add(id, REWARDS.invite, 'invite', 'invited');
        this.add(inv.inviter_id, REWARDS.invite, 'invite', 'invite:' + id);
      });
    }
  }

  // ---------- payments (pay.js) ----------
  // POST /pay/init { packId }: a pending payment with our own reference, then Paystack's access code for its popup
  async payInit(A, packId, origin) {
    if (!paymentsReady(this.env)) return fail(503, 'payments_off');
    const pack = packById(packId);
    if (!pack) return fail(400, 'bad_pack');
    if (!Number.isInteger(pack.price_kobo) || pack.price_kobo <= 0) return fail(409, 'not_for_sale');
    if (pack.id === 'starter' && this.starterUsed(A.id)) return fail(409, 'starter_used');
    let reference;
    do reference = newReference(); while (this.row('SELECT 1 AS y FROM payments WHERE reference = ?', reference));
    const now = Date.now();
    this.sql.exec(`INSERT INTO payments (reference, account_id, pack_id, amount_kobo, currency, tokens, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'NGN', ?, 'pending', ?, ?)`, reference, A.id, pack.id, pack.price_kobo, pack.tokens, now, now);
    try {
      const d = await paystack(this.env, '/transaction/initialize', {
        email: A.email, amount: pack.price_kobo, currency: 'NGN', reference,
        metadata: { accountId: A.id, packId: pack.id }, callback_url: `${origin}/?pay=${reference}`,
      });
      if (typeof d.access_code !== 'string') throw new Error('no access code');
      return ok({ reference, access_code: d.access_code });
    } catch (e) {
      console.error(`pay: initialize failed for ${reference} (${e.message})`);
      this.sql.exec("UPDATE payments SET status = 'failed', note = 'init', updated_at = ? WHERE reference = ?", Date.now(), reference);
      return fail(502, 'paystack');
    }
  }

  // GET /pay/status/<reference>: the player's own payments only. One still pending after two minutes is checked with
  // Paystack (at most once a minute), in case its webhook never came.
  async payStatus(A, reference) {
    if (typeof reference !== 'string' || !REFERENCE_RE.test(reference)) return fail(400, 'bad_reference');
    let p = this.row('SELECT * FROM payments WHERE reference = ? AND account_id = ?', reference, A.id);
    if (!p) return fail(404, 'not_found');
    const now = Date.now();
    if (p.status === 'pending' && now - p.created_at > 2 * MIN && now - p.checked_at > MIN && paymentsReady(this.env)) {
      this.sql.exec('UPDATE payments SET checked_at = ? WHERE reference = ?', now, reference);
      await this.verify(reference);
      p = this.row('SELECT * FROM payments WHERE reference = ?', reference);
    }
    return ok({ status: p.status, pack: p.pack_id, tokens: p.tokens, balance: this.balance(A.id) });
  }

  // the webhook's charge.success: Paystack's own verify decides
  async payConfirm(reference) {
    if (typeof reference !== 'string' || !REFERENCE_RE.test(reference)) return;
    const p = this.row('SELECT status FROM payments WHERE reference = ?', reference);
    if (p && p.status !== 'paid') await this.verify(reference);
  }

  async verify(reference) {
    let d;
    try {
      d = await paystack(this.env, '/transaction/verify/' + encodeURIComponent(reference));
    } catch (e) {
      console.error(`pay: verify failed for ${reference} (${e.message})`);
      return;
    }
    const mail = this.settle(reference, d);
    if (mail) await sendMail(this.env, mail);
  }

  // Paystack's word on a payment. It's credited once, and only if it succeeded for exactly our amount and currency;
  // returns the receipt to send when this call credited it.
  settle(reference, d) {
    const p = this.row('SELECT * FROM payments WHERE reference = ?', reference);
    const now = Date.now();
    if (!p || p.status === 'paid') return null;
    if (d.status === 'success') {
      // a cash deposit (cash.js) never buys tokens, whatever its reference
      const kind = (typeof d.metadata === 'string' ? (() => { try { return JSON.parse(d.metadata); } catch { return {}; } })() : d.metadata || {})?.kind;
      if (d.amount !== p.amount_kobo || d.currency !== p.currency || d.reference !== p.reference || kind === 'cash_deposit') {
        console.error(`pay: ${reference} doesn't match (${d.amount} ${d.currency}): not credited`);
        this.sql.exec("UPDATE payments SET status = 'failed', note = 'mismatch', updated_at = ?, checked_at = ? WHERE reference = ?", now, now, reference);
        return null;
      }
      const pack = packById(p.pack_id);
      const credited = this.atomic(() => {
        const fresh = this.add(p.account_id, p.tokens, 'purchase', 'pay:' + reference, now);
        for (const g of pack?.grants || []) this.give(p.account_id, g, 'purchase', now);
        this.sql.exec("UPDATE payments SET status = 'paid', updated_at = ?, checked_at = ? WHERE reference = ?", now, now, reference);
        return fresh;
      });
      const acct = credited && this.row('SELECT username, email FROM accounts WHERE id = ?', p.account_id);
      return acct ? receiptMail(acct.email, acct.username, { pack: pack?.name || p.pack_id, tokens: p.tokens, amount: naira(p.amount_kobo), reference, at: now }) : null;
    }
    const status = d.status === 'abandoned' ? 'abandoned' : ['failed', 'reversed'].includes(d.status) ? 'failed' : 'pending';
    this.sql.exec('UPDATE payments SET status = ?, updated_at = ?, checked_at = ? WHERE reference = ?', status, now, now, reference);
    return null;
  }

  // ---------- Lagos Life purchases (vatar.js) ----------
  // POST /vatar/claim { purchaseId }: a pack bought on Lagos Life's pay sheet. The game only says which purchase; Vatar's
  // own record (GET /purchases/{id}) says whether it's paid and whose it is, and it must be this account's player's.
  async vatarClaim(A, purchaseId) {
    if (!vatarReady(this.env)) return fail(503, 'vatar_off');
    const player = this.A.vatarPlayer(A.id);
    if (!player) return fail(403, 'not_vatar');
    if (typeof purchaseId !== 'string' || !VATAR_ID_RE.test(purchaseId)) return fail(400, 'bad_purchase');
    const p = await vatar(this.env, '/purchases/' + purchaseId);
    if (p.http === 404) return fail(404, 'not_found');
    if (p.http !== 200 || p.id !== purchaseId) {
      console.error(`vatar: checking ${purchaseId} failed (${p.http} ${p.error || ''})`);
      return fail(502, 'vatar');
    }
    if (p.playerId !== player.player_id) return fail(403, 'not_yours');
    return this.vatarCredit(A.id, p);
  }

  // the webhook's purchase.paid, checked the same way. A player with no account here yet is left for the game, which
  // asks for its undelivered purchases at every launch.
  async vatarPaid(purchaseId) {
    if (!vatarReady(this.env) || typeof purchaseId !== 'string' || !VATAR_ID_RE.test(purchaseId)) return;
    const p = await vatar(this.env, '/purchases/' + purchaseId);
    if (p.http !== 200 || p.id !== purchaseId) {
      // the dashboard's test webhook names a purchase that doesn't exist: a 404 here is expected for it
      if (p.http !== 404) console.error(`vatar: webhook check of ${purchaseId} failed (${p.http} ${p.error || ''})`);
      return;
    }
    const link = this.row('SELECT account_id FROM vatar_players WHERE player_id = ?', p.playerId);
    if (link) await this.vatarCredit(link.account_id, p);
  }

  // Vatar's record of a purchase. Its tokens are added once per purchase id, and only for a paid pack at exactly the
  // price this game asks (a product priced differently in Vatar's dashboard is refused, not guessed at); then Vatar is
  // told it was delivered. A purchase already marked delivered but missing here is credited too: the ledger, not
  // Vatar's status, says what was given.
  async vatarCredit(accountId, p) {
    if (p.status === 'refunded') return fail(409, 'refunded');
    if (p.status !== 'paid' && p.status !== 'delivered') return fail(409, 'not_paid');
    const pack = packById(p.productId);
    if (!pack) {
      console.error(`vatar: ${p.id} is for "${p.productId}", which isn't a token pack: not credited`);
      return fail(409, 'bad_product');
    }
    if (p.currency !== 'NGN' || !Number.isInteger(pack.price_kobo) || p.amount * 100 !== pack.price_kobo) {
      console.error(`vatar: ${p.id} paid ${p.amount} ${p.currency} for ${pack.id}, which costs ${pack.price_kobo / 100} NGN here: not credited`);
      return fail(409, 'price_mismatch');
    }
    const now = Date.now();
    const credited = this.atomic(() => {
      const fresh = this.add(accountId, pack.tokens, 'purchase', 'vtr:' + p.id, now);
      if (fresh) {
        for (const g of pack.grants || []) this.give(accountId, g, 'purchase', now);
        this.sql.exec(`INSERT OR IGNORE INTO payments (reference, account_id, pack_id, amount_kobo, currency, tokens, status, created_at, updated_at, checked_at, note)
          VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?)`, p.id, accountId, pack.id, pack.price_kobo, p.currency, pack.tokens,
        Number.isFinite(p.createdAt) ? p.createdAt : now, now, now, 'vatar:' + (p.mode === 'live' ? 'live' : 'test'));
      }
      return fresh;
    });
    if (p.status === 'paid') {
      const d = await vatar(this.env, `/purchases/${p.id}/deliver`, {});
      // not marked: it stays in the game's undelivered list, and the next claim marks it (the tokens aren't added twice)
      if (d.http !== 200) console.error(`vatar: marking ${p.id} delivered failed (${d.http} ${d.error || ''})`);
    }
    return ok({ purchaseId: p.id, pack: pack.id, tokens: pack.tokens, balance: this.balance(accountId), credited });
  }
}
