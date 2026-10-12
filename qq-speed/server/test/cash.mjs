// End-to-end check of the cash wallet and cash races (server/src/cash.js, fair.js and the Room's cash mode):
// age, identity and bank checks; Paystack deposits; responsible-play limits and self-exclusion; rooms that fill, race
// and pay out (winner takes all and a 6-player top-3 split with a tie and a DNF); a room that doesn't fill; a reported
// race; a forced cheat; withdrawals that succeed, fail and are reversed; a flagged withdrawal; converting to tokens;
// the admin page's API; and CASH_RACES off by default.
// Starts its own local server (wrangler dev, empty storage, emails logged, short timers) and a stand-in for Paystack's
// API, so nothing else needs to be running: npm run test:cash. Races are driven for real over WebSockets with
// made-up car updates, so it takes about four minutes.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACK_LEN, SNAPSHOT_HZ } from '../../src/netproto.js';
import { prizePool, placeShares, tokensFor, transferFee, CASH_DEFAULTS } from '../../src/cash.js';

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'sk_test_local_stand_in_0123456789';
const ADMIN_KEY = 'admin-key-for-tests-0123456789';
const WINDOW = 8000; // ms: fill window, start window and report window, shortened for the test
const CFG = { fillMs: WINDOW, startMs: WINDOW, reportMs: WINDOW, withdrawGapMs: 0, withdrawalsPerDay: 2 };
let failures = 0;
const check = (cond, what, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${!cond && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = (naira) => naira * 100; // kobo

// ---------- a stand-in for Paystack's API ----------
const inits = [], verdicts = {}, recipients = [], transfers = [], transferStatus = {}, transferReply = [];
const ACCOUNTS = { '0001234567': 'OKAFOR ADA C', '0007654321': 'CHIDI NNAMDI EZE', '0009999999': 'JOHN DOE' };
const paystack = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { status: false, message: 'Invalid key' });
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/transaction/initialize') {
      const b = JSON.parse(body);
      inits.push(b);
      return send(200, { status: true, data: { access_code: 'ac_' + b.reference, reference: b.reference } });
    }
    let m = /^\/transaction\/verify\/(.+)$/.exec(u.pathname);
    const init = m && inits.find((i) => i.reference === decodeURIComponent(m[1]));
    if (req.method === 'GET' && init) {
      const v = verdicts[init.reference] || {};
      return send(200, { status: true, data: { status: v.status || 'success', reference: init.reference, amount: v.amount ?? Number(init.amount), currency: v.currency || init.currency,
        metadata: v.metadata ?? init.metadata } });
    }
    if (req.method === 'GET' && u.pathname === '/bank') return send(200, { status: true, data: [{ code: '058', name: 'GTBank', active: true }, { code: '044', name: 'Access Bank', active: true }] });
    if (req.method === 'GET' && u.pathname === '/bank/resolve') {
      const name = ACCOUNTS[u.searchParams.get('account_number')];
      return name ? send(200, { status: true, data: { account_name: name, account_number: u.searchParams.get('account_number') } }) : send(422, { status: false, message: 'Could not resolve account name' });
    }
    if (req.method === 'POST' && u.pathname === '/transferrecipient') {
      const b = JSON.parse(body);
      recipients.push(b);
      return send(201, { status: true, data: { recipient_code: 'RCP_' + recipients.length, name: b.name } });
    }
    if (req.method === 'POST' && u.pathname === '/transfer') {
      const b = JSON.parse(body);
      transfers.push(b);
      const how = transferReply.shift() || 'pending';
      if (how === 'refuse') return send(400, { status: false, message: 'Your balance is not enough to fulfil this request' });
      transferStatus[b.reference] = 'pending';
      return send(200, { status: true, data: { reference: b.reference, status: 'pending', transfer_code: 'TRF_' + transfers.length } });
    }
    m = /^\/transfer\/verify\/(.+)$/.exec(u.pathname);
    if (req.method === 'GET' && m) {
      const ref = decodeURIComponent(m[1]);
      return transferStatus[ref] ? send(200, { status: true, data: { reference: ref, status: transferStatus[ref] } }) : send(404, { status: false, message: 'Transfer not found' });
    }
    send(404, { status: false, message: 'Not found' });
  });
});
await new Promise((r) => paystack.listen(0, '127.0.0.1', r));
const PAYSTACK = `http://127.0.0.1:${paystack.address().port}`;

// ---------- the server ----------
function startServer(port, vars) {
  const store = mkdtempSync(join(tmpdir(), 'driftbolt-cash-'));
  const args = ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', store, '--show-interactive-dev-session=false'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const proc = spawn('npx', args, { cwd: new URL('../..', import.meta.url).pathname, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { log: '', proc, store };
  const onOut = (d) => {
    out.log += d;
    for (const m of String(d).matchAll(/\[dev mail\] to (\S+) \| (.+?) \| (.*)/g)) mails.push({ to: m[1], subject: m[2], text: m[3] });
  };
  proc.stdout.on('data', onOut);
  proc.stderr.on('data', onOut);
  return out;
}
async function ready(base, srv) {
  for (let i = 0; i < 160; i++) {
    const h = await fetch(`${base}/health`).catch(() => null);
    if (h?.ok) return;
    if (srv.proc.exitCode !== null) throw new Error('wrangler dev exited:\n' + srv.log);
    await sleep(500);
  }
  throw new Error('wrangler dev did not start:\n' + srv.log.slice(-2000));
}
const mails = [];
const VARS = {
  AUTH_SECRET: 'test-secret-0123456789abcdef', EMAIL_PROVIDER: 'console', PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API: PAYSTACK,
  CASH_RACES: 'on', CASH_CONFIG: JSON.stringify(CFG), KYC_PROVIDER: 'mock', ADMIN_USERS: 'Ngozi_Ops', ADMIN_KEY,
};
const server = startServer(PORT, VARS);
let offServer = null;
const stop = () => {
  for (const s of [server, offServer]) if (s) { try { s.proc.kill('SIGTERM'); } catch { /* gone */ } rmSync(s.store, { recursive: true, force: true }); }
  paystack.close();
};

async function api(path, body, session, headers = {}, base = BASE) {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(session && { authorization: `Bearer ${session}` }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}
const cash = async (s) => (await api('/cash', undefined, s)).body;
const bal = async (s) => (await cash(s)).balance.available;
const signup = async (username) => (await api('/auth/signup', { username, email: `${username.toLowerCase()}@example.com` })).body.session;
const signed = (raw) => createHmac('sha512', SECRET).update(raw).digest('hex');
const webhook = (event, sig) => {
  const raw = JSON.stringify(event);
  return fetch(BASE + '/paystack/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': sig ?? signed(raw) }, body: raw });
};
const charge = (reference, metadata = { kind: 'cash_deposit' }) => ({ event: 'charge.success', data: { reference, status: 'success', metadata } });
const admin = (path, body, session) => api('/admin/api/' + path, body || {}, session, { 'x-admin-key': ADMIN_KEY });
async function until(fn, want, ms = 15_000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (want(v)) return v; await sleep(200); }
  return v;
}

// a deposit, paid: init, Paystack's webhook, and the server's verify
async function deposit(session, amount) {
  const r = await api('/cash/deposit/init', { amount }, session);
  if (r.status !== 200) return r;
  await webhook(charge(r.body.reference));
  return { ...r, paid: await until(async () => (await api('/cash/deposit/status/' + r.body.reference, undefined, session)).body, (b) => b?.status === 'paid') };
}

// ---------- racing ----------
function racer(room, session) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?action=join&room=${room}`, { headers: { Origin: BASE } });
  const inbox = [], waiting = [];
  let last = null;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'room') last = m;
    const i = waiting.findIndex((w) => w.is(m));
    if (i >= 0) waiting.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  };
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not connect')); });
  const closed = new Promise((resolve) => { ws.onclose = (e) => resolve(e); });
  return {
    send: (m) => ws.send(JSON.stringify(m)),
    get room() { return last; },
    closed,
    // t: a message type, or a list of them
    next(t, pred = () => true, ms = 30_000) {
      const is = (m) => (Array.isArray(t) ? t.includes(m.t) : m.t === t) && pred(m);
      const i = inbox.findIndex(is);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { is, resolve };
        waiting.push(w);
        setTimeout(() => { if (waiting.includes(w)) reject(new Error(`no '${t}' message within ${ms} ms`)); }, ms);
      });
    },
    // resolves with the welcome, or rejects with the room's refusal
    async hello() {
      await opened;
      this.send({ t: 'hello', ...(session && { session }) });
      const m = await this.next(['welcome', 'error']);
      if (m.t === 'error') throw new Error(m.code);
      return m;
    },
    close: () => ws.close(),
  };
}

// drive one car: honest made-up updates at SNAPSHOT_HZ along a straight line, progress at v m/s from the grid
// (14 m behind the line). plan: { v, lane, cheat, quitAt } — cheat jumps ahead and claims an impossible lap.
async function drive(R, go, load, plan) {
  const L = TRACK_LEN[load.cfg.map], laps = load.cfg.laps;
  let lapSent = 0, doneAt = 0;
  for (;;) {
    const now = Date.now();
    if (plan.quitAt && now - go.startAt > plan.quitAt) { R.send({ t: 'quit' }); return; }
    let P = (plan.v * (now - go.startAt)) / 1000 - 14;
    if (now < go.startAt) P = -14;
    if (plan.cheat && now - go.startAt > 4000) P += L * 0.9; // teleports most of a lap ahead
    const lapsDone = P < 0 ? -1 : Math.floor(P / L);
    const d = P - lapsDone * L;
    R.send({ t: 's', p: [now, P, 0, plan.lane, 0, 0, plan.v, 0, d, plan.lane, 0, 0, Math.min(lapsDone, laps)] });
    while (lapSent < laps && P >= (lapSent + 1) * L) {
      lapSent++;
      const time = plan.cheat ? (now - go.startAt) / 1000 : ((lapSent * L + 14) / plan.v);
      R.send({ t: 'lap', seq: load.seq, lap: lapSent, time: Math.round(time * 1000) / 1000 });
    }
    if (lapSent >= laps && now > (doneAt ||= now) + 600) return;
    await sleep(1000 / SNAPSHOT_HZ);
  }
}

// a cash race: everyone ready, the host starts, every car driven by plan; resolves with the results message
async function cashRace(racers, plans, label) {
  const [host, ...rest] = racers;
  for (const r of rest) r.send({ t: 'set', ready: true });
  await host.next('room', (m) => m.players.length === racers.length && m.players.every((p) => p.ready || p.id === m.host));
  host.send({ t: 'start' });
  const loads = await Promise.all(racers.map((r) => r.next('load')));
  for (const [i, r] of racers.entries()) r.send({ t: 'loaded', seq: loads[i].seq });
  const gos = await Promise.all(racers.map((r) => r.next('go')));
  const L = TRACK_LEN[loads[0].cfg.map];
  console.log(`      ${label}: ${racers.length} racers, ${loads[0].cfg.laps} lap on ${loads[0].cfg.map}, about ${Math.round((L + 14) / Math.min(...plans.map((p) => p.v)) + (gos[0].startAt - Date.now()) / 1000)} s…`);
  const winner = plans.reduce((b, p, i) => (!p.quitAt && (b < 0 || p.v > plans[b].v) ? i : b), -1);
  await Promise.all(racers.map((r, i) => drive(r, gos[i], loads[i], plans[i])));
  racers[winner].send({ t: 'ev', k: 'celeb', kind: 'donuts' });
  return host.next('results', () => true, 60_000);
}

async function main() {
  await ready(BASE, server);

  // ---------- the flag and the config ----------
  let r = await api('/cash/config');
  check(r.status === 200 && r.body.mode === 'on' && r.body.cfg.reportMs === WINDOW && r.body.cfg.feePct === CASH_DEFAULTS.feePct, 'GET /cash/config: on, with the overrides', r.body);

  // ---------- accounts and the checks ----------
  const names = ['Ada', 'Bola', 'Chidi', 'Dayo', 'Emeka', 'Funmi'];
  const S = {};
  for (const n of [...names, 'Kiddo', 'Ngozi_Ops']) S[n] = await signup(n);
  check(Object.values(S).every(Boolean), 'eight accounts');
  r = await api('/cash');
  check(r.status === 401, 'GET /cash needs a session', r.status);
  let c = await cash(S.Ada);
  check(c.mode === 'on' && c.currency === null && c.checks.age === 'needed' && c.balance.available === 0, 'a new cash wallet: no currency, no checks, empty', c);
  r = await api('/cash/deposit/init', { amount: N(500) }, S.Ada);
  check(r.status === 409 && r.body.error === 'currency_needed', 'deposit before choosing a currency: currency_needed', r.body);
  r = await api('/cash/currency', { currency: 'EUR' }, S.Ada);
  check(r.status === 400 && r.body.error === 'bad_currency', 'only NGN or USD', r.body);
  for (const n of [...names, 'Kiddo']) await api('/cash/currency', { currency: 'NGN' }, S[n]);
  r = await api('/cash/deposit/init', { amount: N(500) }, S.Ada);
  check(r.status === 403 && r.body.error === 'age_needed', 'deposit before confirming age: age_needed', r.body);
  r = await api('/cash/age', { dob: '2015-02-30' }, S.Kiddo);
  check(r.status === 400 && r.body.error === 'bad_dob', 'a date that doesn\'t exist is refused', r.body);
  const teen = new Date(Date.now() - 16 * 365.25 * 86_400_000).toISOString().slice(0, 10);
  r = await api('/cash/age', { dob: teen }, S.Kiddo);
  check(r.status === 403 && r.body.error === 'under_age', 'under 18: refused', r.body);
  r = await api('/cash/age', { dob: '1990-01-01' }, S.Kiddo);
  check(r.status === 403 && r.body.error === 'age_blocked', 'and the date of birth can\'t then be changed', r.body);
  for (const n of names) await api('/cash/age', { dob: '1995-06-15' }, S[n]);
  c = await cash(S.Ada);
  check(c.checks.age === 'done' && c.checks.dob === '1995-06-15', 'age confirmed', c.checks);

  // ---------- deposits ----------
  r = await api('/cash/deposit/init', { amount: N(50) }, S.Ada);
  check(r.status === 400 && r.body.error === 'min_deposit', 'below the minimum deposit', r.body);
  r = await api('/cash/deposit/init', { amount: N(1000) }, S.Ada, { Origin: 'https://driftbolt.netlify.app' });
  const ref1 = r.body?.reference, init1 = inits.find((i) => i.reference === ref1);
  check(r.status === 200 && /^DC-[A-Z0-9]{6}-\d{4}$/.test(ref1) && r.body.access_code === 'ac_' + ref1, 'deposit/init: our reference and Paystack\'s access code', r.body);
  check(init1?.metadata?.kind === 'cash_deposit' && Number(init1.amount) === N(1000) && init1.currency === 'NGN' && init1.email === 'ada@example.com'
    && init1.callback_url === `https://driftbolt.netlify.app/?cashpay=${ref1}`, 'Paystack gets metadata.kind = cash_deposit, the amount in kobo, NGN and the email', init1);
  let h = await webhook(charge(ref1), 'ab'.repeat(64));
  check(h.status === 401, 'webhook: a bad signature gets 401', h.status);
  check(await bal(S.Ada) === 0, 'nothing credited without a good signature');
  h = await webhook(charge(ref1, { accountId: 'x' })); // a charge without the cash kind goes to the token side, which doesn't know it
  await sleep(500);
  check(await bal(S.Ada) === 0, 'a charge.success without metadata.kind = cash_deposit doesn\'t credit cash');
  await webhook(charge(ref1));
  let st = await until(async () => (await api('/cash/deposit/status/' + ref1, undefined, S.Ada)).body, (b) => b?.status === 'paid');
  check(st.status === 'paid' && st.balance === N(1000), 'webhook + verify: ₦1,000 credited', st);
  await webhook(charge(ref1));
  await sleep(500);
  c = await cash(S.Ada);
  check(c.balance.available === N(1000) && c.history.filter((x) => x.kind === 'deposit').length === 1, 'a duplicate webhook credits once', c.history);
  check(mails.some((m) => m.subject.includes(ref1)), 'a deposit receipt is emailed', mails.slice(-1));
  check((await api('/wallet', undefined, S.Ada)).body.balance === 200, 'cash deposits never touch tokens (still the welcome bonus)');
  r = await api('/cash/deposit/init', { amount: N(200) }, S.Ada);
  verdicts[r.body.reference] = { amount: N(150) };
  await webhook(charge(r.body.reference));
  st = await until(async () => (await api('/cash/deposit/status/' + r.body.reference, undefined, S.Ada)).body, (b) => b?.status === 'failed');
  check(st.status === 'failed' && st.balance === N(1000), 'an amount mismatch is not credited', st);
  r = await api('/cash/deposit/init', { amount: N(200) }, S.Ada);
  verdicts[r.body.reference] = { metadata: { kind: 'tokens' } };
  await webhook(charge(r.body.reference));
  st = await until(async () => (await api('/cash/deposit/status/' + r.body.reference, undefined, S.Ada)).body, (b) => b?.status === 'failed');
  check(st.status === 'failed', 'Paystack\'s verify not saying cash_deposit: not credited', st);
  for (const n of names.slice(1)) {
    const d = await deposit(S[n], N(1000));
    check(d.paid?.status === 'paid', `${n} deposits ₦1,000`, d.body);
  }

  // ---------- responsible play ----------
  r = await api('/cash/limits', { deposit: N(1500) }, S.Bola);
  check(r.status === 200 && r.body.limits.deposit === N(1500), 'lowering the deposit limit works at once', r.body.limits);
  r = await api('/cash/deposit/init', { amount: N(600) }, S.Bola);
  check(r.status === 403 && r.body.error === 'deposit_limit' && r.body.left === N(500), 'a deposit over the daily limit: deposit_limit, with what\'s left', r.body);
  r = await api('/cash/limits', { deposit: N(40000) }, S.Bola);
  check(r.status === 200 && r.body.limits.deposit === N(1500) && r.body.limits.pending?.deposit === N(40000) && r.body.limits.pending.at > Date.now() + 23 * 3600_000,
    'raising it waits 24 hours', r.body.limits);
  r = await api('/cash/limits', { entry: N(150) }, S.Emeka);
  check(r.status === 200 && r.body.limits.entry === N(150), 'Emeka sets a ₦150 daily entry limit', r.body.limits);
  r = await api('/cash/exclude', { days: 5 }, S.Funmi);
  check(r.status === 400, 'a break is 7, 30 or 90 days', r.body);

  // ---------- a room that doesn't fill: everyone refunded ----------
  r = await api('/cash/rooms', { entry: N(100), seats: 4, split: 'wta', map: 'bay', laps: 1 }, S.Ada);
  const lonely = r.body?.room?.code;
  check(r.status === 200 && /^C[A-Z0-9]{4}$/.test(lonely) && r.body.room.status === 'open' && r.body.room.seated.length === 1, 'Ada hosts a 4-seat ₦100 room', r.body);
  check(await bal(S.Ada) === N(900), 'the host\'s entry is held at once', await bal(S.Ada));
  r = await api('/cash/rooms', { entry: N(100), seats: 2, split: 'top3', map: 'bay', laps: 1 }, S.Bola);
  check(r.status === 400 && r.body.error === 'bad_split', 'top 3 needs 4+ players', r.body);
  r = await api('/cash/rooms', { entry: N(123), seats: 2, split: 'wta', map: 'bay', laps: 1 }, S.Bola);
  check(r.status === 400 && r.body.error === 'bad_entry', 'only the listed entries', r.body);
  r = await api('/cash/rooms/join', { code: lonely }, S.Bola);
  check(r.status === 200 && r.body.room.seated.length === 2 && !JSON.stringify(r.body).includes('"account"'), 'Bola joins (and sees names, not account ids)', r.body);
  r = await api('/cash/rooms/join', { code: lonely }, S.Bola);
  check(r.status === 200 && await bal(S.Bola) === N(900), 'joining twice holds one entry', await bal(S.Bola));
  console.log(`      waiting ${WINDOW / 1000} s for the room not to fill…`);
  let room = await until(async () => (await api('/cash/rooms/' + lonely, undefined, S.Ada)).body.room, (x) => x.status === 'refunded', WINDOW + 10_000);
  check(room.status === 'refunded' && room.note === 'expired', 'not full in time: refunded', room);
  check(await bal(S.Ada) === N(1000) && await bal(S.Bola) === N(1000), 'both entries back in full', [await bal(S.Ada), await bal(S.Bola)]);
  c = await cash(S.Ada);
  check(c.history.filter((x) => x.kind === 'entry_refund' && x.ref === lonely).length === 1, 'one entry_refund each', c.history.slice(0, 3));
  r = await api('/cash/rooms/join', { code: lonely }, S.Chidi);
  check(r.status === 409 && r.body.error === 'room_closed', 'a closed room can\'t be joined', r.body);

  // ---------- winner takes all: fund, host, join, race, payout ----------
  r = await api('/cash/rooms', { entry: N(100), seats: 2, split: 'wta', map: 'bay', laps: 1 }, S.Ada);
  const wta = r.body.room.code;
  const A = racer(wta, S.Ada);
  const wa = await A.hello();
  check(!!wa.id, 'the host connects to the room');
  const stranger = racer(wta, S.Chidi);
  await stranger.hello().catch(() => null);
  const shut = await stranger.closed;
  check(shut.code === 4008, 'someone who hasn\'t paid can\'t get in (not_paid)', shut.code);
  const guest = racer(wta, null);
  await guest.hello().catch(() => null);
  check((await guest.closed).code === 4009, 'a guest can\'t get in (login_needed)');
  await api('/cash/rooms/join', { code: wta }, S.Bola);
  const B = racer(wta, S.Bola);
  await B.hello();
  let view = await A.next('room', (m) => m.players.length === 2 && m.cash.seated.length === 2);
  check(view.cash.entry === N(100) && view.cash.pool === N(200) && view.cash.prize === N(180) && view.cash.fullAt && view.players.every((p) => p.car === 1),
    'the lobby: both paid, pool ₦200, winner gets ₦180, everyone in the same car', view.cash);
  check(!JSON.stringify(view).includes('"account"'), 'room views never carry account ids');
  A.send({ t: 'start' });
  await sleep(500);
  check(!A.room || A.room.phase === 'lobby', 'start waits until every guest is ready');
  let res = await cashRace([A, B], [{ v: 72, lane: -2 }, { v: 68, lane: 2 }], 'race 1');
  check(res.rows[0].name === 'Ada' && res.rows[0].finished && res.rows[1].finished, 'Ada wins on the server\'s clock', res.rows);
  view = await A.next('room', (m) => m.cash?.status === 'window', 20_000);
  check(view.cash.plan?.awards?.[0]?.name === 'Ada' && view.cash.plan.awards[0].amount === N(180) && view.cash.releaseAt > Date.now(), 'checks passed: ₦180 waits out the report window', view.cash);
  c = await cash(S.Ada);
  check(c.balance.available === N(900) && c.balance.arriving[0]?.amount === N(180) && c.balance.total === N(1080), 'Winnings: ₦900 available, ₦180 arriving', c.balance);
  r = await api('/cash/withdraw', { amount: N(500) }, S.Ada);
  check(r.status === 403 && r.body.error === 'kyc_needed', 'withdrawing before identity checks: kyc_needed', r.body);
  view = await A.next('room', (m) => m.cash?.status === 'settled', WINDOW + 15_000);
  check(view.cash.status === 'settled', 'after the window: settled');
  check(await bal(S.Ada) === N(1080) && await bal(S.Bola) === N(900), 'Ada +₦80, Bola −₦100', [await bal(S.Ada), await bal(S.Bola)]);
  c = await cash(S.Ada);
  check(c.history.some((x) => x.kind === 'prize' && x.amount === N(180) && x.ref === wta), 'a prize row', c.history.slice(0, 3));
  A.close();
  B.close();

  // ---------- 6 racers, top 3 split, a tie and a DNF ----------
  r = await api('/cash/rooms/join', { code: 'C2222' }, S.Ada);
  check(r.status === 404 && r.body.error === 'room_not_found', 'an unknown code: room_not_found', r.body);
  r = await api('/cash/rooms/' + wta, undefined, S.Emeka);
  check(r.status === 200 && r.body.room.preview && r.body.room.entry === N(100) && r.body.room.hostName === 'Ada' && !r.body.room.result && !r.body.room.plan,
    'someone with the code sees the terms only (to decide whether to pay in)', r.body.room);
  r = await api('/cash/exclude', { days: 7 }, S.Funmi);
  check(r.status === 200 && r.body.excludedUntil > Date.now() + 6 * 86_400_000, 'Funmi takes a 7-day break', r.body.excludedUntil);
  r = await api('/cash/rooms', { entry: N(100), seats: 6, split: 'top3', map: 'bay', laps: 1 }, S.Chidi);
  const six = r.body.room.code;
  r = await api('/cash/rooms/join', { code: six }, S.Funmi);
  check(r.status === 403 && r.body.error === 'excluded', 'a player on a break can\'t enter', r.body);
  r = await api('/cash/deposit/init', { amount: N(100) }, S.Funmi);
  check(r.status === 403 && r.body.error === 'excluded', '…or deposit', r.body);
  r = await api('/cash/rooms/join', { code: six }, S.Emeka);
  check(r.status === 200, 'Emeka joins (₦100 of his ₦150 entry limit)', r.body);
  // Emeka's limit is now ₦50 short of another entry: proven in the next room
  const kiddo = await api('/cash/rooms/join', { code: six }, S.Kiddo);
  check(kiddo.status === 403 && kiddo.body.error === 'age_blocked', 'an under-18 account can\'t enter', kiddo.body);
  for (const n of ['Ada', 'Bola', 'Dayo']) await api('/cash/rooms/join', { code: six }, S[n]);
  // the sixth seat: Funmi is on a break, so a new account takes it
  S.Gbenga = await signup('Gbenga');
  await api('/cash/currency', { currency: 'NGN' }, S.Gbenga);
  await api('/cash/age', { dob: '1999-09-09' }, S.Gbenga);
  await deposit(S.Gbenga, N(500));
  r = await api('/cash/rooms/join', { code: six }, S.Gbenga);
  check(r.status === 200 && r.body.room.seated.length === 6, 'six seats paid', r.body.room?.seated);
  r = await api('/cash/rooms/join', { code: six }, S.Ngozi_Ops);
  check(r.status === 409 && r.body.error === 'room_full', 'a seventh can\'t join', r.body);
  const order = ['Chidi', 'Ada', 'Bola', 'Dayo', 'Emeka', 'Gbenga'];
  const R6 = order.map((n) => racer(six, S[n]));
  for (const x of R6) await x.hello();
  await R6[0].next('room', (m) => m.players.length === 6);
  const before6 = Object.fromEntries(await Promise.all(order.map(async (n) => [n, await bal(S[n])])));
  // Ada wins, Bola and Dayo tie for 2nd, Chidi 4th, Emeka 5th, Gbenga quits (DNF, forfeits)
  res = await cashRace(R6, [{ v: 64, lane: 0 }, { v: 74, lane: 1 }, { v: 70, lane: 2 }, { v: 70, lane: 3 }, { v: 60, lane: 4 }, { v: 66, lane: 5, quitAt: 6000 }], 'race 2');
  const pl = Object.fromEntries(res.rows.map((x) => [x.name, x]));
  check(pl.Ada.place === 1 && pl.Bola.time === pl.Dayo.time && pl.Gbenga.out && !pl.Gbenga.finished, 'the server\'s order: Ada, Bola = Dayo, …, Gbenga DNF', res.rows);
  const { prize } = prizePool(N(100), 6, CASH_DEFAULTS.feePct);
  const sh = placeShares(prize, 'top3');
  view = await R6[0].next('room', (m) => m.cash?.status === 'window', 20_000);
  const aw = Object.fromEntries(view.cash.plan.awards.map((a) => [a.name, a.amount]));
  check(aw.Ada === sh[0] && aw.Bola === (sh[1] + sh[2]) / 2 && aw.Dayo === (sh[1] + sh[2]) / 2 && !aw.Chidi && !aw.Gbenga,
    `60/30/10 of ₦${prize / 100}: Ada ₦${sh[0] / 100}; the tie shares 2nd and 3rd (₦${(sh[1] + sh[2]) / 200} each)`, aw);
  view = await R6[0].next('room', (m) => m.cash?.status === 'settled', WINDOW + 15_000);
  const after6 = Object.fromEntries(await Promise.all(order.map(async (n) => [n, await bal(S[n])])));
  check(after6.Ada === before6.Ada + sh[0] && after6.Gbenga === before6.Gbenga && after6.Chidi === before6.Chidi, 'paid out; the DNF\'s entry stayed in the pool', { before6, after6 });
  for (const x of R6) x.close();
  r = await api('/cash/rooms', { entry: N(100), seats: 2, split: 'wta', map: 'bay', laps: 1 }, S.Emeka);
  check(r.status === 403 && r.body.error === 'entry_limit' && r.body.left === N(50), 'Emeka\'s ₦150 entry limit: ₦50 left today', r.body);

  // ---------- a reported race: held, then released by an admin ----------
  r = await api('/cash/rooms', { entry: N(200), seats: 2, split: 'wta', map: 'bay', laps: 1 }, S.Bola);
  const rep = r.body.room.code;
  await api('/cash/rooms/join', { code: rep }, S.Dayo);
  const [RB, RD] = [racer(rep, S.Bola), racer(rep, S.Dayo)];
  await RB.hello();
  await RD.hello();
  await RB.next('room', (m) => m.players.length === 2);
  await cashRace([RB, RD], [{ v: 66, lane: 0 }, { v: 71, lane: 1 }], 'race 3');
  await RB.next('room', (m) => m.cash?.status === 'window', 20_000);
  r = await api('/cash/rooms/report', { code: rep, reason: 'Dayo was impossibly fast on the bridge' }, S.Ngozi_Ops);
  check(r.status === 404, 'only a racer in the room can report it', r.body);
  r = await api('/cash/rooms/report', { code: rep, reason: 'Dayo was impossibly fast on the bridge' }, S.Bola);
  check(r.status === 200 && r.body.room.status === 'review' && r.body.room.reported, 'Bola reports it: held for review', r.body.room);
  const dayoBefore = await bal(S.Dayo);
  await sleep(WINDOW + 2000);
  check(await bal(S.Dayo) === dayoBefore && (await api('/cash/rooms/' + rep, undefined, S.Dayo)).body.room.status === 'review', 'the window passes: still held');
  c = await cash(S.Dayo);
  check(c.balance.arriving.some((a) => a.code === rep && a.held), 'Winnings shows it as held', c.balance.arriving);
  r = await admin('list', {}, S.Bola);
  check(r.status === 403 && r.body.error === 'not_admin', 'admin: a player who isn\'t one is refused', r.body);
  r = await api('/admin/api/list', {}, S.Ngozi_Ops, { 'x-admin-key': 'wrong-key-wrong-key-123' });
  check(r.status === 403, 'admin: the wrong key is refused', r.status);
  r = await admin('list', {}, S.Ngozi_Ops);
  const inReview = r.body?.rooms?.find((x) => x.code === rep);
  check(r.status === 200 && inReview && inReview.reportList[0]?.name === 'Bola', 'admin: the reported room is listed with its report', r.body);
  r = await admin('replay', { code: rep }, S.Ngozi_Ops);
  check(r.status === 200 && r.body.replay.racers.length === 2 && r.body.replay.racers[0].rec.length > 50, 'admin: the replay data is there', r.body.replay?.racers?.map((x) => x.rec.length));
  r = await admin('act', { action: 'release', target: rep, note: 'Replay looks clean' }, S.Ngozi_Ops);
  check(r.status === 200 && r.body.log[0]?.action === 'release' && r.body.log[0].admin === 'Ngozi_Ops' && r.body.log[0].note === 'Replay looks clean', 'admin releases it; the action is logged', r.body.log?.[0]);
  check(await bal(S.Dayo) === dayoBefore + prizePool(N(200), 2, CASH_DEFAULTS.feePct).prize, 'Dayo is paid', await bal(S.Dayo));
  r = await admin('act', { action: 'release', target: rep, note: 'again' }, S.Ngozi_Ops);
  check(r.status === 409, 'a room can\'t be paid twice', r.body);
  RB.close();
  RD.close();

  // ---------- a forced cheat: an impossible lap is frozen, then refunded ----------
  r = await api('/cash/rooms', { entry: N(100), seats: 2, split: 'wta', map: 'bay', laps: 1 }, S.Chidi);
  const cheat = r.body.room.code;
  await api('/cash/rooms/join', { code: cheat }, S.Ada);
  const [RC, RA] = [racer(cheat, S.Chidi), racer(cheat, S.Ada)];
  await RC.hello();
  await RA.hello();
  await RC.next('room', (m) => m.players.length === 2);
  const chidiBefore = await bal(S.Chidi), adaBefore = await bal(S.Ada);
  res = await cashRace([RC, RA], [{ v: 60, lane: 0 }, { v: 66, lane: 1, cheat: true }], 'race 4 (Ada cheats)');
  check(res.rows[0].name === 'Ada', 'the cheat "wins" on the claimed time', res.rows);
  view = await RC.next('room', (m) => m.cash?.status === 'review', 20_000);
  check(view.cash.status === 'review' && view.cash.flagged, 'frozen for review, not paid', view.cash);
  r = await admin('list', {}, S.Ngozi_Ops);
  const frozen = r.body.rooms.find((x) => x.code === cheat);
  const checks = new Set(frozen?.flags.map((f) => f.check));
  check(frozen && frozen.flags.every((f) => f.name === 'Ada') && checks.has('lap_time') && checks.has('teleport') && checks.has('checkpoints'),
    'the failed checks: lap_time, teleport, checkpoints (all Ada\'s)', frozen?.flags);
  await sleep(WINDOW + 1000);
  check(await bal(S.Ada) === adaBefore && await bal(S.Chidi) === chidiBefore, 'nothing paid while frozen');
  r = await admin('act', { action: 'refund', target: cheat, note: 'Teleport on lap 1' }, S.Ngozi_Ops);
  check(r.status === 200 && await bal(S.Ada) === adaBefore + N(100) && await bal(S.Chidi) === chidiBefore + N(100), 'admin refunds everyone', [await bal(S.Ada), await bal(S.Chidi)]);
  RC.close();
  RA.close();

  // ---------- a host leaving before the start calls the room off ----------
  r = await api('/cash/rooms', { entry: N(100), seats: 4, split: 'top3', map: 'neon', laps: 2 }, S.Dayo);
  const off = r.body.room.code;
  await api('/cash/rooms/join', { code: off }, S.Bola);
  const [RDo, RBo] = [racer(off, S.Dayo), racer(off, S.Bola)];
  await RDo.hello();
  await RBo.hello();
  const bolaHeld = await bal(S.Bola);
  RDo.send({ t: 'leave' });
  view = await RBo.next('room', (m) => m.cash?.status === 'refunded', 10_000);
  check(view.cash.status === 'refunded' && await bal(S.Bola) === bolaHeld + N(100), 'the host leaves: room called off, Bola refunded', view.cash);
  RBo.close();

  // ---------- identity, bank, withdrawals ----------
  r = await api('/cash/kyc', { type: 'bvn', number: '00012345678', firstName: 'Ada', lastName: 'Okafor' }, S.Ada);
  check(r.status === 422 && r.body.error === 'kyc_failed' && r.body.reason === 'not_found', 'KYC: an ID the provider doesn\'t know fails', r.body);
  r = await api('/cash/kyc', { type: 'bvn', number: '22212345678', firstName: 'Ada', middleName: 'Chioma', lastName: 'Okafor' }, S.Ada);
  c = r.body;
  check(r.status === 200 && c.checks.kyc === 'done' && c.checks.kycName === 'Ada Chioma Okafor' && c.checks.kycType === 'BVN', 'KYC: verified, with the name returned', c.checks);
  check(!JSON.stringify(c).includes('22212345678') && !JSON.stringify(await admin('list', {}, S.Ngozi_Ops)).includes('22212345678'), 'the ID number is never kept or shown');
  r = await api('/cash/bank', { bankCode: '058', accountNumber: '0009999999' }, S.Ada);
  check(r.status === 422 && r.body.error === 'bank_mismatch' && r.body.accountName === 'JOHN DOE', 'a bank account in someone else\'s name is refused', r.body);
  r = await api('/cash/bank', { bankCode: '058', accountNumber: '0001234567' }, S.Ada);
  check(r.status === 200 && r.body.checks.bank === 'done' && r.body.checks.bankLast4 === '4567' && r.body.checks.bankName === 'GTBank', '"OKAFOR ADA C" matches Ada Chioma Okafor', r.body.checks);
  check(recipients.length === 1 && recipients[0].account_number === '0001234567' && recipients[0].currency === 'NGN', 'a Paystack transfer recipient, once', recipients);
  r = await api('/cash/withdraw', { amount: N(100) }, S.Ada);
  check(r.status === 400 && r.body.error === 'min_withdrawal', 'below the minimum withdrawal', r.body);
  const adaNow = await bal(S.Ada);
  r = await api('/cash/withdraw', { amount: adaNow + N(100) }, S.Ada);
  check(r.status === 402 && r.body.error === 'short', 'more than the available balance', r.body);
  // success
  r = await api('/cash/withdraw', { amount: N(600) }, S.Ada);
  const w1 = r.body?.reference, fee1 = transferFee(N(600), 'NGN');
  check(r.status === 200 && r.body.status === 'pending' && r.body.fee === fee1 && await bal(S.Ada) === adaNow - N(600), `withdraw ₦600: sent, the balance down at once (fee ₦${fee1 / 100})`, r.body);
  check(transfers[0]?.reference === w1 && transfers[0].amount === N(600) - fee1 && transfers[0].recipient === 'RCP_1', 'Paystack /transfer: the amount less the fee, to the recipient', transfers[0]);
  transferStatus[w1] = 'success';
  await webhook({ event: 'transfer.success', data: { reference: w1 } });
  c = await until(() => cash(S.Ada), (x) => x.withdrawals.find((w) => w.reference === w1)?.status === 'paid');
  check(c.withdrawals.find((w) => w.reference === w1)?.status === 'paid', 'transfer.success: paid', c.withdrawals[0]);
  check(mails.some((m) => m.subject.includes(w1) && /sent/i.test(m.subject)), 'a withdrawal receipt is emailed', mails.slice(-1));
  // failure: Paystack refuses the transfer
  transferReply.push('refuse');
  const beforeFail = await bal(S.Ada);
  r = await api('/cash/withdraw', { amount: N(500) }, S.Ada);
  check(r.status === 200 && r.body.status === 'failed' && await bal(S.Ada) === beforeFail, 'Paystack refuses: failed, and the money is back at once', r.body);
  // reversal: sent, then reversed (twice: returned once)
  r = await api('/cash/withdraw', { amount: N(500) }, S.Ada);
  const w3 = r.body?.reference;
  check(r.status === 200 && await bal(S.Ada) === beforeFail - N(500), 'another ₦500 out', r.body);
  transferStatus[w3] = 'reversed';
  await webhook({ event: 'transfer.reversed', data: { reference: w3 } });
  await webhook({ event: 'transfer.reversed', data: { reference: w3 } });
  c = await until(() => cash(S.Ada), (x) => x.withdrawals.find((w) => w.reference === w3)?.status === 'reversed');
  check(c.withdrawals.find((w) => w.reference === w3)?.status === 'reversed' && c.balance.available === beforeFail
    && c.history.filter((x) => x.kind === 'withdrawal_reversal' && x.ref === w3).length === 1, 'transfer.reversed: back to the balance, once', c.balance);
  r = await api('/cash/withdraw', { amount: N(500) }, S.Ada);
  check(r.status === 429 && r.body.error === 'withdraw_rate', `${CFG.withdrawalsPerDay} withdrawals a day at most`, r.body);

  // ---------- a flagged withdrawal: deposit, then out without racing ----------
  r = await api('/cash/kyc', { type: 'nin', number: '33312345678', firstName: 'Chidi', middleName: 'Nnamdi', lastName: 'Eze' }, S.Chidi);
  r = await api('/cash/bank', { bankCode: '044', accountNumber: '0007654321' }, S.Chidi);
  check(r.status === 200 && r.body.checks.bank === 'done', 'Chidi\'s identity and bank checked');
  await deposit(S.Chidi, N(1000));
  const chidiNow = await bal(S.Chidi);
  r = await api('/cash/withdraw', { amount: N(1000) }, S.Chidi);
  check(r.status === 200 && r.body.status === 'review' && await bal(S.Chidi) === chidiNow - N(1000) && !transfers.some((t) => t.reference === r.body.reference),
    'deposit then straight out with no race: held for review, not sent', r.body);
  const flagged = r.body.reference;
  r = await admin('list', {}, S.Ngozi_Ops);
  check(r.body.withdrawals.some((w) => w.reference === flagged && w.flags.includes('deposit_no_play')), 'admin sees it, flagged deposit_no_play', r.body.withdrawals);
  r = await admin('act', { action: 'reject', target: flagged, note: 'Asked the player first' }, S.Ngozi_Ops);
  check(r.status === 200 && await bal(S.Chidi) === chidiNow, 'admin returns it to the balance (logged)', await bal(S.Chidi));

  // ---------- converting to tokens ----------
  const tokBefore = (await api('/wallet', undefined, S.Bola)).body.balance, cashBefore = await bal(S.Bola);
  r = await api('/cash/convert', { amount: N(100) }, S.Bola);
  const tokens = tokensFor(N(100), 'NGN');
  check(r.status === 200 && r.body.tokens === tokens && r.body.tokenBalance === tokBefore + tokens && r.body.balance.available === cashBefore - N(100),
    `convert ₦100 → ${tokens} tokens (with the bonus), in one go`, r.body);
  const wal = (await api('/wallet', undefined, S.Bola)).body;
  check(wal.history[0].reason === 'earned' && wal.history[0].delta === tokens && wal.today === 0, 'a token "earned" row, outside the daily reward cap', wal.history[0]);
  r = await api('/cash/convert', { amount: cashBefore * 2 }, S.Bola);
  check(r.status === 402 && r.body.error === 'short', 'not more than the balance', r.body);

  // ---------- the books ----------
  r = await admin('list', {}, S.Ngozi_Ops);
  check(r.body.rooms.length === 0, 'nothing left in review', r.body.rooms.map((x) => x.code));
  const fees = [[N(100), 2], [N(100), 6], [N(200), 2]].reduce((s, [e, n]) => s + prizePool(e, n, CASH_DEFAULTS.feePct).fee, 0);
  check(r.body.books.NGN.net === 0 && r.body.books.NGN.held === 0 && r.body.books.NGN.fees === fees, `the ledger balances to zero, no pots left open, ₦${fees / 100} in fees`, r.body.books);

  // ---------- off by default ----------
  const OFF = PORT + 200;
  offServer = startServer(OFF, { AUTH_SECRET: VARS.AUTH_SECRET, EMAIL_PROVIDER: 'console' });
  await ready(`http://127.0.0.1:${OFF}`, offServer);
  r = await api('/cash/config', undefined, null, {}, `http://127.0.0.1:${OFF}`);
  check(r.status === 200 && r.body.mode === 'off' && !r.body.cfg, 'without CASH_RACES: off', r.body);
  const sOff = (await api('/auth/signup', { username: 'Offy', email: 'offy@example.com' }, null, {}, `http://127.0.0.1:${OFF}`)).body.session;
  r = await api('/cash/deposit/init', { amount: N(500) }, sOff, {}, `http://127.0.0.1:${OFF}`);
  check(r.status === 404 && r.body.error === 'cash_off', 'and every cash action is refused', r.body);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    stop();
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
