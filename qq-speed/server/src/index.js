// Driftbolt multiplayer server (Cloudflare Workers + Durable Objects). The same Worker serves the game's files (wrangler.jsonc).
// The Worker only routes: each room is one Durable Object that owns its lobby, start clock and results,
// a single Matchmaker object keeps the list of public rooms for Quick Match, and each league (a season on a weekly
// race night) is one League object that opens a room in league mode when it's time to race.
// Cars are simulated by their own clients; the room relays their snapshots and referees laps and the finishing order.
// Player accounts (/auth) live in one Accounts object (accounts.js); rooms and leagues ask it who a session belongs to.
// One Presence object counts the open games, for the lobby's "players online".
import { DurableObject } from 'cloudflare:workers';
import {
  MAX_PLAYERS, CODE_LEN, CODE_CHARS, RACE_MAPS, RACE_MODES, LAP_OPTIONS, CAR_COUNT, FINISH_GRACE, COUNTDOWN,
  TRACK_LEN, MAX_SPEED, CAR_EVENTS, CELEBRATIONS, validSnap, cleanName, cleanLook, normCode,
  LEAGUE_CODE_LEN, LEAGUE_NAME_LEN, LEAGUE_FORMATS, LEAGUE_CHAT, LEAGUE_LOBBY_OPEN as LOBBY_OPEN, normLeagueCode, USERNAME_RE,
} from '../../src/netproto.js';
import { GPS, TEAMS } from '../../src/f1.js';
import { mailReady, sendMail } from './mail.js';

export { Accounts } from './accounts.js';

const LOBBY_GRACE = 10_000; // ms a dropped player keeps their seat in the lobby (page reload, flaky wifi)
const RACE_GRACE = 30_000; // ms a dropped racer stays in the race before counting as a DNF
const LOAD_TIMEOUT = 25_000; // ms to generate the track before the race starts without the stragglers
const START_PAD = 700; // ms between "everyone loaded" and the countdown, so the go message lands everywhere first
const AUTO_START = 5_000; // public rooms start by themselves this long after everyone is ready
const EMPTY_TTL = 60_000; // ms an empty room is kept before its storage is wiped
const MAX_MSG = 2048;
const RATE = 40, BURST = 80; // messages per second per socket
const EVENTS = new Set(CAR_EVENTS);
// once everyone is in, the race waits this long for the winner to start celebrating (their game offers the choice
// 1.2 s after the line and for 12 s at most), so the others' games hear about it and can show it before the results
const CELEB_WAIT = 16_000;
// league race nights (the Room side)
const LATE_WAIT = 60_000; // nobody was there at the start time: the first to arrive waits this long for the others
const NO_SHOW = 10 * 60_000; // still nobody this long after the start time: the night is called off
const REPORT_RETRY = 30_000; // ms between tries to tell the League how its race went
const REJECT = { not_found: 4001, full: 4002, taken: 4003, kicked: 4004, not_member: 4006, session: 4007 }; // 4005: replaced by a newer connection

// F1 Grands Prix race on 'f1-<gp>' maps, whose laps are at least the GP's target length
const F1_LEN = Object.fromEntries(GPS.map((g) => ['f1-' + g.id, g.len]));
const trackLen = (map) => TRACK_LEN[map] || F1_LEN[map] || 0;
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const rid = (n) => {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
};
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(CODE_LEN)), (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
const carIdx = (v) => (Number.isInteger(v) && v >= 0 && v < CAR_COUNT ? v : 0);

// "https://*--driftbolt.netlify.app,http://localhost:*" style allowlist; * stands for one host label or a port
function originOk(origin, list) {
  if (!list || list.trim() === '*') return true;
  if (!origin) return false;
  return list.split(',').some((pat) => {
    const re = pat.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+');
    return re && new RegExp(`^${re}$`, 'i').test(origin);
  });
}

const matchmaker = (env) => env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global'));
const league = (env, code) => env.LEAGUES.get(env.LEAGUES.idFromName(code));
const accounts = (env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global'));
const presence = (env) => env.PRESENCE.get(env.PRESENCE.idFromName('global'));
// a guest can't race under a registered name: they show as "Guest <name>" instead
const guestLabel = (name) => cleanName('Guest ' + name);

// Who a new player is: with a session, its account ({ name, account }, or { error: 'session' } if it has expired or
// was logged out); without one, a guest whose name must not be an account's ({ name, registered }).
// If the Accounts object can't be reached, a guest's name is let through.
async function identify(env, session, name) {
  if (session) {
    const who = typeof session === 'string' ? await accounts(env).resolve(session) : null;
    return who ? { name: who.username, account: who.id } : { error: 'session' };
  }
  let registered = false;
  if (USERNAME_RE.test(name)) try { registered = await accounts(env).isRegistered(name); } catch { /* let it through */ }
  return { name, registered };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // the game's own files are served before the Worker runs, so only server paths get here
    if (url.pathname === '/health') return new Response('Driftbolt multiplayer server: ok\n', { headers: { 'content-type': 'text/plain' } });
    if (url.pathname === '/league' || url.pathname.startsWith('/league/')) return leagueApi(req, env, url);
    if (url.pathname.startsWith('/auth/')) return authApi(req, env, url, ctx);
    if (url.pathname !== '/ws' && url.pathname !== '/presence') return new Response('Not found\n', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade\n', { status: 426 });
    const origin = req.headers.get('Origin');
    if (origin !== url.origin && !originOk(origin, env.ALLOWED_ORIGINS)) return new Response('Origin not allowed\n', { status: 403 });
    if (url.pathname === '/presence') return presence(env).fetch(req);
    const action = url.searchParams.get('action');
    let code;
    if (action === 'create') code = newCode();
    else if (action === 'quick') code = await matchmaker(env).find();
    else if (action === 'join') code = normCode(url.searchParams.get('room'));
    else return new Response('Unknown action\n', { status: 400 });
    if (code.length !== CODE_LEN) return new Response('Bad room code\n', { status: 400 });
    const fwd = new URL(req.url);
    fwd.searchParams.set('room', code);
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(fwd, req));
  },
};

// ---------- League HTTP API ----------
// GET  /league?code=L-XXXX     the league: everything for its members, a preview for anyone else with the code
//      (also POST /league/get { code }, which no browser or service worker caches; the game reads leagues this way)
// POST /league/create          a new league, its creator the admin: { name, format, rounds, laps, maxPlayers,
//                              night: { day: 0-6 (Sunday = 0), time: 'HH:MM' } in UTC, aiFill, oneDriverPerTeam, private, ghost,
//                              calendar?, player: { name, team (F1) | car (arcade) } }
// POST /league/join            { code, name, team | car }
// POST /league/leave | in | chat | open | update | kick   { code, ... } as a member (admins only: open, update, kick)
// Members send "Authorization: Bearer <token>" with the token create or join gave them. Answers are JSON;
// errors are { error: 'code' } with a 4xx status.
// Creating and joining also take the player's account session, { session }: the league then uses the account's name.
const LEAGUE_ACTIONS = ['join', 'leave', 'in', 'chat', 'open', 'update', 'kick'];
const BODY_MAX = 4096;
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

// The game on this Worker is same-origin; other pages must be on the allowlist and get CORS headers.
// Requests without an Origin (not from a browser) carry their own token, so there's no cookie to protect.
// Returns a Response to send as is (refused origin, preflight, bad body) or { reply, input } to carry on with.
async function httpApi(req, env, url, methods) {
  const origin = req.headers.get('Origin');
  const cross = origin && origin !== url.origin;
  if (cross && !originOk(origin, env.ALLOWED_ORIGINS)) return json({ error: 'origin' }, 403, {});
  const cors = cross ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
  const reply = (r) => json(r.body, r.status, cors);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': methods, 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' } });
  }
  let input = {};
  if (req.method === 'POST') {
    const text = await req.text();
    if (text.length > BODY_MAX) return reply(fail(413, 'too_big'));
    try { input = JSON.parse(text || '{}'); } catch { return reply(fail(400, 'bad_json')); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(fail(400, 'bad_json'));
  }
  return { reply, input };
}

async function leagueApi(req, env, url) {
  const h = await httpApi(req, env, url, 'GET, POST');
  if (h instanceof Response) return h;
  const { reply, input } = h;
  const action = url.pathname.slice('/league'.length).replace(/^\//, '') || 'get';
  if (action === 'get' ? !['GET', 'POST'].includes(req.method) : req.method !== 'POST' || (action !== 'create' && !LEAGUE_ACTIONS.includes(action))) return reply(fail(404, 'not_found'));
  const token = /^Bearer ([a-z0-9]{24})$/.exec(req.headers.get('Authorization') || '')?.[1] || null;
  // the new member's name: their account's (checked here, never taken from the request), or a guest's that isn't an account's
  if (action === 'create' || action === 'join') {
    const p = action === 'join' ? input : (input.player = input.player && typeof input.player === 'object' ? input.player : {});
    delete p.account;
    const who = await identify(env, input.session, cleanName(p.name));
    if (who.error) return reply(fail(401, 'session'));
    if (who.registered) return reply(fail(409, 'name_registered'));
    p.name = who.name;
    if (who.account) p.account = who.account;
  }
  delete input.session;
  if (action === 'create') {
    // a fresh code each try: the League object turns down one that's already a league
    for (let i = 0; i < 5; i++) {
      const code = newLeagueCode();
      const r = await league(env, code).create(code, input);
      if (r.body.error !== 'code_taken') return reply(r);
    }
    return reply(fail(503, 'code_taken'));
  }
  const code = normLeagueCode(req.method === 'GET' ? url.searchParams.get('code') : input.code);
  if (!code) return reply(fail(400, 'bad_code'));
  return reply(await league(env, code).api(action, input, token));
}

// ---------- Accounts HTTP API (accounts.js) ----------
// POST /auth/check-name { username }                  { available, reason?: 'taken' | 'format' | 'not_allowed' }
// POST /auth/signup     { username, email }           { session, deviceToken, account }
// POST /auth/login      { username, deviceToken? }    { session, account } from a trusted device, otherwise
//                                                     { needsCode, maskedEmail, resendIn }: a code is emailed
// POST /auth/resend     { username }                  the same, at most once a minute
// POST /auth/verify     { username, code, remember }  { session, account, deviceToken? }
// POST /auth/forget     { username, deviceToken }     this device stops being trusted
// With "Authorization: Bearer <session>":
// POST /auth/me | logout | logout-all | email { email } (a code goes to the new address) | email/verify { code }
// account is { username, email (masked), created }. Errors are { error: 'code' } with a 4xx or 5xx status.
const AUTH_ACTIONS = new Set(['check-name', 'signup', 'login', 'resend', 'verify', 'forget', 'me', 'logout', 'logout-all', 'email', 'email/verify']);

async function authApi(req, env, url, ctx) {
  const h = await httpApi(req, env, url, 'POST');
  if (h instanceof Response) return h;
  const { reply, input } = h;
  const action = url.pathname.slice('/auth/'.length);
  if (req.method !== 'POST' || !AUTH_ACTIONS.has(action)) return reply(fail(404, 'not_found'));
  const session = /^Bearer (\S{1,400})$/.exec(req.headers.get('Authorization') || '')?.[1] || null;
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const { mail, ...r } = await accounts(env).api(action, input, session, ip, mailReady(env));
  // the email goes out after the answer, so a name with an account takes no longer to answer than one without
  if (mail) ctx.waitUntil(sendMail(env, mail));
  return reply(r);
}

// ---------- Matchmaker: the public rooms Quick Match can drop a player into ----------
export class Matchmaker extends DurableObject {
  async rooms() {
    const now = Date.now();
    const rooms = (await this.ctx.storage.get('rooms')) || {};
    // a room reports whenever its head count or phase changes; anything silent for long has gone away
    for (const [code, r] of Object.entries(rooms)) if (now - r.at > (r.count ? 15 * 60_000 : 60_000)) delete rooms[code];
    return rooms;
  }

  async find() {
    const rooms = await this.rooms();
    // fill rooms that are waiting in the lobby first, the fullest first; a race in progress can still take a racer for the next one
    const open = Object.entries(rooms).filter(([, r]) => r.count < MAX_PLAYERS)
      .sort(([, a], [, b]) => (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) || b.count - a.count);
    let code = open[0]?.[0];
    // nobody to join: open a new public room and list it at once, so a burst of players lands in the same one
    if (!code) {
      code = newCode();
      rooms[code] = { count: 0, phase: 'lobby', at: Date.now() };
    }
    await this.ctx.storage.put('rooms', rooms);
    return code;
  }

  async report(code, info) {
    const rooms = await this.rooms();
    if (info) rooms[code] = { ...info, at: Date.now() };
    else delete rooms[code];
    await this.ctx.storage.put('rooms', rooms);
  }
}

// ---------- Presence: how many players have the game open, for the "N online" beside the lobby's Multiplayer button ----------
// Each open game holds one socket here, hibernated so an idle one costs nothing, and hears the count whenever it changes.
// The game pings every 30 s and the runtime answers without waking this object; a socket quiet for longer than
// PRESENCE_STALE (a phone that dropped off the network without closing) is let go by a once-a-minute sweep.
const PRESENCE_STALE = 75_000;
const PRESENCE_SWEEP = 60_000;

export class Presence extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.sent = -1; // the count last sent out (memory only: after hibernation the next change is sent regardless)
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ at: Date.now() });
    this.sent = -1; // the newcomer needs the count even if a sweep just took someone else off
    await this.update();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    await this.update(ws);
  }

  async webSocketError(ws) { return this.webSocketClose(ws); }

  async alarm() { await this.update(null, true); }

  // count the live sockets (letting stale ones go), send the count if it changed, and keep the sweep going while anyone is here.
  // rearm: called from the sweep itself, which must always book the next one
  async update(gone = null, rearm = false) {
    const now = Date.now();
    const live = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === gone || ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const seen = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || ws.deserializeAttachment()?.at || 0;
      if (now - seen > PRESENCE_STALE) { try { ws.close(4000, 'stale'); } catch { /* already closed */ } continue; }
      live.push(ws);
    }
    if (live.length !== this.sent) {
      this.sent = live.length;
      const msg = JSON.stringify({ n: live.length });
      for (const ws of live) try { ws.send(msg); } catch { /* socket already gone */ }
    }
    if (live.length && (rearm || !(await this.ctx.storage.getAlarm()))) await this.ctx.storage.setAlarm(now + PRESENCE_SWEEP);
  }
}

// ---------- Room: one lobby and its races ----------
// Uses the WebSocket Hibernation API, so an idle lobby costs nothing; everything that must survive is in storage.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.buckets = new WeakMap(); // per-socket rate limit (memory only; resets if the room hibernates, which is fine)
    this.ids = new WeakMap(); // socket → player id cache over the attachment
    this.reported = '';
    ctx.blockConcurrencyWhile(async () => { this.room = (await ctx.storage.get('room')) || null; });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: null, code: url.searchParams.get('room'), action: url.searchParams.get('action') });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- sockets ----------
  idOf(ws) {
    if (!this.ids.has(ws)) this.ids.set(ws, ws.deserializeAttachment()?.id || null);
    return this.ids.get(ws);
  }

  setId(ws, id) {
    ws.serializeAttachment({ ...ws.deserializeAttachment(), id });
    this.ids.set(ws, id);
  }

  sockets(pred = () => true) {
    return this.ctx.getWebSockets().filter((ws) => { const id = this.idOf(ws); return id && pred(id); });
  }

  sendTo(ws, msg) { try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* socket already gone */ } }

  send(msg, pred) {
    const s = JSON.stringify(msg);
    for (const ws of this.sockets(pred)) this.sendTo(ws, s);
  }

  reject(ws, code) {
    this.sendTo(ws, { t: 'error', code });
    try { ws.close(REJECT[code], code); } catch { /* ignore */ }
  }

  allow(ws) {
    const now = Date.now();
    const b = this.buckets.get(ws) || { n: BURST, at: now };
    b.n = Math.min(BURST, b.n + ((now - b.at) / 1000) * RATE);
    b.at = now;
    this.buckets.set(ws, b);
    if (b.n < 1) return false;
    b.n--;
    return true;
  }

  // ---------- state ----------
  get players() { return Object.values(this.room.players); }
  capacity() { return this.room.league?.maxPlayers || MAX_PLAYERS; }
  connected() { return this.players.filter((p) => p.connected).sort((a, b) => a.joined - b.joined); }
  entry(id) { const e = this.room.race?.entries[id]; return e && !e.out ? e : null; }

  view() {
    const R = this.room;
    return {
      t: 'room', code: R.code, public: R.public, host: R.hostId, phase: R.phase, cfg: R.cfg, seq: R.seq, autoStartAt: R.autoStartAt,
      players: this.players.sort((a, b) => a.joined - b.joined).map((p) => ({ id: p.id, name: p.name, car: p.car, ...(p.team && { team: p.team }), look: p.look || {}, ready: p.ready, connected: p.connected, racing: !!this.entry(p.id), ...(p.account && { acct: true }) })),
      ...(R.league && { league: { code: R.league.code, round: R.league.round, startAt: R.league.startAt, seats: R.league.maxPlayers, raced: R.league.raced } }),
    };
  }

  // after every change: tell the room, persist, update the public list and the alarm.
  // broadcast = false for changes only the racers hear about, unless something marked the room view dirty
  async commit(broadcast = true) {
    const R = this.room;
    if (!R) return;
    if (broadcast || this.dirty) this.send(this.view());
    this.dirty = false;
    if (R.league?.report && Date.now() >= (R.league.retryAt || 0)) await this.reportToLeague();
    await this.ctx.storage.put('room', R);
    if (R.public) {
      const info = { count: this.players.length, phase: R.phase };
      const key = JSON.stringify(info);
      if (key !== this.reported) {
        this.reported = key;
        try { await matchmaker(this.env).report(R.code, info); } catch { /* the list heals on the next report */ }
      }
    }
    await this.schedule();
  }

  async schedule() {
    const R = this.room;
    const t = [];
    for (const p of this.players) if (!p.connected) t.push(p.goneAt + (this.entry(p.id) ? RACE_GRACE : LOBBY_GRACE));
    if (R.phase === 'loading') t.push(R.race.loadDeadline);
    if (R.phase === 'race') { t.push(R.race.hardEndAt); if (R.race.endAt) t.push(R.race.endAt); if (R.race.celebBy) t.push(R.race.celebBy); }
    if (R.phase === 'lobby' && R.autoStartAt) t.push(R.autoStartAt);
    const L = R.league;
    if (L?.report) t.push(L.retryAt || Date.now());
    if (L && !L.raced && !L.noShow && R.phase === 'lobby') t.push(Date.now() < L.startAt ? L.startAt : L.lateStart || L.startAt + NO_SHOW);
    if (!this.players.length && this.wipeAt() < Infinity) t.push(this.wipeAt());
    if (t.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 20, Math.min(...t)));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const R = this.room;
    if (!R) return;
    const now = Date.now();
    if (!this.players.length && now >= this.wipeAt()) {
      if (R.public) try { await matchmaker(this.env).report(R.code, null); } catch { /* ignore */ }
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    for (const p of this.players) if (!p.connected && now - p.goneAt >= (this.entry(p.id) ? RACE_GRACE : LOBBY_GRACE)) this.removePlayer(p.id);
    if (R.phase === 'loading' && now >= R.race.loadDeadline) this.beginRace();
    // the winner never started a celebration: stop waiting for one
    if (R.phase === 'race' && R.race.celebBy && now >= R.race.celebBy) { R.race.celebBy = 0; this.checkRaceOver(); }
    if (R.phase === 'race' && (now >= R.race.hardEndAt || (R.race.endAt && now >= R.race.endAt))) this.endRace();
    if (R.phase === 'lobby' && R.autoStartAt && now >= R.autoStartAt) {
      R.autoStartAt = 0;
      if (this.everyoneReady()) this.startRace();
    }
    this.leagueClock(now);
    await this.commit();
  }

  // an empty room is wiped a minute after the last player left; a league room not before its race is run and reported
  wipeAt() {
    const R = this.room, L = R.league;
    return L && (L.report || (!L.raced && !L.noShow)) ? Infinity : R.emptySince + EMPTY_TTL;
  }

  // ---------- messages ----------
  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MSG || !this.allow(ws)) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'ping') return this.sendTo(ws, { t: 'pong', c: m.c, s: Date.now() });
    if (m.t === 'hello') return this.hello(ws, m);
    const R = this.room;
    const p = R && R.players[this.idOf(ws)];
    if (!p) return;
    const host = R.hostId === p.id;
    switch (m.t) {
      case 's': {
        // car state: relayed as is to the other racers, never stored
        const id = this.driven(p, m);
        const e = id && this.entry(id);
        if (!e || R.phase !== 'race' || !validSnap(m.p)) return;
        // laps done + share of the current lap, for ranking racers who don't finish
        e.prog = m.p[12] + m.p[8] / (trackLen(R.race.cfg.map) || 1);
        const s = JSON.stringify({ t: 's', id, p: m.p });
        for (const o of this.sockets((id) => id !== p.id && this.entry(id))) this.sendTo(o, s);
        return;
      }
      case 'ev': {
        if (!this.entry(p.id) || R.phase !== 'race' || !EVENTS.has(m.k)) return;
        // only the winner celebrates; their game reports the start of the show, or that they skipped it
        const celeb = m.k === 'celeb';
        if (celeb && p.id !== R.race.winner) return;
        if (!celeb || CELEBRATIONS.includes(m.kind)) {
          const ev = { t: 'ev', id: p.id, k: m.k };
          for (const f of ['x', 'y', 'z', 'h']) if (Number.isFinite(m[f])) ev[f] = Math.round(m[f] * 100) / 100;
          for (const f of ['bid', 'by', 'target', 'kind']) if (typeof m[f] === 'string' && m[f].length <= 24) ev[f] = m[f];
          const s = JSON.stringify(ev);
          for (const o of this.sockets((id) => id !== p.id && this.entry(id))) this.sendTo(o, s);
        }
        if (!celeb || !R.race.celebBy) return;
        R.race.celebBy = 0;
        this.checkRaceOver();
        return this.commit(false);
      }
      case 'set':
        // in a league room, names and cars are the league's; an account holder's name is their account's
        if (typeof m.name === 'string' && !R.league && !p.account) {
          const name = cleanName(m.name) || p.name;
          let registered = false;
          if (USERNAME_RE.test(name)) try { registered = await accounts(this.env).isRegistered(name); } catch { /* let it through */ }
          if (this.room !== R || R.players[p.id] !== p) return; // the room changed while Accounts answered
          p.name = this.uniqueName(registered ? guestLabel(name) : name, p.id);
        }
        if (!this.entry(p.id)) {
          if (m.car !== undefined && !R.league) p.car = carIdx(m.car);
          if (m.look !== undefined) p.look = cleanLook(m.look);
          if (typeof m.ready === 'boolean') p.ready = m.ready;
        }
        this.checkAutoStart();
        return this.commit();
      case 'cfg':
        if (!host || R.phase !== 'lobby' || R.league) return;
        if (RACE_MAPS.includes(m.map)) R.cfg.map = m.map;
        if (RACE_MODES.includes(m.mode)) R.cfg.mode = m.mode;
        if (LAP_OPTIONS.includes(m.laps)) R.cfg.laps = m.laps;
        return this.commit();
      case 'start':
        if (!host || R.phase !== 'lobby' || !this.canStart()) return;
        this.startRace();
        return this.commit();
      case 'kick': {
        if (!host || R.league || m.id === p.id || !R.players[m.id]) return;
        for (const o of this.sockets((id) => id === m.id)) this.reject(o, 'kicked');
        this.removePlayer(m.id);
        return this.commit();
      }
      case 'loaded': {
        const e = this.entry(p.id);
        if (R.phase !== 'loading' || m.seq !== R.seq || !e) return;
        e.loaded = true;
        if (Object.values(R.race.entries).every((x) => x.loaded || x.out)) this.beginRace();
        return this.commit(false);
      }
      case 'lap': {
        const id = this.driven(p, m);
        if (!id || R.phase !== 'race' || m.seq !== R.seq) return;
        this.lap(id, m);
        return this.commit(false);
      }
      case 'quit': {
        // left the race (page reload, quit from the pause menu) but stays in the room
        const e = this.entry(p.id);
        if (!e || R.phase === 'lobby') return;
        this.dropRacer(p.id);
        return this.commit();
      }
      case 'leave':
        this.removePlayer(p.id);
        try { ws.close(1000, 'left'); } catch { /* ignore */ }
        return this.commit();
    }
  }

  async hello(ws, m) {
    const att = ws.deserializeAttachment() || {};
    // who a new player is, asked before anything here changes (other messages can arrive while Accounts answers).
    // A league room seats by ticket and names its seats itself.
    let who = null;
    if (!this.room?.league) {
      try { who = await identify(this.env, m.session, cleanName(m.name) || 'Driver'); } catch { who = { name: cleanName(m.name) || 'Driver' }; }
    }
    const now = Date.now();
    let R = this.room;
    if (!R) {
      if (att.action === 'join') return this.reject(ws, 'not_found');
      R = this.room = {
        code: att.code, public: att.action === 'quick', created: now, hostId: null, phase: 'lobby',
        cfg: { map: 'city', mode: 'speed', laps: 2 }, players: {}, seq: 0, race: null, autoStartAt: 0, emptySince: now,
      };
    } else if (att.action === 'create' && this.players.length) return this.reject(ws, 'taken');
    // a league room seats the league's members only, by the ticket the league gave each of them for this race
    const L = R.league;
    const seat = L && typeof m.ticket === 'string' && Object.hasOwn(L.seats, m.ticket) ? L.seats[m.ticket] : null;
    if (L && !seat) return this.reject(ws, 'not_member');
    let p = seat ? R.players[seat.id] || null : typeof m.token === 'string' && m.token ? this.players.find((x) => x.token === m.token) : null;
    if (p) {
      // the same player on a new connection: retire the old one
      for (const old of this.sockets((id) => id === p.id)) if (old !== ws) { this.setId(old, null); try { old.close(4005, 'replaced'); } catch { /* ignore */ } }
      p.connected = true;
      p.goneAt = 0;
    } else {
      if (who?.error) return this.reject(ws, 'session');
      if (this.players.length >= this.capacity()) return this.reject(ws, 'full');
      const id = seat ? seat.id : rid(8);
      // an account holder keeps their name: a guest already here under it becomes "Guest <name>"
      if (who?.account) for (const o of this.players) if (!o.account && o.name.toLowerCase() === who.name.toLowerCase()) o.name = this.uniqueName(guestLabel(o.name), o.id);
      const name = seat ? seat.name : this.uniqueName(who?.registered ? guestLabel(who.name) : who?.name || cleanName(m.name) || 'Driver', id);
      p = { id, token: rid(24), name, car: carIdx(seat ? seat.car : m.car), look: cleanLook(m.look), ready: false, joined: now, connected: true, goneAt: 0 };
      if (seat?.team) p.team = seat.team;
      if (who?.account) p.account = who.account;
      R.players[id] = p;
    }
    // past the start time with nobody there yet: the race starts a minute after the first arrival
    if (L && !L.raced && R.phase === 'lobby' && now >= L.startAt && !L.lateStart) L.lateStart = now + LATE_WAIT;
    if (!R.players[R.hostId]) R.hostId = p.id;
    this.setId(ws, p.id);
    this.sendTo(ws, { t: 'welcome', id: p.id, token: p.token, code: R.code, s: Date.now() });
    // back mid-race: where the race stands, so a client that kept driving through the drop can carry on
    const e = this.entry(p.id);
    if (e && R.phase !== 'lobby') this.sendTo(ws, { t: 'resume', seq: R.seq, phase: R.phase, startAt: R.race.startAt, lap: e.lap });
    this.checkAutoStart();
    await this.commit();
  }

  async webSocketClose(ws) {
    const R = this.room;
    const id = this.idOf(ws);
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    if (!R || !id || !R.players[id]) return;
    // another live connection for the same player (it reconnected first): nothing changed
    if (this.sockets((x) => x === id).some((o) => o !== ws && o.readyState === WebSocket.OPEN)) return;
    const p = R.players[id];
    p.connected = false;
    p.goneAt = Date.now();
    this.checkAutoStart();
    await this.commit();
  }

  async webSocketError(ws) { return this.webSocketClose(ws); }

  // ---------- lobby ----------
  uniqueName(name, id) {
    const taken = new Set(this.players.filter((p) => p.id !== id).map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let k = 2; k < 99; k++) {
      const n = name.slice(0, 13) + ' ' + k;
      if (!taken.has(n.toLowerCase())) return n;
    }
    return name;
  }

  // the host starts once there's someone to race and every guest is ready
  canStart() {
    if (this.room.league?.raced) return false; // a league room runs its one race
    const c = this.connected();
    return c.length >= 2 && c.every((p) => p.ready || p.id === this.room.hostId);
  }

  everyoneReady() {
    const c = this.connected();
    return c.length >= 2 && c.every((p) => p.ready);
  }

  // public rooms have no organizer: they start by themselves once everyone is ready
  checkAutoStart() {
    const R = this.room;
    if (!R.public || R.phase !== 'lobby') return;
    if (!this.everyoneReady()) R.autoStartAt = 0;
    else if (!R.autoStartAt) R.autoStartAt = Date.now() + AUTO_START;
  }

  removePlayer(id) {
    const R = this.room;
    if (!R.players[id]) return;
    this.dirty = true;
    if (this.entry(id)) this.dropRacer(id);
    delete R.players[id];
    if (R.hostId === id) R.hostId = this.connected()[0]?.id || this.players[0]?.id || null;
    if (!this.players.length) { R.emptySince = Date.now(); R.autoStartAt = 0; }
    this.checkAutoStart();
  }

  // ---------- league race nights ----------
  // The League object opens this room for one of its races: its track and laps, a seat per member (by ticket), AI drivers
  // for empty seats, and the start time. Returns false if the code is already in use, so the League picks another.
  async setupLeague(s) {
    if (this.room) return false;
    const now = Date.now();
    this.room = {
      code: s.room, public: false, created: now, hostId: null, phase: 'lobby', cfg: s.cfg, players: {}, seq: 0, race: null, autoStartAt: 0, emptySince: now,
      league: { code: s.league, round: s.round, startAt: s.startAt, maxPlayers: s.maxPlayers, aiFill: s.aiFill, ai: s.ai, seats: s.seats, raced: false, noShow: false, lateStart: 0, report: null, retryAt: 0 },
    };
    await this.commit(false);
    return true;
  }

  // a member who joined the league after the room opened gets a seat (or loses it on leaving: seat = null)
  async leagueSeat(ticket, seat) {
    const L = this.room?.league;
    if (!L) return;
    if (seat) L.seats[ticket] = seat;
    else delete L.seats[ticket];
    await this.commit(false);
  }

  // the race starts at its set time with whoever is there; with nobody by NO_SHOW after it, the night is called off
  leagueClock(now) {
    const R = this.room, L = R.league;
    if (!L || L.raced || L.noShow || R.phase !== 'lobby' || now < L.startAt) return;
    if (this.connected().length) { if (now >= L.lateStart) this.startRace(); }
    else if (now >= L.startAt + NO_SHOW) {
      L.noShow = true;
      L.report = { round: L.round, rows: null };
    }
  }

  // tells the League how its race went (rows: null when nobody came); kept and retried until it gets through
  async reportToLeague() {
    const R = this.room, L = R.league;
    try {
      await this.env.LEAGUES.get(this.env.LEAGUES.idFromName(L.code)).raceDone(R.code, L.report.round, L.report.rows);
      L.report = null;
    } catch {
      L.retryAt = Date.now() + REPORT_RETRY;
    }
  }

  // ---------- race ----------
  startRace() {
    const R = this.room, L = R.league;
    const racers = this.connected();
    // a league race gives its empty seats to the league's AI drivers; the host's game drives them (messages with `as`)
    const ai = L?.aiFill ? L.ai.slice(0, Math.max(0, L.maxPlayers - racers.length)).map((a) => ({ ...a, ai: true })) : [];
    // shuffled grid: no one gets pole position for joining first
    const grid = shuffle([...racers, ...ai]);
    if (L) L.raced = true;
    R.seq++;
    R.phase = 'loading';
    this.dirty = true;
    R.autoStartAt = 0;
    R.race = {
      seq: R.seq, cfg: { ...R.cfg }, grid: grid.map((p) => p.id), loadDeadline: Date.now() + LOAD_TIMEOUT, startAt: 0, endAt: 0, hardEndAt: 0, firstAt: 0,
      aiBy: ai.length ? (racers.find((p) => p.id === R.hostId) || racers[0]).id : null,
      entries: Object.fromEntries(grid.map((p) => [p.id, { name: p.name, car: carIdx(p.car), team: p.team, ai: !!p.ai, loaded: !!p.ai, out: false, lap: 0, lapTimes: [], finished: false, time: 0, prog: -1 }])),
    };
    this.send({ t: 'load', seq: R.seq, cfg: R.race.cfg, aiBy: R.race.aiBy, grid: grid.map((p) => ({ id: p.id, name: p.name, car: carIdx(p.car), look: p.look || {}, ...(p.team && { team: p.team }), ...(p.ai && { ai: true }) })) });
  }

  // the racer a snapshot or lap is about: the sender, or a league AI car the sender's game drives
  driven(p, m) {
    if (m.as === undefined) return p.id;
    const race = this.room.race;
    const e = race && typeof m.as === 'string' && Object.hasOwn(race.entries, m.as) ? race.entries[m.as] : null;
    return e?.ai && race.aiBy === p.id ? m.as : null;
  }

  // everyone has the track (or the load timeout ran out): the countdown starts on the server's clock
  beginRace() {
    const R = this.room;
    for (const [id, e] of Object.entries(R.race.entries)) if (!e.loaded && !e.out) this.dropRacer(id);
    R.phase = 'race';
    this.dirty = true;
    R.race.startAt = Date.now() + START_PAD + COUNTDOWN * 1000;
    R.race.hardEndAt = R.race.startAt + R.race.cfg.laps * 4 * 60_000 + 60_000;
    this.send({ t: 'go', seq: R.seq, startAt: R.race.startAt });
    this.checkRaceOver();
  }

  dropRacer(id) {
    const R = this.room;
    const e = R.race?.entries[id];
    if (!e || e.out) return;
    e.out = true;
    this.dirty = true;
    this.send({ t: 'out', seq: R.seq, id });
    // the racer whose game drove the AI cars is gone, and the AI cars with them
    if (R.race.aiBy === id) {
      for (const [aid, a] of Object.entries(R.race.entries)) if (a.ai && !a.out && !a.finished) { a.out = true; this.send({ t: 'out', seq: R.seq, id: aid }); }
    }
    if (R.phase === 'race') this.checkRaceOver();
    else if (R.phase === 'loading' && Object.values(R.race.entries).every((x) => x.loaded || x.out)) this.beginRace();
  }

  lap(id, m) {
    const R = this.room, e = this.entry(id);
    if (!e || e.finished) return;
    const lap = m.lap, time = m.time;
    if (lap !== e.lap + 1 || !Number.isFinite(time)) return;
    const prev = e.lapTimes.reduce((a, b) => a + b, 0);
    const lapT = time - prev;
    const elapsed = (Date.now() - R.race.startAt) / 1000;
    // a lap quicker than flat out all the way round, or a race clock running ahead of the server's: not believable
    if (lapT < trackLen(R.race.cfg.map) / MAX_SPEED || time > elapsed + 2) return;
    e.lap = lap;
    e.lapTimes.push(Math.round(lapT * 1000) / 1000);
    const done = lap >= R.race.cfg.laps;
    if (done) {
      e.finished = true;
      e.time = Math.round(time * 1000) / 1000;
      if (!R.race.firstAt) {
        R.race.firstAt = Date.now();
        R.race.endAt = R.race.firstAt + FINISH_GRACE * 1000;
        R.race.winner = id;
        if (!e.ai) R.race.celebBy = R.race.firstAt + CELEB_WAIT; // an AI winner doesn't celebrate
      }
    }
    const place = done ? Object.values(R.race.entries).filter((x) => x.finished).length : 0;
    this.send({ t: 'lap', seq: R.seq, id, lap, time: e.time || time, lapT: e.lapTimes[e.lapTimes.length - 1], finished: done, place, endAt: R.race.endAt });
    this.checkRaceOver();
  }

  checkRaceOver() {
    const R = this.room;
    // AI cars nobody drives (an older game hosting) don't hold the race up
    if (R.phase !== 'race' || !Object.values(R.race.entries).every((e) => e.finished || e.out || (e.ai && e.prog < 0))) return;
    // everyone is in, but the winner hasn't started celebrating yet: the rest of the room should get to see it
    if (R.race.celebBy > Date.now() && this.entry(R.race.winner)) return;
    this.endRace();
  }

  endRace() {
    const R = this.room;
    const rows = Object.entries(R.race.entries).map(([id, e]) => ({
      id, name: e.name, car: e.car, ...(e.team && { team: e.team }), ...(e.ai && { ai: true }), finished: e.finished, out: e.out && !e.finished, time: e.time,
      // didn't start: an AI car nobody drove, or a racer whose game never had the track loaded
      dns: !e.finished && (e.ai ? e.prog < 0 : e.out && !e.loaded),
      best: e.lapTimes.length ? Math.min(...e.lapTimes) : 0, prog: Math.max(0, Math.round(e.prog * 1000) / 1000),
    }));
    rows.sort((a, b) => (a.dns - b.dns) || (b.finished - a.finished) || (a.finished ? a.time - b.time : (a.out - b.out) || b.prog - a.prog));
    rows.forEach((r, i) => { r.place = i + 1; });
    this.send({ t: 'results', seq: R.seq, laps: R.race.cfg.laps, rows });
    if (R.league) R.league.report = { round: R.league.round, rows };
    R.phase = 'lobby';
    R.race = null;
    this.dirty = true;
    // ready up again from the lobby, so the next race doesn't start while someone is still reading the results
    for (const p of this.players) p.ready = false;
  }
}

// ---------- League: one season of races on a weekly race night ----------
// Settings, calendar, members, AI drivers, each round's results and a feed. On race night it opens a normal Room in league
// mode (members' seats by ticket, AI drivers in the empty seats), and the Room reports the finishing order back.
const DAY = 86_400_000;
const OPEN_NOW = 5 * 60_000; // an admin opening the race early: it starts this long after (or as soon as everyone in the room is ready)
const RACE_TIMEOUT = 2 * 60 * 60_000; // a race room that hasn't reported this long after the start is given up on
const FEED_MAX = 60;
const CHAT_GAP = 3_000; // ms between one member's quick-chat messages
const SEEN_GAP = 60_000; // "last seen" is saved at most this often
const AI_NAMES = ['Ines', 'Kai', 'Mira', 'Leo', 'Hana', 'Rin', 'Zoe', 'Ivan', 'Aiko', 'Nico', 'Sora', 'Luca'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const GP_IDS = GPS.map((g) => g.id), TEAM_IDS = TEAMS.map((t) => t.id);
const ERR_STATUS = { full: 409, team_taken: 409, name_taken: 409, race_open: 409, season_over: 409, started: 409 };
const ok = (body) => ({ status: 200, body });
const fail = (status, error) => ({ status, body: { error } });
const bad = (error) => fail(ERR_STATUS[error] || 400, error);
const newLeagueCode = () => 'L-' + Array.from(crypto.getRandomValues(new Uint8Array(LEAGUE_CODE_LEN)), (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');

// the next race-night start (UTC) at or after `from`
function nextNight({ day, time }, from) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(from);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) + ((day - d.getUTCDay() + 7) % 7) * DAY;
  if (at < from) at += 7 * DAY;
  return at;
}

// settings from a request: `prev` (when updating) keeps whatever the input leaves out. Returns an error code on bad input.
function leagueSettings(input, prev) {
  const s = { ...prev };
  const has = (k) => !prev || k in input;
  if (has('name')) { s.name = cleanName(input.name, LEAGUE_NAME_LEN); if (!s.name) return 'bad_name'; }
  if (has('format')) { if (!Object.hasOwn(LEAGUE_FORMATS, input.format)) return 'bad_format'; s.format = input.format; }
  const F = LEAGUE_FORMATS[s.format];
  for (const [k, list] of [['rounds', F.rounds], ['maxPlayers', F.players], ['laps', LAP_OPTIONS]]) {
    if (has(k)) s[k] = input[k];
    if (!list.includes(s[k])) return 'bad_' + k; // also when a new format doesn't allow the old value
  }
  if (has('night')) {
    const n = input.night;
    if (!n || typeof n !== 'object' || !Number.isInteger(n.day) || n.day < 0 || n.day > 6 || !TIME_RE.test(n.time)) return 'bad_night';
    s.night = { day: n.day, time: n.time };
  }
  const defaults = { aiFill: true, oneDriverPerTeam: true, private: true, ghost: false };
  for (const k of Object.keys(defaults)) {
    if (k in input) { if (typeof input[k] !== 'boolean') return 'bad_' + k; s[k] = input[k]; } else if (!prev) s[k] = defaults[k];
  }
  return s;
}

// the season's tracks: F1 takes Grands Prix in calendar order; arcade cycles the tracks, never the same one twice running
function makeCalendar(format, rounds) {
  if (format === 'f1') return rounds >= GP_IDS.length ? [...GP_IDS] : shuffle([...GP_IDS]).slice(0, rounds).sort((a, b) => GP_IDS.indexOf(a) - GP_IDS.indexOf(b));
  const out = [];
  while (out.length < rounds) for (const m of shuffle([...RACE_MAPS])) if (out.length < rounds && m !== out[out.length - 1]) out.push(m);
  return out;
}

// a calendar sent by the creator: one known track or Grand Prix per round
function validCalendar(list, format, rounds) {
  const ids = format === 'f1' ? GP_IDS : RACE_MAPS;
  return Array.isArray(list) && list.length === rounds && list.every((id) => ids.includes(id)) ? [...list] : null;
}

export class League extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.L = null;
    ctx.blockConcurrencyWhile(async () => { this.L = (await ctx.storage.get('league')) || null; });
  }

  async save() {
    await this.ctx.storage.put('league', this.L);
    await this.schedule();
  }

  // ---------- requests (from the Worker) ----------
  async create(code, input) {
    if (this.L) return fail(409, 'code_taken');
    const settings = leagueSettings(input, null);
    if (typeof settings === 'string') return bad(settings);
    const calendar = input.calendar === undefined ? makeCalendar(settings.format, settings.rounds) : validCalendar(input.calendar, settings.format, settings.rounds);
    if (!calendar) return bad('bad_calendar');
    const now = Date.now();
    const L = { code, created: now, settings, calendar, round: 0, next: nextNight(settings.night, now), members: {}, ai: [], results: [], feed: [], race: null };
    const m = this.newMember(L, input.player || {}, true);
    if (typeof m === 'string') return bad(m);
    L.members[m.id] = m;
    this.L = L;
    this.feed({ k: 'create', id: m.id, name: m.name });
    await this.save();
    return ok({ code, member: { id: m.id, token: m.token }, league: this.view(m) });
  }

  async api(action, input, token) {
    const L = this.L;
    if (!L) return fail(404, 'not_found');
    const me = token ? Object.values(L.members).find((m) => m.token === token) : null;
    if (action === 'join') return this.join(input);
    if (action === 'get' && !me) return ok(this.preview());
    if (!me) return fail(401, 'not_member');
    const now = Date.now();
    if (now - (me.lastSeen || 0) > SEEN_GAP || action !== 'get') { me.lastSeen = now; if (action === 'get') await this.save(); }
    switch (action) {
      case 'get': return ok(this.view(me));
      case 'leave': return this.leave(me);
      case 'in':
        if (typeof input.in !== 'boolean') return bad('bad_in');
        me.in = input.in ? L.round : -1;
        break;
      case 'chat':
        if (!LEAGUE_CHAT.includes(input.msg)) return bad('bad_msg');
        if (now - (me.chatAt || 0) < CHAT_GAP) return fail(429, 'slow_down');
        me.chatAt = now;
        this.feed({ k: 'chat', id: me.id, name: me.name, msg: input.msg });
        break;
      case 'open':
        if (!me.admin) return fail(403, 'not_admin');
        if (L.round >= L.calendar.length) return bad('season_over');
        if (L.race) return bad('race_open');
        if (!(await this.openRace(now + OPEN_NOW))) return fail(503, 'no_room');
        break;
      case 'update': {
        if (!me.admin) return fail(403, 'not_admin');
        const r = this.update(input);
        if (r) return bad(r);
        break;
      }
      case 'kick': {
        if (!me.admin) return fail(403, 'not_admin');
        const m = typeof input.member === 'string' && Object.hasOwn(L.members, input.member) ? L.members[input.member] : null;
        if (!m || m === me) return bad('bad_member');
        await this.remove(m);
        this.feed({ k: 'kick', id: m.id, name: m.name });
        break;
      }
    }
    await this.save();
    return ok(this.view(me));
  }

  async join(input) {
    const L = this.L;
    if (Object.keys(L.members).length >= L.settings.maxPlayers) return bad('full');
    const m = this.newMember(L, input, false);
    if (typeof m === 'string') return bad(m);
    L.members[m.id] = m;
    this.feed({ k: 'join', id: m.id, name: m.name });
    // joined on race night: a seat in tonight's race too
    if (L.race) await this.seatInRoom(m);
    await this.save();
    return ok({ code: L.code, member: { id: m.id, token: m.token }, league: this.view(m) });
  }

  async leave(me) {
    const L = this.L;
    await this.remove(me);
    if (!Object.keys(L.members).length) {
      // the last one out: the league goes with them
      await this.ctx.storage.deleteAll();
      this.L = null;
      return ok({ left: true });
    }
    this.feed({ k: 'leave', id: me.id, name: me.name });
    await this.save();
    return ok({ left: true });
  }

  // a member leaves or is kicked: off the list and out of tonight's room; the admin role passes to the longest-standing member
  async remove(m) {
    const L = this.L;
    delete L.members[m.id];
    const ticket = L.race?.tickets[m.id];
    if (ticket) {
      delete L.race.tickets[m.id];
      try { await this.env.ROOMS.get(this.env.ROOMS.idFromName(L.race.room)).leagueSeat(ticket, null); } catch { /* the room may be gone */ }
    }
    if (m.admin) {
      const next = Object.values(L.members).sort((a, b) => a.joined - b.joined)[0];
      if (next) next.admin = true;
    }
  }

  // an admin's changes. The format, length and calendar are fixed once the first race night is under way.
  update(input) {
    const L = this.L;
    const changes = input.settings && typeof input.settings === 'object' ? input.settings : {};
    const s = leagueSettings(changes, L.settings);
    if (typeof s === 'string') return s;
    const reshape = s.format !== L.settings.format || s.rounds !== L.settings.rounds || input.calendar !== undefined;
    if (reshape && (L.round > 0 || L.race)) return 'started';
    const members = Object.values(L.members);
    if (s.maxPlayers < members.length) return 'bad_maxPlayers';
    if (s.format !== L.settings.format) return 'started'; // members' teams and cars belong to the format they joined
    if (s.format === 'f1' && s.oneDriverPerTeam && new Set(members.map((m) => m.team)).size < members.length) return 'team_taken';
    if (reshape) {
      const cal = input.calendar === undefined ? makeCalendar(s.format, s.rounds) : validCalendar(input.calendar, s.format, s.rounds);
      if (!cal) return 'bad_calendar';
      L.calendar = cal;
    }
    if (s.night.day !== L.settings.night.day || s.night.time !== L.settings.night.time) L.next = nextNight(s.night, Date.now());
    L.settings = s;
    this.feed({ k: 'settings' });
    return null;
  }

  // name and seat checked against the league's other members; a string error code when they don't fit
  newMember(L, input, admin) {
    const name = cleanName(input.name);
    if (!name) return 'bad_name';
    const others = Object.values(L.members);
    if (others.some((o) => o.name.toLowerCase() === name.toLowerCase())) return 'name_taken';
    const m = { id: '', token: rid(24), name, admin, joined: Date.now(), lastSeen: Date.now(), in: -1 };
    if (typeof input.account === 'string') m.account = input.account; // set by the Worker from a checked session
    do m.id = rid(8); while (Object.hasOwn(L.members, m.id) || m.id.startsWith('ai'));
    if (L.settings.format === 'f1') {
      if (!TEAM_IDS.includes(input.team)) return 'bad_team';
      if (L.settings.oneDriverPerTeam && others.some((o) => o.team === input.team)) return 'team_taken';
      m.team = input.team;
    } else {
      if (!Number.isInteger(input.car) || input.car < 0 || input.car >= CAR_COUNT) return 'bad_car';
      m.car = input.car;
    }
    return m;
  }

  feed(e) {
    const L = this.L;
    L.feed.push({ at: Date.now(), ...e });
    if (L.feed.length > FEED_MAX) L.feed.splice(0, L.feed.length - FEED_MAX);
  }

  // ---------- race nights ----------
  seat(m) { return { id: m.id, name: m.name, ...(m.team !== undefined && { team: m.team }), ...(m.car !== undefined && { car: m.car }) }; }

  // AI drivers keep their names all season (the standings follow them); F1 AI take the teams no member drives
  fillAi() {
    const L = this.L, S = L.settings;
    while (L.ai.length < S.maxPlayers - 1) L.ai.push({ id: 'ai-' + (L.ai.length + 1), name: AI_NAMES[L.ai.length % AI_NAMES.length] });
    if (S.format === 'f1') {
      const taken = new Set(Object.values(L.members).map((m) => m.team));
      const free = TEAM_IDS.filter((t) => !taken.has(t));
      L.ai.forEach((a, i) => { a.team = free.length ? free[i % free.length] : TEAM_IDS[i % TEAM_IDS.length]; });
    } else for (const a of L.ai) if (!Number.isInteger(a.car)) a.car = Math.floor(Math.random() * CAR_COUNT);
  }

  // opens the race: a fresh room in league mode, with a ticket per member. One at a time (the alarm and an admin could race here).
  openRace(startsAt) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const L = this.L, S = L.settings;
      if (L.race) return true;
      this.fillAi();
      const map = S.format === 'f1' ? 'f1-' + L.calendar[L.round] : L.calendar[L.round];
      const tickets = {}, seats = {};
      for (const m of Object.values(L.members)) { tickets[m.id] = rid(16); seats[tickets[m.id]] = this.seat(m); }
      for (let i = 0; i < 5; i++) {
        const room = newCode();
        const opened = await this.env.ROOMS.get(this.env.ROOMS.idFromName(room)).setupLeague({
          room, league: L.code, round: L.round, startAt: startsAt, cfg: { map, mode: S.format === 'f1' ? 'speed' : 'item', laps: S.laps },
          maxPlayers: S.maxPlayers, aiFill: S.aiFill, ai: L.ai.map((a) => this.seat(a)), seats,
        });
        if (opened) {
          L.race = { round: L.round, map, room, startsAt, tickets };
          this.feed({ k: 'lobby', round: L.round, map, startsAt });
          await this.save();
          return true;
        }
      }
      return false;
    });
  }

  async seatInRoom(m) {
    const L = this.L;
    const ticket = (L.race.tickets[m.id] = rid(16));
    try { await this.env.ROOMS.get(this.env.ROOMS.idFromName(L.race.room)).leagueSeat(ticket, this.seat(m)); } catch { /* the room may be gone */ }
  }

  // the race room's report: rows in finishing order, or null when nobody came. Stale or repeated reports are ignored.
  async raceDone(room, round, rows) {
    const L = this.L;
    if (!L?.race || L.race.room !== room || L.race.round !== round) return false;
    const S = L.settings, now = Date.now();
    if (!rows) {
      // nobody turned up: the round moves to the next race night
      this.feed({ k: 'postponed', round, map: L.race.map });
      L.next = nextNight(S.night, Math.max(now, L.race.startsAt) + 60_000);
      L.race = null;
      await this.save();
      return true;
    }
    // points go to the classified finishers in order; DNF and DNS score nothing
    const points = LEAGUE_FORMATS[S.format].points;
    let pos = 0;
    const out = rows.map((r) => {
      const status = r.dns ? 'DNS' : r.out ? 'DNF' : 'P';
      const p = status === 'P' ? ++pos : null;
      return { id: String(r.id), name: cleanName(r.name), ...(r.ai && { ai: true }), ...(r.team && { team: r.team }), ...(Number.isInteger(r.car) && S.format !== 'f1' && { car: r.car }),
        pos: p, status, pts: p ? points[p - 1] || 0 : 0, best: Number(r.best) || 0, time: Number(r.time) || 0 };
    });
    // members who weren't on the grid didn't start
    for (const m of Object.values(L.members)) if (!out.some((r) => r.id === m.id)) out.push({ ...this.seat(m), pos: null, status: 'DNS', pts: 0, best: 0, time: 0 });
    L.results.push({ round, map: L.race.map, at: now, rows: out });
    const win = out.find((r) => r.pos === 1);
    if (win) this.feed({ k: 'win', round, map: L.race.map, id: win.id, name: win.name, ...(win.ai && { ai: true }) });
    const fast = out.filter((r) => r.best > 0).sort((a, b) => a.best - b.best)[0];
    if (fast) this.feed({ k: 'fastest', round, map: L.race.map, id: fast.id, name: fast.name, time: fast.best, ...(fast.ai && { ai: true }) });
    L.round++;
    L.race = null;
    if (L.round >= L.calendar.length) {
      const champ = this.standings().drivers[0];
      if (champ) this.feed({ k: 'champion', id: champ.id, name: champ.name, ...(champ.ai && { ai: true }) });
    } else L.next = nextNight(S.night, now);
    await this.save();
    return true;
  }

  // the clock: open the room before race night, or give up on a room that never reported back
  async schedule() {
    const L = this.L;
    if (!L) return this.ctx.storage.deleteAlarm();
    const at = L.race ? L.race.startsAt + RACE_TIMEOUT : L.round < L.calendar.length ? L.next - LOBBY_OPEN : 0;
    if (at) await this.ctx.storage.setAlarm(Math.max(Date.now() + 20, at));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const L = this.L;
    if (!L) return;
    const now = Date.now();
    if (L.race && now >= L.race.startsAt + RACE_TIMEOUT) {
      this.feed({ k: 'postponed', round: L.round, map: L.race.map });
      L.next = nextNight(L.settings.night, now);
      L.race = null;
    } else if (!L.race && L.round < L.calendar.length && now >= L.next - LOBBY_OPEN) {
      await this.openRace(Math.max(L.next, now));
    }
    await this.save();
  }

  // ---------- what members see ----------
  // drivers (members, AI drivers once they've been on a grid, and anyone who left but raced) with points, wins, podiums and
  // their result each round;
  // in F1 also constructors, adding up every car a team ran
  standings() {
    const L = this.L, S = L.settings;
    const table = new Map();
    const add = (d) => { if (!table.has(d.id)) table.set(d.id, { ...this.seat(d), ...(d.ai && { ai: true }), pts: 0, wins: 0, podiums: 0, rounds: [] }); return table.get(d.id); };
    for (const m of Object.values(L.members)) add(m);
    const teams = {};
    L.results.forEach((res, i) => {
      for (const r of res.rows) {
        const d = add(r);
        d.pts += r.pts;
        if (r.pos === 1) d.wins++;
        if (r.pos && r.pos <= 3) d.podiums++;
        d.rounds[i] = r.pos || r.status;
        if (r.team) teams[r.team] = (teams[r.team] || 0) + r.pts;
      }
    });
    const drivers = [...table.values()].map((d) => ({ ...d, rounds: L.results.map((_, i) => d.rounds[i] ?? null) }))
      .sort((a, b) => b.pts - a.pts || b.wins - a.wins || b.podiums - a.podiums);
    return { drivers, ...(S.format === 'f1' && { teams: TEAM_IDS.map((id) => ({ id, pts: teams[id] || 0 })).sort((a, b) => b.pts - a.pts) }) };
  }

  view(me) {
    const L = this.L, S = L.settings, done = L.round >= L.calendar.length;
    return {
      code: L.code, me: me.id, admin: me.admin, settings: S, calendar: L.calendar, round: L.round, done,
      next: done ? null : { round: L.round, map: L.calendar[L.round], startsAt: L.race ? L.race.startsAt : L.next, in: Object.values(L.members).filter((m) => m.in === L.round).length },
      race: L.race && { round: L.race.round, map: L.race.map, room: L.race.room, startsAt: L.race.startsAt, ticket: L.race.tickets[me.id] || null },
      members: Object.values(L.members).sort((a, b) => a.joined - b.joined)
        .map((m) => ({ ...this.seat(m), admin: m.admin, joined: m.joined, lastSeen: m.lastSeen, in: m.in === L.round })),
      ai: S.aiFill ? L.ai.map((a) => this.seat(a)) : [],
      results: L.results,
      standings: this.standings(),
      feed: L.feed.slice(-30),
      chat: LEAGUE_CHAT,
    };
  }

  // for someone with the code who isn't a member: enough to decide whether to join, and which teams are free
  preview() {
    const L = this.L, S = L.settings, members = Object.values(L.members);
    return {
      code: L.code, preview: true, name: S.name, format: S.format, round: L.round, done: L.round >= L.calendar.length,
      settings: { rounds: S.rounds, laps: S.laps, maxPlayers: S.maxPlayers, night: S.night, aiFill: S.aiFill, oneDriverPerTeam: S.oneDriverPerTeam, private: S.private },
      members: members.length, full: members.length >= S.maxPlayers, taken: S.format === 'f1' ? members.map((m) => m.team) : [],
    };
  }
}
