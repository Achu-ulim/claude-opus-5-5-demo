// End-to-end check of the token wallet (server/src/wallet.js): the ledger and welcome bonus, unlocks, looks, rewards and
// their daily cap, a guest garage moving in, Paystack purchases, invite rewards and league wins.
// Starts its own local server (wrangler dev, empty storage, emails logged) and a stand-in for Paystack's API, so nothing
// else needs to be running: npm run test:wallet
// Payments need packs with prices in src/catalog.js; without any, those checks are skipped. Four races are driven for
// real over WebSockets, so it takes about three minutes.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACK_LEN, MAX_SPEED } from '../../src/netproto.js';
import { REWARDS, DAILY_EARN_CAP, MOVE_CAP, PACKS, STARTER_PACK, item } from '../../src/catalog.js';

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'sk_test_local_stand_in_0123456789';
let failures = 0;
const check = (cond, what, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${!cond && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// ---------- a stand-in for Paystack's API ----------
// initialize hands out an access code; verify answers what a test set in `verdicts` (default: success, as initialized)
const inits = [], verdicts = {}, verifies = {};
const paystack = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { status: false, message: 'Invalid key' });
    if (req.method === 'POST' && req.url === '/transaction/initialize') {
      const b = JSON.parse(body);
      inits.push(b);
      return send(200, { status: true, data: { authorization_url: 'https://checkout.example/x', access_code: 'ac_' + b.reference, reference: b.reference } });
    }
    const m = /^\/transaction\/verify\/(.+)$/.exec(req.url);
    const init = m && inits.find((i) => i.reference === decodeURIComponent(m[1]));
    if (req.method === 'GET' && init) {
      verifies[init.reference] = (verifies[init.reference] || 0) + 1;
      const v = verdicts[init.reference] || {};
      return send(200, { status: true, data: { status: v.status || 'success', reference: init.reference, amount: v.amount ?? Number(init.amount), currency: v.currency || init.currency } });
    }
    send(404, { status: false, message: 'Not found' });
  });
});
await new Promise((r) => paystack.listen(0, '127.0.0.1', r));
const PAYSTACK = `http://127.0.0.1:${paystack.address().port}`;

// ---------- the server ----------
const store = mkdtempSync(join(tmpdir(), 'driftbolt-wallet-'));
const mails = [];
const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', store,
  '--var', 'AUTH_SECRET:test-secret-0123456789abcdef', '--var', 'EMAIL_PROVIDER:console',
  '--var', `PAYSTACK_SECRET_KEY:${SECRET}`, '--var', `PAYSTACK_API:${PAYSTACK}`, '--show-interactive-dev-session=false'],
{ cwd: new URL('../..', import.meta.url).pathname, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const onOut = (d) => {
  log += d;
  for (const m of String(d).matchAll(/\[dev mail\] to (\S+) \| (.+?) \| (.*)/g)) mails.push({ to: m[1], subject: m[2], text: m[3] });
};
server.stdout.on('data', onOut);
server.stderr.on('data', onOut);
const stop = () => {
  try { server.kill('SIGTERM'); } catch { /* gone */ }
  paystack.close();
  rmSync(store, { recursive: true, force: true });
};

async function api(path, body, session, headers = {}) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(session && { authorization: `Bearer ${session}` }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json, headers: res.headers };
}
const wallet = async (s) => (await api('/wallet', undefined, s)).body;
const signup = async (username, invite) => (await api('/auth/signup', { username, email: `${username.toLowerCase()}@example.com`, ...(invite && { invite }) })).body;
// a webhook as Paystack sends it: signed with the secret key, unless `sig` says otherwise
const webhook = (event, sig) => {
  const raw = JSON.stringify(event);
  return fetch(BASE + '/paystack/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': sig ?? createHmac('sha512', SECRET).update(raw).digest('hex') }, body: raw });
};
const charge = (reference) => ({ event: 'charge.success', data: { reference, status: 'success' } });
// the server checks Paystack after answering the webhook: wait for it to settle
async function statusOf(ref, session, want) {
  let r;
  for (let i = 0; i < 40; i++) {
    r = await api('/pay/status/' + ref, undefined, session);
    if (!want || r.body?.status === want) break;
    await sleep(100);
  }
  return r.body;
}

// one player's connection to a room, as in league.mjs: messages queue up until a step waits for one
function racer(room, action = 'join') {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?action=${action}${room ? `&room=${room}` : ''}`, { headers: { Origin: BASE } });
  const inbox = [], waiting = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const i = waiting.findIndex((w) => w.t === m.t && w.pred(m));
    if (i >= 0) waiting.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  };
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not connect to the room')); });
  return {
    send: (m) => ws.send(JSON.stringify(m)),
    next(t, pred = () => true, ms = 20_000) {
      const i = inbox.findIndex((m) => m.t === t && pred(m));
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { t, pred, resolve };
        waiting.push(w);
        setTimeout(() => { if (waiting.includes(w)) reject(new Error(`no '${t}' message within ${ms} ms`)); }, ms);
      });
    },
    async hello(m) { await opened; this.send({ t: 'hello', car: 0, ...m }); return this.next('welcome'); },
    close: () => ws.close(),
  };
}

// a race both racers finish (A first), as fast as the server believes a lap can be driven
async function race(A, B, label) {
  A.send({ t: 'set', ready: true });
  B.send({ t: 'set', ready: true });
  await sleep(300);
  A.send({ t: 'start' });
  const load = await A.next('load');
  await B.next('load');
  A.send({ t: 'loaded', seq: load.seq });
  B.send({ t: 'loaded', seq: load.seq });
  const go = await A.next('go');
  const minLap = TRACK_LEN[load.cfg.map] / MAX_SPEED;
  const laps = load.cfg.laps;
  console.log(`      ${label}: ${laps} lap${laps > 1 ? 's' : ''} on ${load.cfg.map}, ${(go.startAt - Date.now() + (minLap * laps + 1.6) * 1000) / 1000 | 0} s…`);
  await sleep(go.startAt + (minLap * laps + 1.6) * 1000 - Date.now());
  for (let l = 1; l <= laps; l++) {
    A.send({ t: 'lap', seq: load.seq, lap: l, time: minLap * l + 0.5 });
    B.send({ t: 'lap', seq: load.seq, lap: l, time: minLap * l + 0.9 });
  }
  await A.next('lap', (m) => m.finished && m.place === 2);
  A.send({ t: 'ev', k: 'celeb', kind: 'donuts' });
  return A.next('results');
}

async function main() {
  for (let i = 0; i < 120; i++) {
    const h = await fetch(`${BASE}/health`).catch(() => null);
    if (h?.ok) break;
    if (server.exitCode !== null) throw new Error('wrangler dev exited:\n' + log);
    await sleep(500);
  }

  // ---------- accounts, the welcome bonus ----------
  const a = await signup('Alice'), b = await signup('Bobby', 'alice'), c = await signup('Cara');
  const alice = a.session, bob = b.session, cara = c.session;
  check(alice && bob && cara, 'three accounts, Bobby invited by Alice', [a, b, c]);
  let r = await api('/wallet');
  check(r.status === 401 && r.body.error === 'session', 'GET /wallet needs a session', r.body);
  r = await api('/wallet', undefined, 'x'.repeat(40));
  check(r.status === 401, 'a made-up session is refused', r.status);
  r = await api('/wallet', undefined, null, { Origin: 'https://evil.example' });
  check(r.status === 403, 'a page not on ALLOWED_ORIGINS is refused', r.status);
  let w = await wallet(alice);
  check(w.balance === REWARDS.welcome && w.earned === REWARDS.welcome && w.bought === 0, `the welcome bonus: ${REWARDS.welcome}`, w);
  check(w.history.length === 1 && w.history[0].reason === 'welcome', 'history: one welcome row', w.history);
  w = await wallet(alice);
  check(w.balance === REWARDS.welcome && w.history.length === 1, 'the welcome bonus comes once', w.balance);

  // ---------- rewards and the daily cap ----------
  r = await api('/wallet/earn', { kind: 'challenge', proof: { day: today(), tier: 'hard' } }, alice);
  check(r.status === 200 && r.body.amount === REWARDS.challenge.hard && r.body.balance === REWARDS.welcome + REWARDS.challenge.hard, 'earn: today\'s hard challenge', r.body);
  r = await api('/wallet/earn', { kind: 'challenge', proof: { day: today(), tier: 'hard' } }, alice);
  check(r.status === 409 && r.body.error === 'claimed', 'earn: the same challenge twice is refused', r.body);
  r = await api('/wallet/earn', { kind: 'challenge', proof: { day: daysAgo(5), tier: 'easy' } }, alice);
  check(r.status === 400 && r.body.error === 'too_old', 'earn: a challenge from days ago is refused', r.body);
  r = await api('/wallet/earn', { kind: 'challenge', proof: { day: today(), tier: '__proto__' } }, alice);
  check(r.status === 400 && r.body.error === 'bad_proof', 'earn: a made-up tier is refused', r.body);
  r = await api('/wallet/earn', { kind: 'lottery', proof: {} }, alice);
  check(r.status === 400 && r.body.error === 'bad_kind', 'earn: an unknown kind is refused', r.body);
  r = await api('/wallet/earn', { kind: 'cup', proof: { cup: 'legend', run: 'run0000001' } }, alice);
  check(r.status === 200 && r.body.amount === REWARDS.cup.legend, 'earn: a Legend Cup win', r.body);
  r = await api('/wallet/earn', { kind: 'cup', proof: { cup: 'legend', run: 'run0000001' } }, alice);
  check(r.status === 409, 'earn: the same cup run twice is refused', r.body);
  const sofar = REWARDS.challenge.hard + REWARDS.cup.legend;
  r = await api('/wallet/earn', { kind: 'f1', proof: { run: 'season0001' } }, alice);
  check(sofar + REWARDS.f1 > DAILY_EARN_CAP ? r.status === 429 && r.body.error === 'cap' && r.body.left === DAILY_EARN_CAP - sofar : r.status === 200,
    `earn: an F1 title over the ${DAILY_EARN_CAP} cap waits for tomorrow`, r.body);
  r = await api('/wallet/earn', { kind: 'streak', proof: { day: today() } }, alice);
  check(r.status === 200 && r.body.amount === REWARDS.streak, 'earn: a 7-day streak', r.body);
  r = await api('/wallet/earn', { kind: 'streak', proof: { day: daysAgo(1) } }, alice);
  check(r.status === 409, 'earn: one streak bonus a week', r.body);
  w = await wallet(alice);
  const earned = REWARDS.welcome + REWARDS.challenge.hard + REWARDS.cup.legend + REWARDS.streak;
  check(w.balance === earned && w.earned === earned && w.today === earned - REWARDS.welcome, 'balance, earned and today add up', w);

  // ---------- unlocks ----------
  r = await api('/wallet/unlock', { itemId: 'car.koenigsegg' }, alice);
  check(r.status === 402 && r.body.error === 'short' && r.body.need === item('car.koenigsegg').price - earned, 'unlock: not enough tokens says how many more', r.body);
  r = await api('/wallet/unlock', { itemId: 'paint.matte-black' }, alice);
  const afterMatte = earned - item('paint.matte-black').price;
  check(r.status === 200 && r.body.balance === afterMatte && r.body.owned.includes('paint.matte-black'), 'unlock: Matte Black for its catalog price', r.body);
  r = await api('/wallet/unlock', { itemId: 'paint.matte-black', price: 1 }, alice);
  check(r.status === 200 && r.body.balance === afterMatte, 'unlock again: nothing more is spent (and a price sent along is ignored)', r.body);
  r = await api('/wallet/unlock', { itemId: 'paint.nope' }, alice);
  check(r.status === 400 && r.body.error === 'bad_item', 'unlock: an unknown item is refused', r.body);
  w = await wallet(alice);
  check(w.history.filter((h) => h.reason === 'unlock').length === 1 && w.history[0].ref === 'unlock:paint.matte-black', 'history: one unlock row', w.history.slice(0, 2));

  // ---------- looks ----------
  r = await api('/wallet/equip', { carId: 'ferrari', look: { paint: 'paint.matte-black', glow: 'glow.cyan', wheels: 'wheels.factory' } }, alice);
  check(r.status === 200 && JSON.stringify(r.body.look) === '{"paint":"paint.matte-black","glow":"glow.cyan"}', 'equip: owned and free parts', r.body);
  r = await api('/wallet/equip', { carId: 'ferrari', look: { paint: 'paint.chrome' } }, alice);
  check(r.status === 403 && r.body.error === 'not_owned' && r.body.item === 'paint.chrome', 'equip: a part not owned is refused', r.body);
  r = await api('/wallet/equip', { carId: 'bugatti', look: {} }, alice);
  check(r.status === 403 && r.body.item === 'car.bugatti', 'equip: a car not owned is refused', r.body);
  r = await api('/wallet/equip', { carId: 'ferrari', look: { paint: 'paint.unicorn' } }, alice);
  check(r.status === 400 && r.body.error === 'bad_look', 'equip: a part the catalog doesn\'t have is refused', r.body);
  w = await wallet(alice);
  check(JSON.stringify(w.looks) === '{"ferrari":{"paint":"paint.matte-black","glow":"glow.cyan"}}', 'GET /wallet: the look', w.looks);

  // ---------- earned on the device ----------
  r = await api('/wallet/claim', { items: ['paint.chrome', 'paint.midnight-pearl', 'car.pagani'] }, alice);
  check(r.status === 200 && r.body.owned.includes('paint.chrome') && r.body.owned.includes('car.pagani') && !r.body.owned.includes('paint.midnight-pearl'),
    'claim: only things that can be earned (Chrome, Pagani), not Midnight Pearl', r.body);

  // ---------- a guest garage moving in ----------
  const guest = ['car.bugatti', 'paint.midnight-pearl', 'kit.gt-wing', 'glow.rainbow', 'paint.nope'];
  r = await api('/wallet/move', { items: guest, looks: { ferrari: { paint: 'paint.midnight-pearl', bodykit: 'kit.gt-wing', glow: 'glow.rainbow' }, gt: { paint: 'paint.chrome' }, nope: {} }, balance: 99999 }, bob);
  const moved = r.body?.moved || [];
  const worth = moved.reduce((s, id) => s + item(id).price, 0);
  check(r.status === 200 && worth <= MOVE_CAP && moved.includes('paint.midnight-pearl') && moved.includes('kit.gt-wing') && !moved.includes('car.bugatti'),
    `move: items up to ${MOVE_CAP} tokens' worth`, r.body);
  w = await wallet(bob);
  check(w.balance === REWARDS.welcome, 'move: a guest balance never comes along (only the welcome bonus)', w.balance);
  check(JSON.stringify(w.looks.ferrari) === '{"paint":"paint.midnight-pearl","bodykit":"kit.gt-wing"}' && !w.looks.gt, 'move: looks keep only parts that came along', w.looks);
  r = await api('/wallet/move', { items: ['glow.pink'] }, bob);
  check(r.status === 409 && r.body.error === 'moved', 'move: once per account', r.body);

  // ---------- payments ----------
  const priced = PACKS.filter((p) => Number.isInteger(p.price_kobo) && p.price_kobo > 0);
  const starterPriced = Number.isInteger(STARTER_PACK.price_kobo) && STARTER_PACK.price_kobo > 0;
  let slow = [];
  r = await api('/pay/init', { packId: PACKS[0].id });
  check(r.status === 401, 'pay/init needs a session', r.status);
  r = await api('/pay/init', { packId: 'free-money' }, alice);
  check(r.status === 400 && r.body.error === 'bad_pack', 'pay/init: an unknown pack is refused', r.body);
  if (priced.length < 2 || !starterPriced) {
    console.log(`skip  payments: give the starter pack and at least two packs a price_kobo in src/catalog.js to test them`);
    r = await api('/pay/init', { packId: PACKS[0].id }, alice);
    check(priced.includes(PACKS[0]) || (r.status === 409 && r.body.error === 'not_for_sale'), 'pay/init: a pack without a price isn\'t for sale', r.body);
  } else {
    const [pack, cheap] = [...priced].sort((x, y) => y.price_kobo - x.price_kobo);
    r = await api('/pay/init', { packId: pack.id }, alice, { Origin: 'https://driftbolt.netlify.app' });
    const ref = r.body?.reference;
    const init = inits.find((i) => i.reference === ref);
    check(r.status === 200 && /^DB-[A-Z0-9]{4}-\d{4}$/.test(ref) && r.body.access_code === 'ac_' + ref, 'pay/init: our reference and Paystack\'s access code', r.body);
    check(init && init.email === 'alice@example.com' && Number(init.amount) === pack.price_kobo && init.currency === 'NGN' && init.metadata?.packId === pack.id
      && init.callback_url === `https://driftbolt.netlify.app/?pay=${ref}`, 'pay/init: Paystack gets the account email, the catalog price in kobo, NGN and our reference', init);
    check((await statusOf(ref, alice)).status === 'pending', 'pay/status: pending at first');
    r = await api('/pay/status/' + ref, undefined, bob);
    check(r.status === 404, 'pay/status: someone else\'s payment is not found', r.status);

    let h = await webhook(charge(ref), 'ab'.repeat(64));
    check(h.status === 401, 'webhook: a bad signature gets 401', h.status);
    h = await webhook(charge(ref), '');
    check(h.status === 401, 'webhook: no signature gets 401', h.status);
    check((await wallet(alice)).balance === afterMatte, 'webhook: nothing credited without a good signature');
    h = await webhook({ event: 'subscription.create', data: {} });
    check(h.status === 200, 'webhook: a signed but unknown event is answered 200 and ignored', h.status);

    h = await webhook(charge(ref));
    check(h.status === 200, 'webhook: charge.success answered 200', h.status);
    let st = await statusOf(ref, alice, 'paid');
    check(st.status === 'paid' && st.balance === afterMatte + pack.tokens && verifies[ref] === 1, `paid after Paystack's verify: +${pack.tokens}`, { st, verifies: verifies[ref] });
    h = await webhook(charge(ref));
    await sleep(500);
    w = await wallet(alice);
    check(h.status === 200 && w.balance === afterMatte + pack.tokens && w.history.filter((x) => x.reason === 'purchase').length === 1, 'a duplicate webhook credits once', { balance: w.balance });
    check(w.bought === pack.tokens && w.history[0].pack === pack.id && w.history[0].amount === pack.price_kobo, 'history: the purchase with its pack and price', w.history[0]);
    check(mails.some((m) => /receipt/i.test(m.subject) && m.subject.includes(ref) && m.text.includes(pack.name)), 'a receipt is emailed', mails.slice(-2));

    // Paystack says success, but not for what we asked
    r = await api('/pay/init', { packId: cheap.id }, alice);
    const ref2 = r.body.reference;
    verdicts[ref2] = { amount: cheap.price_kobo - 100 };
    await webhook(charge(ref2));
    st = await statusOf(ref2, alice, 'failed');
    check(st.status === 'failed' && st.balance === afterMatte + pack.tokens, 'an amount mismatch is not credited', st);
    r = await api('/pay/init', { packId: cheap.id }, alice);
    const ref3 = r.body.reference;
    verdicts[ref3] = { currency: 'USD' };
    await webhook(charge(ref3));
    st = await statusOf(ref3, alice, 'failed');
    check(st.status === 'failed' && st.balance === afterMatte + pack.tokens, 'a currency mismatch is not credited', st);

    // the starter pack: only before a first purchase; it brings Gold Leaf
    r = await api('/pay/init', { packId: 'starter' }, alice);
    check(r.status === 409 && r.body.error === 'starter_used', 'starter pack: refused once an account has paid', r.body);
    r = await api('/pay/init', { packId: 'starter' }, bob);
    const sref = r.body?.reference;
    await webhook(charge(sref));
    st = await statusOf(sref, bob, 'paid');
    w = await wallet(bob);
    check(st.status === 'paid' && w.balance === REWARDS.welcome + STARTER_PACK.tokens && w.owned.includes('paint.gold-leaf') && w.starterUsed,
      'starter pack: tokens and Gold Leaf', { balance: w.balance, owned: w.owned });

    // a declined card and a closed popup send no charge.success: the status check catches up once two minutes have passed
    r = await api('/pay/init', { packId: cheap.id }, cara);
    const declined = r.body.reference;
    verdicts[declined] = { status: 'failed' };
    r = await api('/pay/init', { packId: cheap.id }, cara);
    const closed = r.body.reference;
    verdicts[closed] = { status: 'abandoned' };
    slow = [declined, closed, Date.now()];
    check((await statusOf(declined, cara)).status === 'pending' && !verifies[declined], 'a declined card: still pending (not checked) at first');
  }

  // ---------- invites: Bobby's third online race pays both ----------
  const A = racer(null, 'create');
  const wa = await A.hello({ name: 'x', session: alice });
  A.send({ t: 'cfg', map: 'bay', laps: 1 });
  const B = racer(wa.code);
  await B.hello({ name: 'y', session: bob });
  await A.next('room', (m) => m.players.length === 2);
  const bobBefore = (await wallet(bob)).balance, aliceBefore = (await wallet(alice)).balance;
  for (let n = 1; n <= 3; n++) {
    await race(A, B, `invite race ${n}`);
    await sleep(500);
    const wb = await wallet(bob), wl = await wallet(alice);
    if (n < 3) check(wb.balance === bobBefore && wb.invited?.races === n, `after race ${n}: no invite reward yet (${n} of 3)`, wb.invited);
    else {
      check(wb.balance === bobBefore + REWARDS.invite && wb.invited?.done, `after race 3: Bobby gets ${REWARDS.invite}`, wb.invited);
      check(wl.balance === aliceBefore + REWARDS.invite && wl.friends.rewarded === 1, `after race 3: Alice gets ${REWARDS.invite}`, wl.friends);
    }
  }
  await race(A, B, 'a fourth race');
  await sleep(500);
  check((await wallet(bob)).balance === bobBefore + REWARDS.invite, 'the invite reward comes once');
  A.close();
  B.close();

  // ---------- a league race win, granted by the League ----------
  const night = { day: 5, time: '20:00' };
  r = await api('/league/create', { name: 'Wallet Cup', format: 'arcade', rounds: 4, laps: 1, maxPlayers: 4, night, aiFill: false, oneDriverPerTeam: false, private: true, ghost: false, player: { name: 'x', car: 0 }, session: cara });
  const lcode = r.body?.code, caraTok = r.body?.member?.token;
  r = await api('/league/join', { code: lcode, name: 'y', car: 1, session: alice });
  const aliceTok = r.body?.member?.token;
  check(lcode && caraTok && aliceTok, 'a league with Cara and Alice', r.body);
  r = await api('/league/open', { code: lcode }, caraTok);
  const room = r.body?.race?.room, caraTicket = r.body?.race?.ticket;
  const aliceTicket = (await api('/league?code=' + lcode, undefined, aliceTok)).body?.race?.ticket;
  const caraBefore = (await wallet(cara)).balance;
  const C = racer(room), L2 = racer(room);
  await C.hello({ ticket: caraTicket });
  await L2.hello({ ticket: aliceTicket });
  await C.next('room', (m) => m.players.length === 2);
  await race(C, L2, 'league race');
  C.close();
  L2.close();
  let wc;
  for (let i = 0; i < 30; i++) {
    wc = await wallet(cara);
    if (wc.balance !== caraBefore) break;
    await sleep(250);
  }
  check(wc.balance === caraBefore + REWARDS.leagueWin && wc.history[0].reason === 'league' && wc.history[0].ref.startsWith(`league:${lcode}:`), `the league winner gets ${REWARDS.leagueWin}, no claim needed`, wc.history[0]);

  // ---------- the slow payments, two minutes on ----------
  if (slow.length) {
    const [declined, closed, at] = slow;
    const wait = at + 2 * 60_000 + 1500 - Date.now();
    if (wait > 0) { console.log(`      waiting ${Math.ceil(wait / 1000)} s for the pending payments to be two minutes old…`); await sleep(wait); }
    let st = await statusOf(declined, cara);
    check(st.status === 'failed' && verifies[declined] === 1, 'a declined card: failed once checked with Paystack', { st, verifies: verifies[declined] });
    st = await statusOf(closed, cara);
    check(st.status === 'abandoned', 'a closed popup: abandoned', st);
    st = await statusOf(declined, cara);
    check(verifies[declined] === 1, 'a settled payment isn\'t checked again', verifies[declined]);
    check((await wallet(cara)).balance === wc.balance, 'neither added tokens');
  }
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    stop();
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
