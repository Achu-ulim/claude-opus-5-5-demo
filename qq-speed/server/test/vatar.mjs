// End-to-end check of Lagos Life play (server/src/vatar.js): a Vatar session becoming a Driftbolt account with no email,
// what that account can't do (log in elsewhere, change email, use Paystack), purchases claimed and credited once,
// marked delivered, refused when they aren't this player's, paid, or at our price, and the signed webhook.
// Starts its own local server (wrangler dev, empty storage) and a stand-in for Vatar's API, so nothing else needs to be
// running and nothing reaches lagoslife.app: npm run test:vatar
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REWARDS, PACKS, STARTER_PACK, packById } from '../../src/catalog.js';

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'vtr_test_local_stand_in_0123456789';
const WHSEC = 'vtr_whsec_test_local_stand_in_0123456789';
let failures = 0;
const check = (cond, what, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${!cond && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- a stand-in for Vatar's API ----------
// sessions: token → { playerId, name, mode }; purchases: id → { id, productId, playerId, amount, currency, status, … }
const sessions = {}, purchases = {}, delivers = {};
let sessionChecks = 0;
const naira = (pack) => packById(pack).price_kobo / 100;
const buy = (id, playerId, pack, extra = {}) => {
  purchases[id] = { id, productId: pack, playerId, amount: naira(pack), currency: 'NGN', status: 'paid', createdAt: Date.now() - 5000, mode: 'test', ...extra };
  return id;
};
const vatar = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { error: 'bad_secret', message: 'wrong secret' });
    if (req.method === 'POST' && req.url === '/session/verify') {
      sessionChecks++;
      const s = sessions[JSON.parse(body).session];
      if (!s) return send(401, { error: 'invalid_token', message: 'bad token' });
      return send(200, { playerId: s.playerId, name: s.name, gameId: 'g_test', exp: Date.now() + 900_000, mode: s.mode });
    }
    const m = /^\/purchases\/([^/]+)(\/deliver)?$/.exec(req.url);
    const p = m && purchases[decodeURIComponent(m[1])];
    if (!p) return send(404, { error: 'not_found', message: 'No such purchase' });
    if (req.method === 'GET' && !m[2]) return send(200, p);
    if (req.method === 'POST' && m[2]) {
      if (p.status === 'refunded') return send(409, { error: 'refunded' });
      delivers[p.id] = (delivers[p.id] || 0) + 1;
      p.status = 'delivered';
      return send(200, { id: p.id, status: 'delivered', deliveredAt: Date.now() });
    }
    send(404, { error: 'not_found' });
  });
});
await new Promise((r) => vatar.listen(0, '127.0.0.1', r));
const VATAR = `http://127.0.0.1:${vatar.address().port}`;

// ---------- the server ----------
const store = mkdtempSync(join(tmpdir(), 'driftbolt-vatar-'));
const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', store,
  '--var', 'AUTH_SECRET:test-secret-0123456789abcdef', '--var', 'EMAIL_PROVIDER:console',
  '--var', `VATAR_SECRET:${SECRET}`, '--var', `VATAR_WEBHOOK_SECRET:${WHSEC}`, '--var', `VATAR_API:${VATAR}`,
  '--var', 'PAYSTACK_SECRET_KEY:sk_test_local_unused', '--var', 'PAYSTACK_API:http://127.0.0.1:9', '--show-interactive-dev-session=false'],
{ cwd: new URL('../..', import.meta.url).pathname, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const stop = () => {
  try { server.kill('SIGTERM'); } catch { /* gone */ }
  vatar.close();
  rmSync(store, { recursive: true, force: true });
};

async function api(path, body, session, headers = {}) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(session && { authorization: `Bearer ${session}` }), ...headers },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}
const wallet = async (s) => (await api('/wallet', undefined, s)).body;
const login = async (token) => api('/vatar/session', { session: token });
const claim = (purchaseId, s) => api('/vatar/claim', { purchaseId }, s);
// a webhook as Vatar sends it: signed with the webhook secret, unless `sig` says otherwise
const webhook = (event, sig) => {
  const raw = JSON.stringify(event);
  return fetch(BASE + '/vatar/webhook', {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-vatar-event': event.type, 'x-vatar-delivery': event.id, 'x-vatar-signature': sig ?? 'sha256=' + createHmac('sha256', WHSEC).update(raw).digest('hex') },
  });
};
const paid = (purchaseId, p) => ({ id: 'evt_' + purchaseId, type: 'purchase.paid', mode: 'test', createdAt: Date.now(), data: { purchaseId, productId: p.productId, playerId: p.playerId, amount: p.amount, currency: 'NGN' } });
// the webhook is answered first and checked after: wait for its tokens
async function balanceBecomes(s, want) {
  let b;
  for (let i = 0; i < 40; i++) {
    b = (await wallet(s)).balance;
    if (b === want) break;
    await sleep(100);
  }
  return b;
}

async function main() {
  for (let i = 0; i < 120; i++) {
    const h = await fetch(`${BASE}/health`).catch(() => null);
    if (h?.ok) break;
    if (server.exitCode !== null) throw new Error('wrangler dev exited:\n' + log);
    await sleep(500);
  }
  if (!PACKS.every((p) => Number.isInteger(p.price_kobo))) throw new Error('the token packs need prices in src/catalog.js');

  // ---------- a Vatar session becomes an account ----------
  sessions.tolu = { playerId: 't_Tolu1', name: 'Tolú Adé', mode: 'test' };
  sessions.tolu2 = { playerId: 't_Tolu2', name: 'Tolú Adé', mode: 'test' };
  sessions.blank = { playerId: 't_Blank', name: '🙂', mode: 'test' };
  sessions.rude = { playerId: 't_Rude', name: 'Admin', mode: 'test' };
  sessions.live = { playerId: 'p_Live1', name: 'Kemi', mode: 'live' };
  let r = await login('vtr1.forged');
  check(r.status === 401 && r.body.error === 'vatar_session', 'a session Vatar refuses: 401', r.body);
  r = await login(42);
  check(r.status === 400 && r.body.error === 'bad_session', 'a session that isn\'t a string: 400', r.body);
  r = await login('tolu');
  const t1 = r.body;
  check(r.status === 200 && typeof t1.session === 'string' && t1.account.username === 'Test_Tolu_Ade' && t1.account.email === '' && t1.mode === 'test',
    'first visit: an account named from the display name, no email, sandbox players marked Test_', r.body);
  r = await login('tolu');
  check(r.body.account?.username === 'Test_Tolu_Ade' && r.body.account.created === t1.account.created, 'the same player again: the same account', r.body);
  r = await login('tolu2');
  check(/^Test_Tolu_Ad\d{2,4}$/.test(r.body.account?.username), 'another player with that name gets a number', r.body);
  check((await login('blank')).body.account?.username === 'Test_Racer', 'a name with no letters: Racer');
  r = await login('rude');
  check(/^Test_Racer\d*$/.test(r.body.account?.username), 'a name signup would refuse: Racer', r.body);
  check((await login('live')).body.account?.username === 'Kemi', 'live players keep their name as it is');
  const tolu = t1.session;

  // ---------- what a Lagos Life account can't do ----------
  r = await api('/auth/me', {}, tolu);
  check(r.status === 200 && r.body.account.email === '', '/auth/me works, with no email', r.body);
  r = await api('/auth/login', { username: 'Test_Tolu_Ade' });
  check(r.status === 200 && r.body.needsCode && /@/.test(r.body.maskedEmail) && !log.includes('[dev mail] to  |'), 'logging in by its name elsewhere: a stand-in, no email sent', r.body);
  r = await api('/auth/email', { email: 'tolu@example.com' }, tolu);
  check(r.status === 403 && r.body.error === 'lagoslife', 'no email can be added', r.body);
  r = await api('/pay/init', { packId: 'podium' }, tolu);
  check(r.status === 403 && r.body.error === 'lagoslife', 'no Paystack', r.body);
  const w0 = await wallet(tolu);
  check(w0.balance === REWARDS.welcome, 'the usual welcome bonus', w0);

  // ---------- purchases ----------
  const p1 = buy('3b9d0c41e7a24f8f9a10', 't_Tolu1', 'podium');
  r = await claim(p1, tolu);
  const podium = packById('podium');
  check(r.status === 200 && r.body.credited === true && r.body.tokens === podium.tokens && r.body.balance === REWARDS.welcome + podium.tokens,
    'a paid purchase: its pack\'s tokens', r.body);
  check(delivers[p1] === 1 && purchases[p1].status === 'delivered', 'then marked delivered', delivers);
  r = await claim(p1, tolu);
  check(r.status === 200 && r.body.credited === false && r.body.balance === REWARDS.welcome + podium.tokens, 'claimed again: nothing added twice', r.body);
  check(delivers[p1] === 1, 'and not delivered twice');
  let w = await wallet(tolu);
  const row = w.history.find((h) => h.ref === 'vtr:' + p1);
  check(row?.reason === 'purchase' && row.pack === 'podium' && row.amount === podium.price_kobo, 'in the history with its pack and price', row);
  check(w.bought === podium.tokens && w.starterUsed === true, 'counted as bought; the Starter Pack is for a first purchase only', w);

  // a purchase Vatar already says is delivered but this server never credited (someone marked it by hand)
  const p2 = buy('aa00000000000000000b', 't_Tolu1', 'pit-stop', { status: 'delivered' });
  r = await claim(p2, tolu);
  check(r.status === 200 && r.body.credited === true && !delivers[p2], 'delivered elsewhere but not given here: given, not re-marked', r.body);
  const after2 = r.body.balance;

  const theirs = buy('bb00000000000000000c', 't_Tolu2', 'legend');
  r = await claim(theirs, tolu);
  check(r.status === 403 && r.body.error === 'not_yours', 'someone else\'s purchase: refused', r.body);
  const cheap = buy('cc00000000000000000d', 't_Tolu1', 'legend', { amount: 100 });
  r = await claim(cheap, tolu);
  check(r.status === 409 && r.body.error === 'price_mismatch' && !delivers[cheap], 'priced differently on Vatar than here: refused, not delivered', r.body);
  const odd = buy('dd00000000000000000e', 't_Tolu1', 'pit-stop', { productId: 'double_taps' });
  r = await claim(odd, tolu);
  check(r.status === 409 && r.body.error === 'bad_product', 'a product that isn\'t a pack: refused', r.body);
  const back = buy('ee00000000000000000f', 't_Tolu1', 'champion', { status: 'refunded' });
  r = await claim(back, tolu);
  check(r.status === 409 && r.body.error === 'refunded', 'a refunded purchase: refused', r.body);
  r = await claim('ff0000000000000000ff', tolu);
  check(r.status === 404 && r.body.error === 'not_found', 'one Vatar doesn\'t know: 404', r.body);
  r = await claim('../session/verify', tolu);
  check(r.status === 400 && r.body.error === 'bad_purchase', 'a purchase id that isn\'t one: 400', r.body);
  r = await claim(p1);
  check(r.status === 401, 'claiming needs a session', r.body);
  check((await wallet(tolu)).balance === after2, 'none of those added tokens');

  // an ordinary account can't claim Lagos Life purchases
  const plain = (await api('/auth/signup', { username: 'Plain', email: 'plain@example.com' })).body.session;
  r = await claim(p1, plain);
  check(r.status === 403 && r.body.error === 'not_vatar', 'an ordinary account: refused', r.body);

  // the Starter Pack gives its parts too
  const t2 = (await login('tolu2')).body.session;
  const st = buy('ab00000000000000000a', 't_Tolu2', 'starter');
  r = await claim(st, t2);
  w = await wallet(t2);
  check(r.body.tokens === STARTER_PACK.tokens && STARTER_PACK.grants.every((g) => w.owned.includes(g)), 'the Starter Pack: its tokens and its parts', { r: r.body, owned: w.owned });

  // ---------- the webhook ----------
  const p3 = buy('ac00000000000000000b', 't_Tolu1', 'champion');
  let res = await webhook(paid(p3, purchases[p3]), 'sha256=' + '0'.repeat(64));
  check(res.status === 401, 'a webhook with a wrong signature: 401');
  res = await webhook(paid(p3, purchases[p3]), 'sha256=' + createHmac('sha256', 'another secret').update('x').digest('hex'));
  check(res.status === 401, 'signed with another secret: 401');
  check((await wallet(tolu)).balance === after2, 'neither added tokens');
  res = await webhook(paid(p3, purchases[p3]));
  check(res.status === 200, 'signed: answered 200 at once');
  const champion = packById('champion');
  check(await balanceBecomes(tolu, after2 + champion.tokens) === after2 + champion.tokens, 'then checked with Vatar and its tokens added');
  check(delivers[p3] === 1, 'and marked delivered', delivers);
  res = await webhook(paid(p3, purchases[p3]));
  await sleep(500);
  check(res.status === 200 && (await wallet(tolu)).balance === after2 + champion.tokens, 'the same event again: nothing added twice');
  r = await claim(p3, tolu);
  check(r.body.credited === false, 'and the game\'s own claim afterwards adds nothing', r.body);
  // a player who has never opened the game: left for the game to claim at their first launch
  const early = buy('ad00000000000000000c', 't_New', 'pit-stop');
  res = await webhook(paid(early, purchases[early]));
  await sleep(500);
  check(res.status === 200 && !delivers[early], 'a player with no account yet: left undelivered for the game');
  res = await webhook({ id: 'evt_test', type: 'purchase.paid', mode: 'test', data: { purchaseId: 'test_0000000000', productId: 'podium' } });
  check(res.status === 200, 'the dashboard\'s test webhook (a purchase that doesn\'t exist): 200');
  sessions.newbie = { playerId: 't_New', name: 'Newbie', mode: 'test' };
  const nb = (await login('newbie')).body.session;
  r = await claim(early, nb);
  check(r.body.credited === true && delivers[early] === 1, '…which it is, once they open it', r.body);
  check(sessionChecks > 0, `Vatar's API was asked about sessions (${sessionChecks} times)`);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    stop();
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
