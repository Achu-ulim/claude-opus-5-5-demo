// End-to-end check of player accounts (/auth) and how rooms and leagues use them.
// Starts its own local server (wrangler dev, with empty storage and emails logged instead of sent) and reads the login
// codes from its output, so nothing else needs to be running: npm run test:auth
// Takes a little over a minute: one step waits out the 60-second gap between emailed codes.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (cond, what, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${!cond && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the server ----------
const store = mkdtempSync(join(tmpdir(), 'driftbolt-auth-'));
const mails = []; // { to, code, user, subject }
const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', store,
  '--var', 'AUTH_SECRET:test-secret-0123456789abcdef', '--var', 'EMAIL_PROVIDER:console', '--show-interactive-dev-session=false'],
{ cwd: new URL('../..', import.meta.url).pathname, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const onOut = (d) => {
  log += d;
  for (const m of String(d).matchAll(/\[dev mail\] to (\S+) \| (.+?) \| (.*)/g)) {
    mails.push({ to: m[1], subject: m[2], user: /Hi (\w+)/.exec(m[3])?.[1], code: /(\d{6}) is your/.exec(m[2])?.[1] || null, text: m[3] });
  }
};
server.stdout.on('data', onOut);
server.stderr.on('data', onOut);
const stop = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } rmSync(store, { recursive: true, force: true }); };

// the newest emailed code for a username, waiting a moment for the log line
async function codeFor(user, after = 0) {
  for (let i = 0; i < 50; i++) {
    const m = mails.slice(after).reverse().find((x) => x.user === user && x.code);
    if (m) return m.code;
    await sleep(100);
  }
  return null;
}

async function api(path, body, session, headers = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session && { authorization: `Bearer ${session}` }), ...headers },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json, headers: res.headers };
}

// one connection to a room: resolves with the first welcome or error, and keeps the latest room view
function joinRoom(action, room, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?action=${action}${room ? `&room=${room}` : ''}`, { headers: { Origin: BASE } });
    const c = { ws, view: null, close: () => ws.close() };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', car: 0, ...hello }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'room') c.view = m;
      if (m.t === 'welcome') resolve(Object.assign(c, { welcome: m }));
      if (m.t === 'error') resolve(Object.assign(c, { error: m.code }));
    };
    ws.onerror = () => resolve(Object.assign(c, { error: 'socket' }));
  });
}
const viewWith = async (c, pred) => { for (let i = 0; i < 40 && !(c.view && pred(c.view)); i++) await sleep(50); return c.view; };

async function main() {
  for (let i = 0; i < 120; i++) {
    const h = await fetch(`${BASE}/health`).catch(() => null);
    if (h?.ok) break;
    if (server.exitCode !== null) throw new Error('wrangler dev exited:\n' + log);
    await sleep(500);
  }
  const tag = Math.random().toString(36).slice(2, 6);
  const NAME = `Night_${tag}`, OTHER = `Kid_${tag}`, NOBODY = `Ghost_${tag}`;
  const EMAIL = `night.${tag}@example.com`;

  // ---------- names ----------
  let r = await api('/auth/check-name', { username: NAME });
  check(r.status === 200 && r.body.available === true, 'check-name: a free name is available', r.body);
  for (const [name, reason] of [['ab', 'format'], ['has space', 'format'], ['x'.repeat(17), 'format'], ['Admin', 'not_allowed'], ['DriftboltTeam', 'not_allowed'], ['fuck_y0u', 'not_allowed'], ['BigAss', 'not_allowed']]) {
    r = await api('/auth/check-name', { username: name });
    check(r.body.available === false && r.body.reason === reason, `check-name: "${name}" is refused (${reason})`, r.body);
  }
  for (const name of ['Cassidy', 'Cockpit_Pro', 'Torpedo', 'Scunthorpe']) {
    r = await api('/auth/check-name', { username: name });
    check(r.body.available === true, `check-name: "${name}" is allowed`, r.body);
  }
  r = await api('/auth/signup', { username: 'Admin', email: EMAIL });
  check(r.status === 400 && r.body.error === 'name_not_allowed', 'signup: a reserved name is refused', r.body);
  r = await api('/auth/signup', { username: NAME, email: 'not-an-email' });
  check(r.status === 400 && r.body.error === 'bad_email', 'signup: a bad email is refused', r.body);

  // ---------- sign up, then log in again on the same device ----------
  r = await api('/auth/signup', { username: NAME, email: EMAIL });
  check(r.status === 200 && r.body.session && r.body.deviceToken, 'signup: a session and a device token', r.body);
  const device = r.body.deviceToken;
  let session = r.body.session;
  check(r.body.account?.username === NAME && r.body.account.email === 'ni•••••@example.com', 'signup: the account, with its email masked', r.body.account);
  check(!JSON.stringify(r.body).includes(EMAIL), 'signup: the full email is never sent back');
  r = await api('/auth/check-name', { username: NAME.toUpperCase() });
  check(r.body.available === false && r.body.reason === 'taken', 'check-name: taken, whatever the case', r.body);
  r = await api('/auth/signup', { username: NAME.toLowerCase(), email: 'someone@example.com' });
  check(r.status === 409 && r.body.error === 'name_taken', 'signup: a taken username is refused', r.body);

  r = await api('/auth/me', {}, session);
  check(r.status === 200 && r.body.account.username === NAME, 'me: the session works', r.body);
  const mailsBefore = mails.length;
  r = await api('/auth/login', { username: NAME.toLowerCase(), deviceToken: device });
  check(r.status === 200 && r.body.session && !r.body.needsCode, 'login on the same device: straight in, no code', r.body);
  await sleep(300);
  check(mails.length === mailsBefore, 'login on the same device: no email sent');

  // ---------- a fresh browser: a code is needed ----------
  r = await api('/auth/login', { username: NAME });
  check(r.status === 200 && r.body.needsCode === true && r.body.maskedEmail === 'ni•••••@example.com' && !r.body.session, 'login from a fresh browser: a code is required', r.body);
  const known = r.body;
  const code1 = await codeFor(NAME);
  check(/^\d{6}$/.test(code1 || ''), 'login: the code was emailed (logged by the dev server)', code1);
  r = await api('/auth/login', { username: NOBODY });
  check(r.status === 200 && r.body.needsCode === true && !r.body.session, 'login: an unknown name gets the same answer', r.body);
  check(JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(Object.keys(known).sort()) && /^[a-z]{2}•••••@[a-z.]+$/.test(r.body.maskedEmail), 'login: same fields and the same kind of masked email', r.body);
  const fake = r.body.maskedEmail;
  r = await api('/auth/login', { username: NOBODY });
  check(r.body.maskedEmail === fake, 'login: the stand-in masked email stays the same', r.body);
  check(!mails.some((m) => m.user === NOBODY), 'login: nothing is emailed for a name nobody has');

  // ---------- wrong codes lock the code ----------
  const wrong = code1 === '000000' ? '111111' : '000000';
  for (let i = 1; i <= 4; i++) {
    r = await api('/auth/verify', { username: NAME, code: wrong, remember: true });
    check(r.status === 400 && r.body.error === 'bad_code' && r.body.left === 5 - i, `verify: wrong code ${i} → ${5 - i} left`, r.body);
  }
  r = await api('/auth/verify', { username: NAME, code: wrong, remember: true });
  check(r.status === 403 && r.body.error === 'code_locked', 'verify: the 5th wrong code locks it', r.body);
  r = await api('/auth/verify', { username: NAME, code: code1, remember: true });
  check(r.status === 403 && r.body.error === 'code_locked' && !r.body.session, 'verify: even the right code no longer works', r.body);
  r = await api('/auth/verify', { username: NOBODY, code: '123456' });
  check(r.status === 400 && r.body.error === 'bad_code' && r.body.left === 4, 'verify: an unknown name counts tries the same way', r.body);
  r = await api('/auth/resend', { username: NAME });
  check(r.status === 429 && r.body.error === 'too_soon' && r.body.retryIn > 0, 'resend: not within a minute of the last code', r.body);
  const lockedAt = Date.now();

  // ---------- another account: code, remember this device ----------
  r = await api('/auth/signup', { username: OTHER, email: `kid.${tag}@example.com` });
  check(r.status === 200, 'signup: a second account', r.body);
  r = await api('/auth/login', { username: OTHER });
  const code2 = await codeFor(OTHER);
  r = await api('/auth/verify', { username: OTHER, code: code2, remember: false });
  check(r.status === 200 && r.body.session && !r.body.deviceToken, 'verify: the right code logs in; not remembered, no device token', r.body);
  r = await api('/auth/verify', { username: OTHER, code: code2 });
  check(r.status === 410 && r.body.error === 'code_expired', 'verify: a code works once', r.body);
  r = await api('/auth/login', { username: OTHER, deviceToken: device });
  check(r.body.needsCode === true, "login: another account's device token doesn't work", r.body);

  // ---------- sessions ----------
  const forged = session.replace(/\.[^.]+$/, '.' + 'A'.repeat(43));
  r = await api('/auth/me', {}, forged);
  check(r.status === 401 && r.body.error === 'session', 'me: a forged signature is refused', r.body);
  r = await api('/auth/login', { username: NAME, deviceToken: device });
  const second = r.body.session;
  r = await api('/auth/logout', {}, session);
  check(r.status === 200, 'logout', r.body);
  r = await api('/auth/me', {}, session);
  check(r.status === 401, 'logout: that session no longer works', r.body);
  r = await api('/auth/me', {}, second);
  check(r.status === 200, "logout: the account's other sessions still work", r.body);
  session = second;

  // ---------- change email ----------
  const NEW_EMAIL = `fresh.${tag}@example.org`;
  r = await api('/auth/email', { email: NEW_EMAIL }, session);
  check(r.status === 200 && r.body.needsCode && r.body.maskedEmail === 'fr•••••@example.org', 'change email: a code goes to the new address', r.body);
  const mailsAt = mails.length;
  const code3 = await codeFor(NAME);
  check(mails.some((m) => m.to === 'fr•••••@example.org' && m.code === code3), 'change email: the code was sent to the new address');
  r = await api('/auth/email/verify', { code: '999999' === code3 ? '888888' : '999999' }, session);
  check(r.status === 400 && r.body.error === 'bad_code', 'change email: a wrong code is refused', r.body);
  r = await api('/auth/email/verify', { code: code3 }, session);
  check(r.status === 200 && r.body.account.email === 'fr•••••@example.org', 'change email: confirmed', r.body);
  await sleep(300);
  check(mails.slice(mailsAt).some((m) => m.to === 'ni•••••@example.com' && /changed/.test(m.subject)), 'change email: the old address is told');

  // ---------- rooms: the account's name, and guests can't take it ----------
  const host = await joinRoom('create', null, { name: 'Somebody Else', session });
  check(!host.error, 'room: an account holder opens a room', host.error);
  let v = await viewWith(host, (x) => x.players.length === 1);
  check(v?.players[0].name === NAME && v.players[0].acct === true, "room: they race under their account's name, marked as an account", v?.players);
  const guest = await joinRoom('join', host.welcome.code, { name: NAME.toLowerCase() });
  v = await viewWith(host, (x) => x.players.length === 2);
  const g = v?.players.find((p) => p.id === guest.welcome?.id);
  check(g && g.name === `Guest ${NAME.toLowerCase()}`.slice(0, 16) && !g.acct, 'room: a guest using a registered name shows as a guest', g);
  guest.ws.send(JSON.stringify({ t: 'set', name: OTHER }));
  v = await viewWith(host, (x) => x.players.some((p) => p.id === guest.welcome.id && p.name !== g.name));
  check(v?.players.find((p) => p.id === guest.welcome.id)?.name === `Guest ${OTHER}`.slice(0, 16), 'room: renaming to a registered name is caught too', v?.players);
  host.ws.send(JSON.stringify({ t: 'set', name: 'Renamed' }));
  await sleep(300);
  check(host.view.players.find((p) => p.id === host.welcome.id)?.name === NAME, "room: an account holder's name can't be changed in the room", host.view.players);
  const bad = await joinRoom('join', host.welcome.code, { name: 'X', session: forged });
  check(bad.error === 'session', 'room: an invalid session is turned away', bad.error);
  const plain = await joinRoom('join', host.welcome.code, { name: 'Just_Visiting' });
  v = await viewWith(host, (x) => x.players.length === 3);
  check(v?.players.some((p) => p.name === 'Just_Visiting'), 'room: guests with free names play as before', v?.players);
  for (const c of [host, guest, bad, plain]) c.close();

  // ---------- leagues ----------
  const lg = { name: 'Acct Cup', format: 'arcade', rounds: 4, laps: 1, maxPlayers: 4, night: { day: 5, time: '20:00' }, aiFill: true, oneDriverPerTeam: false, private: true, ghost: false };
  r = await api('/league/create', { ...lg, session, player: { name: 'Pretender', car: 0 } });
  check(r.status === 200 && r.body.league.members[0].name === NAME, "league: created under the account's name", r.body.league?.members);
  const lcode = r.body.code;
  r = await api('/league/join', { code: lcode, name: OTHER, car: 1 });
  check(r.status === 409 && r.body.error === 'name_registered', 'league: a guest using a registered name is refused', r.body);
  r = await api('/league/join', { code: lcode, name: 'Guest_Gil', car: 1 });
  check(r.status === 200, 'league: a guest with a free name joins as before', r.body);
  r = await api('/league/join', { code: lcode, name: 'x', car: 1, session: forged });
  check(r.status === 401 && r.body.error === 'session', 'league: an invalid session is refused', r.body);

  // ---------- log out of every device ----------
  r = await api('/auth/logout-all', {}, session);
  check(r.status === 200, 'logout-all', r.body);
  r = await api('/auth/me', {}, session);
  check(r.status === 401, 'logout-all: sessions end', r.body);
  r = await api('/auth/login', { username: NAME, deviceToken: device });
  check(r.body.needsCode === true, 'logout-all: the device needs a code again', r.body);

  // ---------- after a minute: a new code replaces the locked one ----------
  const wait = 61_000 - (Date.now() - lockedAt);
  if (wait > 0) { console.log(`…  waiting ${Math.ceil(wait / 1000)} s for the resend gap`); await sleep(wait); }
  const before = mails.length;
  r = await api('/auth/resend', { username: NAME });
  check(r.status === 200 && r.body.needsCode && r.body.resendIn === 60, 'resend: a new code after a minute', r.body);
  const code4 = await codeFor(NAME, before);
  r = await api('/auth/verify', { username: NAME, code: code4, remember: true });
  check(r.status === 200 && r.body.session && r.body.deviceToken, 'verify: the new code works and the device is remembered', r.body);
  r = await api('/auth/login', { username: NAME, deviceToken: r.body.deviceToken });
  check(r.status === 200 && r.body.session, 'login: the remembered device is straight in', r.body);

  // ---------- rate limits ----------
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) { r = await api('/auth/login', { username: OTHER }); if (r.status === 429) limited = r.body; }
  check(limited?.error === 'slow_down' && limited.retryIn > 0, 'login: too many tries for one name are slowed down', limited);
  r = await api('/auth/check-name', { username: NAME }, null, { Origin: 'https://evil.example' });
  check(r.status === 403, 'a page not on ALLOWED_ORIGINS is refused', r.status);
  r = await fetch(`${BASE}/auth/login`, { method: 'OPTIONS', headers: { Origin: 'https://driftbolt.netlify.app', 'Access-Control-Request-Method': 'POST' } });
  check(r.status === 204 && r.headers.get('access-control-allow-origin') === 'https://driftbolt.netlify.app', 'the Netlify copy gets CORS headers');
  const leak = /[^\s|•]+@example\.(com|org)/.exec(log);
  check(!leak, 'no full email address appears in the server log', leak && log.slice(Math.max(0, leak.index - 300), leak.index + 100));
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    stop();
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
