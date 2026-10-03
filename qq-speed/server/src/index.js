// Driftbolt multiplayer server (Cloudflare Workers + Durable Objects).
// The Worker only routes: each room is one Durable Object that owns its lobby, start clock and results,
// and a single Matchmaker object keeps the list of public rooms for Quick Match.
// Cars are simulated by their own clients; the room relays their snapshots and referees laps and the finishing order.
import { DurableObject } from 'cloudflare:workers';
import {
  MAX_PLAYERS, CODE_LEN, CODE_CHARS, RACE_MAPS, RACE_MODES, LAP_OPTIONS, CAR_COUNT, FINISH_GRACE, COUNTDOWN,
  TRACK_LEN, MAX_SPEED, ITEM_EVENTS, validSnap, cleanName, normCode,
} from '../../src/netproto.js';

const LOBBY_GRACE = 10_000; // ms a dropped player keeps their seat in the lobby (page reload, flaky wifi)
const RACE_GRACE = 30_000; // ms a dropped racer stays in the race before counting as a DNF
const LOAD_TIMEOUT = 25_000; // ms to generate the track before the race starts without the stragglers
const START_PAD = 700; // ms between "everyone loaded" and the countdown, so the go message lands everywhere first
const AUTO_START = 5_000; // public rooms start by themselves this long after everyone is ready
const EMPTY_TTL = 60_000; // ms an empty room is kept before its storage is wiped
const MAX_MSG = 2048;
const RATE = 40, BURST = 80; // messages per second per socket
const EVENTS = new Set(ITEM_EVENTS);

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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') return new Response('Driftbolt multiplayer server: ok\n', { headers: { 'content-type': 'text/plain' } });
    if (url.pathname !== '/ws') return new Response('Not found\n', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade\n', { status: 426 });
    if (!originOk(req.headers.get('Origin'), env.ALLOWED_ORIGINS)) return new Response('Origin not allowed\n', { status: 403 });
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
    try { ws.close(4000 + ['not_found', 'full', 'taken', 'kicked'].indexOf(code) + 1, code); } catch { /* ignore */ }
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
  connected() { return this.players.filter((p) => p.connected).sort((a, b) => a.joined - b.joined); }
  entry(id) { const e = this.room.race?.entries[id]; return e && !e.out ? e : null; }

  view() {
    const R = this.room;
    return {
      t: 'room', code: R.code, public: R.public, host: R.hostId, phase: R.phase, cfg: R.cfg, seq: R.seq, autoStartAt: R.autoStartAt,
      players: this.players.sort((a, b) => a.joined - b.joined).map((p) => ({ id: p.id, name: p.name, car: p.car, ready: p.ready, connected: p.connected, racing: !!this.entry(p.id) })),
    };
  }

  // after every change: tell the room, persist, update the public list and the alarm.
  // broadcast = false for changes only the racers hear about, unless something marked the room view dirty
  async commit(broadcast = true) {
    const R = this.room;
    if (!R) return;
    if (broadcast || this.dirty) this.send(this.view());
    this.dirty = false;
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
    if (R.phase === 'race') { t.push(R.race.hardEndAt); if (R.race.endAt) t.push(R.race.endAt); }
    if (R.phase === 'lobby' && R.autoStartAt) t.push(R.autoStartAt);
    if (!this.players.length) t.push(R.emptySince + EMPTY_TTL);
    if (t.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 20, Math.min(...t)));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const R = this.room;
    if (!R) return;
    const now = Date.now();
    if (!this.players.length) {
      if (now - R.emptySince >= EMPTY_TTL) {
        if (R.public) try { await matchmaker(this.env).report(R.code, null); } catch { /* ignore */ }
        await this.ctx.storage.deleteAll();
        this.room = null;
        return;
      }
      return this.schedule();
    }
    for (const p of this.players) if (!p.connected && now - p.goneAt >= (this.entry(p.id) ? RACE_GRACE : LOBBY_GRACE)) this.removePlayer(p.id);
    if (R.phase === 'loading' && now >= R.race.loadDeadline) this.beginRace();
    if (R.phase === 'race' && (now >= R.race.hardEndAt || (R.race.endAt && now >= R.race.endAt))) this.endRace();
    if (R.phase === 'lobby' && R.autoStartAt && now >= R.autoStartAt) {
      R.autoStartAt = 0;
      if (this.everyoneReady()) this.startRace();
    }
    await this.commit();
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
        const e = this.entry(p.id);
        if (!e || R.phase !== 'race' || !validSnap(m.p)) return;
        // laps done + share of the current lap, for ranking racers who don't finish
        e.prog = m.p[12] + m.p[8] / (TRACK_LEN[R.race.cfg.map] || 1);
        const s = JSON.stringify({ t: 's', id: p.id, p: m.p });
        for (const o of this.sockets((id) => id !== p.id && this.entry(id))) this.sendTo(o, s);
        return;
      }
      case 'ev': {
        if (!this.entry(p.id) || R.phase !== 'race' || !EVENTS.has(m.k)) return;
        const ev = { t: 'ev', id: p.id, k: m.k };
        for (const f of ['x', 'y', 'z']) if (Number.isFinite(m[f])) ev[f] = Math.round(m[f] * 100) / 100;
        for (const f of ['bid', 'by', 'target', 'kind']) if (typeof m[f] === 'string' && m[f].length <= 24) ev[f] = m[f];
        const s = JSON.stringify(ev);
        for (const o of this.sockets((id) => id !== p.id && this.entry(id))) this.sendTo(o, s);
        return;
      }
      case 'set':
        if (typeof m.name === 'string') p.name = this.uniqueName(cleanName(m.name) || p.name, p.id);
        if (!this.entry(p.id)) {
          if (m.car !== undefined) p.car = carIdx(m.car);
          if (typeof m.ready === 'boolean') p.ready = m.ready;
        }
        this.checkAutoStart();
        return this.commit();
      case 'cfg':
        if (!host || R.phase !== 'lobby') return;
        if (RACE_MAPS.includes(m.map)) R.cfg.map = m.map;
        if (RACE_MODES.includes(m.mode)) R.cfg.mode = m.mode;
        if (LAP_OPTIONS.includes(m.laps)) R.cfg.laps = m.laps;
        return this.commit();
      case 'start':
        if (!host || R.phase !== 'lobby' || !this.canStart()) return;
        this.startRace();
        return this.commit();
      case 'kick': {
        if (!host || m.id === p.id || !R.players[m.id]) return;
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
      case 'lap':
        if (R.phase !== 'race' || m.seq !== R.seq) return;
        this.lap(p, m);
        return this.commit(false);
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
    const now = Date.now();
    let R = this.room;
    if (!R) {
      if (att.action === 'join') return this.reject(ws, 'not_found');
      R = this.room = {
        code: att.code, public: att.action === 'quick', created: now, hostId: null, phase: 'lobby',
        cfg: { map: 'city', mode: 'speed', laps: 2 }, players: {}, seq: 0, race: null, autoStartAt: 0, emptySince: now,
      };
    } else if (att.action === 'create' && this.players.length) return this.reject(ws, 'taken');
    let p = typeof m.token === 'string' && m.token ? this.players.find((x) => x.token === m.token) : null;
    if (p) {
      // the same player on a new connection: retire the old one
      for (const old of this.sockets((id) => id === p.id)) if (old !== ws) { this.setId(old, null); try { old.close(4005, 'replaced'); } catch { /* ignore */ } }
      p.connected = true;
      p.goneAt = 0;
    } else {
      if (this.players.length >= MAX_PLAYERS) return this.reject(ws, 'full');
      const id = rid(8);
      p = { id, token: rid(24), name: this.uniqueName(cleanName(m.name) || 'Driver', id), car: carIdx(m.car), ready: false, joined: now, connected: true, goneAt: 0 };
      R.players[id] = p;
    }
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

  // ---------- race ----------
  startRace() {
    const R = this.room;
    const racers = this.connected();
    // shuffled grid: no one gets pole position for joining first
    for (let i = racers.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [racers[i], racers[j]] = [racers[j], racers[i]]; }
    R.seq++;
    R.phase = 'loading';
    this.dirty = true;
    R.autoStartAt = 0;
    R.race = {
      seq: R.seq, cfg: { ...R.cfg }, grid: racers.map((p) => p.id), loadDeadline: Date.now() + LOAD_TIMEOUT, startAt: 0, endAt: 0, hardEndAt: 0, firstAt: 0,
      entries: Object.fromEntries(racers.map((p) => [p.id, { name: p.name, car: p.car, loaded: false, out: false, lap: 0, lapTimes: [], finished: false, time: 0, prog: -1 }])),
    };
    this.send({ t: 'load', seq: R.seq, cfg: R.race.cfg, grid: racers.map((p) => ({ id: p.id, name: p.name, car: p.car })) });
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
    if (R.phase === 'race') this.checkRaceOver();
    else if (R.phase === 'loading' && Object.values(R.race.entries).every((x) => x.loaded || x.out)) this.beginRace();
  }

  lap(p, m) {
    const R = this.room, e = this.entry(p.id);
    if (!e || e.finished) return;
    const lap = m.lap, time = m.time;
    if (lap !== e.lap + 1 || !Number.isFinite(time)) return;
    const prev = e.lapTimes.reduce((a, b) => a + b, 0);
    const lapT = time - prev;
    const elapsed = (Date.now() - R.race.startAt) / 1000;
    // a lap quicker than flat out all the way round, or a race clock running ahead of the server's: not believable
    if (lapT < TRACK_LEN[R.race.cfg.map] / MAX_SPEED || time > elapsed + 2) return;
    e.lap = lap;
    e.lapTimes.push(Math.round(lapT * 1000) / 1000);
    const done = lap >= R.race.cfg.laps;
    if (done) {
      e.finished = true;
      e.time = Math.round(time * 1000) / 1000;
      if (!R.race.firstAt) { R.race.firstAt = Date.now(); R.race.endAt = R.race.firstAt + FINISH_GRACE * 1000; }
    }
    const place = done ? Object.values(R.race.entries).filter((x) => x.finished).length : 0;
    this.send({ t: 'lap', seq: R.seq, id: p.id, lap, time: e.time || time, lapT: e.lapTimes[e.lapTimes.length - 1], finished: done, place, endAt: R.race.endAt });
    this.checkRaceOver();
  }

  checkRaceOver() {
    const R = this.room;
    if (R.phase === 'race' && Object.values(R.race.entries).every((e) => e.finished || e.out)) this.endRace();
  }

  endRace() {
    const R = this.room;
    const rows = Object.entries(R.race.entries).map(([id, e]) => ({
      id, name: e.name, car: e.car, finished: e.finished, out: e.out && !e.finished, time: e.time,
      best: e.lapTimes.length ? Math.min(...e.lapTimes) : 0, prog: Math.max(0, Math.round(e.prog * 1000) / 1000),
    }));
    rows.sort((a, b) => (b.finished - a.finished) || (a.finished ? a.time - b.time : (a.out - b.out) || b.prog - a.prog));
    rows.forEach((r, i) => { r.place = i + 1; });
    this.send({ t: 'results', seq: R.seq, laps: R.race.cfg.laps, rows });
    R.phase = 'lobby';
    R.race = null;
    this.dirty = true;
    // ready up again from the lobby, so the next race doesn't start while someone is still reading the results
    for (const p of this.players) p.ready = false;
  }
}
