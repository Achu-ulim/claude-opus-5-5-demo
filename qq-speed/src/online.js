// Online play: the Online screens (quick match, private rooms, join by code or invite link), the room lobby,
// and the glue between the server's messages and the race running in Game.
import { NetClient } from './net.js';
import { encodeSnap, SNAPSHOT_HZ, MAX_PLAYERS, LAP_OPTIONS, CODE_LEN, normCode, cleanName, cleanLook } from './netproto.js';
import { CARS, resolveLook } from './carModel.js';
import { carItemId, item } from './catalog.js';
import { TOKEN } from './garage.js';
import { MAPS, MODES, MAP_TINT } from './maps.js';
import { TEAMS } from './f1.js';
import { trackName } from './leagues.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const SEAT = 'driftbolt.seat'; // { code, token, ticket?, league? } for this tab: a reload takes the same seat back
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const ERRORS = {
  not_found: 'No room with that code. Check it, or ask for a fresh invite.',
  full: `That room is full (${MAX_PLAYERS}/${MAX_PLAYERS}).`,
  taken: 'Could not open a room just now. Try again.',
  kicked: 'The host removed you from the room.',
  not_member: 'That room is a league race: open it from your league to get a seat.',
  replaced: 'This room is open in another tab, so this one left it.',
  session: 'Your login has expired. Log in again to race online.',
  unreachable: 'Can\'t reach the online server. Check your connection and try again.',
  lost: 'Connection to the room was lost.',
  offline: 'Online play isn\'t set up for this copy of the game.',
};

// the build sets __MP_URL__ (see build.mjs): a server address, or "/" for the server on this page's own host
// (the Cloudflare Worker serves both). Unset, local dev falls back to `npm run preview` on port 8787
function serverUrl() {
  const q = new URLSearchParams(location.search).get('mp');
  if (q && LOCAL) return q;
  const built = typeof __MP_URL__ !== 'undefined' ? __MP_URL__ : '';
  if (built.startsWith('/')) return new URL(built, location.href).href.replace(/\/+$/, '');
  return built || (LOCAL ? `ws://${location.hostname}:8787` : '');
}

function loadSeat() { try { return JSON.parse(sessionStorage.getItem(SEAT)) || null; } catch { return null; } }
function saveSeat(v) { try { if (v) sessionStorage.setItem(SEAT, JSON.stringify(v)); else sessionStorage.removeItem(SEAT); } catch { /* ignore */ } }

export class Online {
  constructor(game) {
    this.game = game;
    this.url = serverUrl();
    this.net = null;
    this.room = null; // latest room view from the server
    this.myId = null;
    this.results = null; // results of the race this client is driving in
    this.lastResults = null;
    this.graceEnd = 0;
    this.snapAcc = 0;
    this.busy = false;
    this.bind();
    this.watchPresence();
  }

  get inRoom() { return !!this.room; }
  get me() { return this.room?.players.find((p) => p.id === this.myId); }
  get isHost() { return this.room?.host === this.myId; }
  now() { return this.net ? this.net.now() : Date.now(); }

  // ---------- Screens ----------
  bind() {
    $('onQuick').addEventListener('click', () => this.connect('quick'));
    $('onCreate').addEventListener('click', () => this.connect('create'));
    $('onJoinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = normCode($('onCode').value);
      if (code.length !== CODE_LEN) return this.say('onMsg', `Room codes have ${CODE_LEN} letters and digits.`);
      this.connect('join', code);
    });
    $('onCode').addEventListener('input', (e) => { e.target.value = normCode(e.target.value); });
    const name = $('onName');
    name.addEventListener('change', () => { this.game.league.name = name.value; name.value = this.game.league.name; $('pname').value = name.value; });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    $('onBack').addEventListener('click', () => { this.game.audio.play('click'); this.game.toMenu(); });
    $('rmLeave').addEventListener('click', () => this.leave());
    $('rmReady').addEventListener('click', () => { this.game.audio.play('click'); this.net?.send({ t: 'set', ready: !this.me?.ready }); });
    $('rmStart').addEventListener('click', () => { this.game.audio.play('click'); this.net?.send({ t: 'start' }); });
    $('rmCopy').addEventListener('click', () => this.copyInvite());
    $('rmShare').addEventListener('click', () => this.shareInvite());
    $('rmShare').classList.toggle('hidden', !navigator.share);
    this.shareable = !!navigator.share;
    // no server address in this build: no Multiplayer button (invite links still explain why they can't join)
    $('onlinebtn').classList.toggle('hidden', !this.url);
    $('rmPlayers').addEventListener('click', (e) => {
      const k = e.target.closest('.kick');
      if (k && this.isHost) this.net.send({ t: 'kick', id: k.dataset.id });
    });
    const pick = (el, fn) => $(el).addEventListener('click', (e) => {
      const o = e.target.closest('[data-v]');
      if (!o || !this.isHost || this.room.phase !== 'lobby') return;
      this.game.audio.play('click');
      fn(o.dataset.v);
    });
    pick('rmMaps', (v) => this.net.send({ t: 'cfg', map: v }));
    pick('rmModes', (v) => this.net.send({ t: 'cfg', mode: v }));
    pick('rmLaps', (v) => this.net.send({ t: 'cfg', laps: +v }));
    $('rmCars').addEventListener('click', (e) => {
      const c = e.target.closest('.carcard');
      if (!c || this.me?.racing) return;
      // a car the player hasn't unlocked opens the Garage on it
      if (!this.game.hasCar(+c.dataset.i)) return this.game.garage.open(+c.dataset.i, 'online');
      this.game.audio.play('click');
      this.game.settings.skin = +c.dataset.i;
      this.game.save();
      this.net?.send({ t: 'set', car: +c.dataset.i, look: this.game.lookFor(+c.dataset.i) });
      this.renderCars();
    });
    $('rmCustom').addEventListener('click', () => { if (!this.me?.racing) this.game.garage.open(this.me?.car ?? this.game.settings.skin, 'online'); });
    // countdown to a public room's automatic start, or to a league race's start time
    setInterval(() => { if ((this.room?.autoStartAt || (this.room?.league && !this.room.league.raced)) && !$('online').classList.contains('hidden')) this.renderStatus(); }, 250);
  }

  // how many players have the game open, beside the lobby's Multiplayer button: one socket to the server's Presence
  // object while the game is in view, which hears the count whenever it changes. A tab hidden for 30 s lets go
  // (and stops counting); coming back reconnects. No count is shown while there's no connection.
  watchPresence() {
    if (!this.url) return;
    let ws = null, retry = 0, hideT = 0, wait = 2000;
    const show = (n) => {
      $('onCount').classList.toggle('hidden', !(n > 0));
      if (n > 0) $('onCountN').textContent = n;
    };
    const open = () => {
      clearTimeout(retry);
      if (ws || document.hidden) return;
      let s, ping = 0;
      try { s = new WebSocket(new URL(this.url + '/presence')); } catch { return; }
      ws = s;
      s.onopen = () => { wait = 2000; ping = setInterval(() => s.send('ping'), 30_000); };
      s.onmessage = (e) => {
        if (ws !== s || e.data === 'pong') return;
        try { show(JSON.parse(e.data).n); } catch { /* ignore */ }
      };
      s.onclose = () => {
        clearInterval(ping);
        if (ws !== s) return; // closed on purpose
        ws = null;
        show(0);
        retry = setTimeout(open, wait);
        wait = Math.min(wait * 2, 60_000);
      };
    };
    const close = () => {
      const s = ws;
      ws = null;
      clearTimeout(retry);
      show(0);
      try { s?.close(); } catch { /* ignore */ }
    };
    document.addEventListener('visibilitychange', () => {
      clearTimeout(hideT);
      if (document.hidden) hideT = setTimeout(close, 30_000);
      else open();
    });
    open();
  }

  // the Online screen: the room if we're in one, otherwise quick match / private room / join
  open(msg = '') {
    ['menu', 'pause', 'settings', 'garage', 'chal', 'result', 'cups', 'board', 'f1s', 'f1w', 'f1st', 'lg'].forEach((i) => $(i).classList.add('hidden'));
    $('online').classList.remove('hidden');
    $('onHome').classList.toggle('hidden', this.inRoom);
    $('onRoom').classList.toggle('hidden', !this.inRoom);
    $('onName').value = this.game.league.name;
    this.say('onMsg', msg || (this.url ? '' : ERRORS.offline));
    if (this.inRoom) this.renderRoom();
  }

  say(el, text, bad = true) {
    $(el).textContent = text;
    $(el).classList.toggle('bad', bad && !!text);
  }

  // invite links open the game straight into the room
  boot() {
    const code = normCode(new URLSearchParams(location.search).get('room'));
    if (code.length !== CODE_LEN) return;
    this.open();
    this.connect('join', code);
  }

  // ---------- Connection ----------
  // extra: more for the hello, i.e. a league race's ticket; league: the league code to go back to after its race
  async connect(action, code = null, extra = {}, league = null) {
    if (this.busy) return;
    if (!this.url) return this.say('onMsg', ERRORS.offline);
    this.busy = true;
    this.game.audio.play('click');
    this.say('onMsg', action === 'quick' ? 'Looking for a race…' : action === 'create' ? 'Opening a room…' : `Joining room ${code}…`, false);
    const seat = loadSeat();
    const same = code && seat?.code === code;
    const token = same ? seat.token : null;
    // a league room seats its members by ticket, on every (re)connect
    const ticket = extra.ticket || (same ? seat.ticket : undefined);
    league ||= same ? seat.league : null;
    const net = new NetClient(this.url);
    this.listen(net);
    try {
      const skin = this.game.settings.skin;
      // logged in: the server names this player after their account, checked by the session
      const session = this.game.account.token;
      const w = await net.connect(action, code, { name: this.game.league.name, car: skin, look: this.game.lookFor(skin), ...(ticket && { ticket }), ...(session && { session }) }, token);
      this.net?.leave();
      this.net = net;
      this.myId = w.id;
      this.league = league;
      saveSeat({ code: w.code, token: w.token, ...(ticket && { ticket, league }) });
      history.replaceState(null, '', `${location.pathname}?room=${w.code}`);
    } catch (e) {
      net.leave();
      // a quick match can race another player into the last seat: just look again
      if (action === 'quick' && e.code === 'full' && (this.quickTries = (this.quickTries || 0) + 1) < 4) { this.busy = false; return this.connect('quick'); }
      this.say('onMsg', ERRORS[e.code] || ERRORS.unreachable);
      if (e.code === 'not_found') this.forget();
      if (e.code === 'session') { this.busy = false; return this.game.account.expired(ERRORS.session); }
      // a league's race room that's gone or won't seat us: back to the league
      if (league) { this.busy = false; return this.game.leagues.openHome(league); }
    }
    this.quickTries = 0;
    this.busy = false;
  }

  listen(net) {
    const mine = (fn) => (m) => { if (net === this.net || !this.net) fn(m); };
    net.on('room', mine((m) => this.onRoom(m)))
      .on('status', mine(() => this.renderNet()))
      .on('clock', mine(() => this.renderNet()))
      .on('error', mine((m) => this.drop(m.code)))
      .on('lost', mine(() => this.drop('lost')))
      .on('resume', mine((m) => this.onResume(m)))
      .on('load', mine((m) => this.onLoad(m)))
      .on('go', mine((m) => this.onGo(m)))
      .on('s', mine((m) => this.remote(m.id)?.push(m.p)))
      .on('ev', mine((m) => { const r = this.remote(m.id); if (r) this.game.onNetEvent(r, m); }))
      .on('lap', mine((m) => this.onLap(m)))
      .on('out', mine((m) => this.onOut(m)))
      .on('results', mine((m) => this.onResults(m)));
  }

  forget() {
    saveSeat(null);
    if (new URLSearchParams(location.search).has('room')) history.replaceState(null, '', location.pathname);
  }

  // a league race night: into the room the league opened, with this member's ticket
  joinLeagueRace(room, ticket, league) {
    this.open();
    this.connect('join', room, { ticket }, league);
  }

  // a different driver now (logged in or out): out of the room without a word, staying on whatever screen is showing
  leaveRoom() {
    if (!this.net && !this.room) return;
    this.net?.leave();
    this.net = null;
    this.room = null;
    this.league = null;
    this.forget();
  }

  leave() {
    this.game.audio.play('click');
    this.net?.leave();
    this.net = null;
    this.room = null;
    this.forget();
    this.backHome();
  }

  // out of a room: a league's race goes back to the league, anything else to the Online screen
  backHome(msg = '') {
    const league = this.league;
    this.league = null;
    if (league) this.game.leagues.openHome(league);
    else this.open(msg);
  }

  // the server closed the door (kicked, other tab, gone for good): back to the Online home screen
  drop(code) {
    if (!this.room && code !== 'lost') return;
    this.net?.leave();
    this.net = null;
    this.room = null;
    this.forget();
    if (this.game.race?.online) this.game.toMenu('online');
    this.backHome(ERRORS[code] || ERRORS.lost);
  }

  // ---------- Room ----------
  onRoom(m) {
    const first = !this.room;
    this.room = m;
    if (first) this.open();
    else if (!$('onRoom').classList.contains('hidden')) this.renderRoom();
    // dropped out of a race the game is still showing (left during loading, timed out): the race carries on without us
    const P = this.game.race?.online && this.game.race.seq === m.seq ? this.me : null;
    if (P && !P.racing && m.phase !== 'lobby' && !this.game.resultShown) this.game.hud.finalCount('You are no longer in this race');
  }

  renderRoom() {
    const R = this.room;
    if (!R) return;
    const L = R.league, seats = L ? L.seats : MAX_PLAYERS;
    $('rmCode').textContent = R.code;
    $('rmKind').textContent = L ? `League race · round ${L.round + 1} · ${trackName(R.cfg.map)}` : R.public ? 'Public room' : 'Private room';
    $('rmCount').textContent = `${R.players.length} / ${seats}`;
    // a league room's seats come from the league: no invites, no kicking, and the league sets track, laps and cars
    $('rmCopy').classList.toggle('hidden', !!L);
    $('rmShare').classList.toggle('hidden', !!L || !this.shareable);
    const car = (i) => CARS[i] || CARS[0];
    const hex = (c) => '#' + c.toString(16).padStart(6, '0');
    const team = (p) => p.team && TEAMS.find((t) => t.id === p.team);
    $('rmPlayers').innerHTML = R.players.map((p) => {
      const state = !p.connected ? '<span class="st wait">Reconnecting…</span>' : p.racing ? '<span class="st race">Racing</span>'
        : p.id === R.host && !R.public ? '<span class="st host">Host</span>' : p.ready ? '<span class="st ok">Ready</span>' : '<span class="st">Not ready</span>';
      // public rooms have no Host tag, so a crown marks who can start
      const crown = p.id === R.host && R.public ? '<svg viewBox="0 0 24 24" role="img" aria-label="Host"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>' : '';
      const t = team(p);
      // a tick for players logged in to an account: the server checked who they are
      const vf = p.acct ? '<svg class="vf" viewBox="0 0 24 24" role="img" aria-label="Account"><title>Account</title><path d="M5 12l5 5L20 7"/></svg>' : '';
      return `<div class="rp${p.id === this.myId ? ' me' : ''}"><i class="dot" style="background:${t ? hex(t.dot ?? t.body) : hex(resolveLook(car(p.car), p.look).paint)}"></i>
        <div class="who"><b>${crown}${esc(p.name)}${vf}${p.id === this.myId ? ' <small>(you)</small>' : ''}</b><small>${esc(t ? t.name : car(p.car).name)}</small></div>
        ${state}${this.isHost && !L && p.id !== this.myId ? `<button class="kick" type="button" data-id="${esc(p.id)}" title="Remove from room" aria-label="Remove ${esc(p.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` : ''}</div>`;
    }).join('') + (L ? '<div class="rp empty"><i class="dot"></i><div class="who"><b>Open seat</b><small>A league member who hasn\'t arrived, or an AI driver</small></div></div>'
      : '<div class="rp empty"><i class="dot"></i><div class="who"><b>Open slot</b><small>Invite a friend with the code</small></div></div>').repeat(Math.max(0, seats - R.players.length));
    const edit = this.isHost && R.phase === 'lobby' && !L;
    $('rmSettings').classList.toggle('locked', !edit);
    $('rmHostNote').textContent = L ? 'Set by the league' : this.isHost ? 'You are the host' : 'The host picks the track';
    // a league room shows only what the league set; F1 drivers race their team's car, so there's no car to pick
    const maps = L ? [{ id: R.cfg.map, name: trackName(R.cfg.map), tag: '' }] : MAPS;
    $('rmMaps').innerHTML = maps.map((mp) => `<button type="button" class="rchip${mp.id === R.cfg.map ? ' sel' : ''}" data-v="${mp.id}" title="${mp.tag}"><i style="background:${MAP_TINT[mp.id] || (L ? '#ff4545' : '#888')}"></i>${mp.name}</button>`).join('');
    $('rmModes').innerHTML = MODES.filter((md) => !L || md.id === R.cfg.mode).map((md) => `<button type="button" class="opt${md.id === R.cfg.mode ? ' sel' : ''}" data-v="${md.id}">${md.name}</button>`).join('');
    $('rmLaps').innerHTML = LAP_OPTIONS.filter((l) => !L || l === R.cfg.laps).map((l) => `<button type="button" class="opt${l === R.cfg.laps ? ' sel' : ''}" data-v="${l}" aria-label="${l} lap${l > 1 ? 's' : ''}">${l}</button>`).join('');
    const teamCars = !!this.me?.team;
    $('rmCarHead').classList.toggle('hidden', teamCars);
    $('rmCars').classList.toggle('hidden', teamCars);
    this.renderCars();
    this.renderStatus();
    this.renderNet();
  }

  // the room sees this player's car the way they made it in the garage (the Garage can change the car too;
  // a league room's car is the league's)
  sendLook() {
    if (!this.room || this.me?.racing) return;
    const car = this.room.league ? this.me?.car ?? this.game.settings.skin : this.game.settings.skin;
    this.net?.send({ t: 'set', car, look: this.game.lookFor(car) });
  }

  renderCars() {
    const thumbs = this.game.carThumbs || [];
    const sel = this.me?.car ?? this.game.settings.skin;
    // cars still to unlock show their price
    $('rmCars').innerHTML = CARS.map((c, i) => {
      const forSale = !this.game.hasCar(i);
      return `<div class="carcard${i === sel ? ' sel' : ''}${forSale ? ' forsale' : ''}" data-i="${i}">${thumbs[i] ? `<img src="${thumbs[i]}" alt="${c.name}">` : `<div class="swatch" style="background:#${c.body.toString(16).padStart(6, '0')}"></div>`}<div class="cn">${c.name}</div>${forSale ? `<div class="cp">${TOKEN}${item(carItemId(c.id)).price.toLocaleString('en-US')}</div>` : ''}</div>`;
    }).join('');
    $('rmCars').classList.toggle('locked', !!this.me?.racing || !!this.room?.league);
  }

  renderStatus() {
    const R = this.room;
    if (!R) return;
    const live = R.players.filter((p) => p.connected);
    const guests = live.filter((p) => p.id !== R.host);
    const waiting = (R.public ? live : guests).filter((p) => !p.ready).length;
    const me = this.me;
    let text;
    const L = R.league;
    if (L && R.phase === 'lobby') {
      // a league race: it starts at its set time with whoever is here, or sooner once everyone here is ready
      const left = L.startAt - this.now();
      text = L.raced ? 'This league race is over: the results are in the league\'s standings.'
        : left > 0 ? `League race starts in ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}${live.length >= 2 ? (waiting ? `, or sooner once ${waiting} more racer${waiting > 1 ? 's are' : ' is'} ready` : this.isHost ? '. Everyone is ready: start now if you like.' : ', or sooner when the host starts it.') : '. Your rivals can still join.'}`
          : 'Starting…';
    } else if (R.phase !== 'lobby') text = me?.racing ? 'Race in progress' : `Race in progress on ${MAPS.find((x) => x.id === R.cfg.map)?.name}. You'll join the next one.`;
    else if (live.length < 2) text = R.public ? 'Waiting for more racers to find this room…' : 'Invite at least one friend to race.';
    else if (R.autoStartAt) text = `Starting in ${Math.max(0, Math.ceil((R.autoStartAt - this.now()) / 1000))}…`;
    else if (waiting) text = `Waiting for ${waiting} racer${waiting > 1 ? 's' : ''} to get ready…`;
    else text = R.public ? 'Everyone is ready.' : this.isHost ? 'Everyone is ready. Start when you like.' : 'Everyone is ready. Waiting for the host to start.';
    if (this.lastResults && R.phase === 'lobby') text = `Last race: ${this.lastResults.rows.slice(0, 3).map((r) => `${r.place}. ${r.name}`).join('  ')} · ${text}`;
    this.say('rmMsg', text, false);
    const lobby = R.phase === 'lobby';
    // private rooms: the host starts; guests ready up. Public rooms: everyone readies up and it starts by itself
    const over = !!L?.raced;
    $('rmReady').classList.toggle('hidden', !lobby || over || (this.isHost && !R.public));
    $('rmReady').textContent = me?.ready ? 'Not Ready' : 'Ready';
    $('rmReady').classList.toggle('sec', !!me?.ready);
    $('rmStart').classList.toggle('hidden', !lobby || over || !this.isHost);
    const canStart = live.length >= 2 && guests.every((p) => p.ready);
    $('rmStart').disabled = !canStart;
  }

  renderNet() {
    const n = this.net;
    const text = !n ? '' : n.status === 'online' ? `● ${Math.round(n.rtt)} ms` : n.status === 'reconnecting' ? '◌ Reconnecting…' : n.status === 'connecting' ? '◌ Connecting…' : '✕ Offline';
    const cls = !n || n.status === 'online' ? (n && n.rtt > 180 ? 'slow' : '') : 'bad';
    for (const el of [$('rmNet'), $('netstat')]) {
      el.textContent = text;
      el.className = el.className.replace(/\b(slow|bad)\b/g, '').trim() + (cls ? ' ' + cls : '');
    }
  }

  inviteUrl() { return `${location.origin}${location.pathname}?room=${this.room.code}`; }

  async copyInvite() {
    const url = this.inviteUrl();
    try {
      await navigator.clipboard.writeText(url);
      this.flash('rmCopy', 'Link copied');
    } catch {
      prompt('Copy this invite link:', url);
    }
  }

  async shareInvite() {
    try { await navigator.share({ title: 'Driftbolt', text: `Race me in Driftbolt! Room ${this.room.code}`, url: this.inviteUrl() }); } catch { /* cancelled */ }
  }

  flash(id, text) {
    const b = $(id), was = b.dataset.label || b.textContent;
    b.dataset.label = was;
    b.textContent = text;
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.textContent = was; }, 1600);
  }

  // ---------- Race ----------
  remote(id) { return this.game.race?.online ? this.game.racers.find((r) => r.isRemote && r.netId === id) : null; }
  racingIn(seq) { return this.game.race?.online && this.game.race.seq === seq; }

  async onLoad(m) {
    if (!m.grid.some((g) => g.id === this.myId)) return;
    this.results = null;
    this.graceEnd = 0;
    this.snapAcc = 0;
    $('online').classList.add('hidden');
    // a league grid can hold AI cars for the host's game to drive; this game doesn't drive them yet, so they stay off the
    // track rather than sit on the grid (the server counts an AI car nobody drives as not starting)
    const grid = m.grid.filter((g) => !g.ai).map((g) => ({ id: g.id, name: cleanName(g.name) || 'Driver', car: g.car, team: TEAMS.some((t) => t.id === g.team) ? g.team : undefined, look: cleanLook(g.look) }));
    await this.game.startOnlineRace({ seq: m.seq, cfg: m.cfg, grid, me: this.myId });
    if (this.racingIn(m.seq)) this.net?.send({ t: 'loaded', seq: m.seq });
  }

  onGo(m) {
    if (this.racingIn(m.seq)) this.game.race.startAt = m.startAt;
  }

  // back on the server after a drop: carry on if this game is still in that race, otherwise give the seat in it up
  onResume(m) {
    if (this.racingIn(m.seq)) {
      if (m.startAt) this.game.race.startAt = m.startAt;
    } else this.net.send({ t: 'quit' });
  }

  onLap(m) {
    if (!this.racingIn(m.seq)) return;
    if (m.endAt) this.graceEnd = m.endAt;
    if (m.id === this.myId) {
      if (m.finished) this.game.race.place = m.place;
      return;
    }
    const r = this.remote(m.id);
    if (r) this.game.onRemoteLap(r, m);
  }

  onOut(m) {
    if (!this.racingIn(m.seq)) return;
    const r = this.remote(m.id);
    if (r && !r.finished) {
      r.gone = true;
      this.game.hud.message(`${r.name} left the race`, '#a9bddb', true);
    }
  }

  onResults(m) {
    this.lastResults = m;
    if (this.racingIn(m.seq)) this.results = m;
    else if (this.room) this.renderStatus();
  }

  // per frame while racing: send this car's state SNAPSHOT_HZ times a second
  tick(dt) {
    const g = this.game, P = g.player;
    if (!this.net || !P || !g.race?.startAt) return;
    this.snapAcc += dt;
    if (this.snapAcc < 1 / SNAPSHOT_HZ) return;
    this.snapAcc %= 1 / SNAPSHOT_HZ;
    this.net.send({ t: 's', p: encodeSnap(P, this.net.now()) });
  }

  sendLap(lap, time) { this.net?.send({ t: 'lap', seq: this.game.race.seq, lap, time }); }
  event(ev) { this.net?.send({ t: 'ev', ...ev }); }

  // quit from the pause menu: out of the race, still in the room
  leaveRace() {
    this.net?.send({ t: 'quit' });
    this.backToRoom();
  }

  backToRoom() {
    if (!this.room) return this.game.toMenu();
    this.game.toMenu('online');
  }
}
