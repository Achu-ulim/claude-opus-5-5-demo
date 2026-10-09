// Online play: the Online screens (quick match, private rooms, join by code or invite link), the room lobby,
// and the glue between the server's messages and the race running in Game.
import { NetClient } from './net.js';
import { encodeSnap, SNAPSHOT_HZ, MAX_PLAYERS, LAP_OPTIONS, CODE_LEN, normCode, cleanName } from './netproto.js';
import { CARS } from './carModel.js';
import { MAPS, MODES } from './maps.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const SEAT = 'driftbolt.seat'; // { code, token } for this tab: a reload takes the same seat back
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const ERRORS = {
  not_found: 'No room with that code. Check it, or ask for a fresh invite.',
  full: `That room is full (${MAX_PLAYERS}/${MAX_PLAYERS}).`,
  taken: 'Could not open a room just now. Try again.',
  kicked: 'The host removed you from the room.',
  replaced: 'This room is open in another tab, so this one left it.',
  unreachable: 'Can\'t reach the online server. Check your connection and try again.',
  lost: 'Connection to the room was lost.',
  offline: 'Online play isn\'t set up for this copy of the game.',
};

// the build sets __MP_URL__ (see build.mjs); local dev falls back to `npm run mp:dev` on port 8787
function serverUrl() {
  const q = new URLSearchParams(location.search).get('mp');
  if (q && LOCAL) return q;
  const built = typeof __MP_URL__ !== 'undefined' ? __MP_URL__ : '';
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
    // no server address in this build: no Online button (invite links still explain why they can't join)
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
      this.game.audio.play('click');
      this.game.settings.skin = +c.dataset.i;
      this.game.save();
      this.net?.send({ t: 'set', car: +c.dataset.i });
      this.renderCars();
    });
    // countdown to a public room's automatic start
    setInterval(() => { if (this.room?.autoStartAt && !$('online').classList.contains('hidden')) this.renderStatus(); }, 250);
  }

  // the Online screen: the room if we're in one, otherwise quick match / private room / join
  open(msg = '') {
    ['menu', 'result', 'cups', 'board', 'f1s'].forEach((i) => $(i).classList.add('hidden'));
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
  async connect(action, code = null) {
    if (this.busy) return;
    if (!this.url) return this.say('onMsg', ERRORS.offline);
    this.busy = true;
    this.game.audio.play('click');
    this.say('onMsg', action === 'quick' ? 'Looking for a race…' : action === 'create' ? 'Opening a room…' : `Joining room ${code}…`, false);
    const seat = loadSeat();
    const token = code && seat?.code === code ? seat.token : null;
    const net = new NetClient(this.url);
    this.listen(net);
    try {
      const w = await net.connect(action, code, { name: this.game.league.name, car: this.game.settings.skin }, token);
      this.net?.leave();
      this.net = net;
      this.myId = w.id;
      saveSeat({ code: w.code, token: w.token });
      history.replaceState(null, '', `${location.pathname}?room=${w.code}`);
    } catch (e) {
      net.leave();
      // a quick match can race another player into the last seat: just look again
      if (action === 'quick' && e.code === 'full' && (this.quickTries = (this.quickTries || 0) + 1) < 4) { this.busy = false; return this.connect('quick'); }
      this.say('onMsg', ERRORS[e.code] || ERRORS.unreachable);
      if (e.code === 'not_found') this.forget();
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

  leave() {
    this.game.audio.play('click');
    this.net?.leave();
    this.net = null;
    this.room = null;
    this.forget();
    this.open();
  }

  // the server closed the door (kicked, other tab, gone for good): back to the Online home screen
  drop(code) {
    if (!this.room && code !== 'lost') return;
    this.net?.leave();
    this.net = null;
    this.room = null;
    this.forget();
    if (this.game.race?.online) this.game.toMenu('online');
    this.open(ERRORS[code] || ERRORS.lost);
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
    $('rmCode').textContent = R.code;
    $('rmKind').textContent = R.public ? 'Public room · Quick Match' : 'Private room · invite only';
    $('rmCount').textContent = `${R.players.length}/${MAX_PLAYERS}`;
    const car = (i) => CARS[i] || CARS[0];
    const hex = (c) => '#' + c.toString(16).padStart(6, '0');
    $('rmPlayers').innerHTML = R.players.map((p) => {
      const state = !p.connected ? '<span class="st wait">Reconnecting…</span>' : p.racing ? '<span class="st race">Racing</span>'
        : p.id === R.host && !R.public ? '<span class="st host">Host</span>' : p.ready ? '<span class="st ok">Ready</span>' : '<span class="st">Not ready</span>';
      return `<div class="rp${p.id === this.myId ? ' me' : ''}"><i class="dot" style="background:${hex(car(p.car).body)}"></i>
        <div class="who"><b>${p.id === R.host ? '👑 ' : ''}${esc(p.name)}${p.id === this.myId ? ' <small>(you)</small>' : ''}</b><small>${esc(car(p.car).name)}</small></div>
        ${state}${this.isHost && p.id !== this.myId ? `<button class="kick" data-id="${esc(p.id)}" title="Remove from room" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}</div>`;
    }).join('') + (R.players.length < 2 ? '<div class="rp empty">Waiting for someone to join… send them the invite link.</div>' : '');
    const edit = this.isHost && R.phase === 'lobby';
    $('rmSettings').classList.toggle('locked', !edit);
    $('rmHostNote').textContent = edit ? '' : this.isHost ? '' : 'The host picks the track';
    $('rmMaps').innerHTML = MAPS.map((mp) => `<div class="map${mp.id === R.cfg.map ? ' sel' : ''}" data-id="${mp.id}" data-v="${mp.id}"><div class="nm">${mp.name}</div><div class="tg">${mp.tag}</div></div>`).join('');
    $('rmModes').innerHTML = MODES.map((md) => `<div class="opt${md.id === R.cfg.mode ? ' sel' : ''}" data-v="${md.id}">${md.name}</div>`).join('');
    $('rmLaps').innerHTML = LAP_OPTIONS.map((l) => `<div class="opt${l === R.cfg.laps ? ' sel' : ''}" data-v="${l}">${l} lap${l > 1 ? 's' : ''}</div>`).join('');
    this.renderCars();
    this.renderStatus();
    this.renderNet();
  }

  renderCars() {
    const thumbs = this.game.carThumbs || [];
    const sel = this.me?.car ?? this.game.settings.skin;
    $('rmCars').innerHTML = CARS.map((c, i) => `<div class="carcard${i === sel ? ' sel' : ''}" data-i="${i}">${thumbs[i] ? `<img src="${thumbs[i]}" alt="${c.name}">` : `<div class="swatch" style="background:#${c.body.toString(16).padStart(6, '0')}"></div>`}<div class="cn">${c.name}</div></div>`).join('');
    $('rmCars').classList.toggle('locked', !!this.me?.racing);
  }

  renderStatus() {
    const R = this.room;
    if (!R) return;
    const live = R.players.filter((p) => p.connected);
    const guests = live.filter((p) => p.id !== R.host);
    const waiting = (R.public ? live : guests).filter((p) => !p.ready).length;
    const me = this.me;
    let text;
    if (R.phase !== 'lobby') text = me?.racing ? 'Race in progress' : `Race in progress on ${MAPS.find((x) => x.id === R.cfg.map)?.name}. You'll join the next one.`;
    else if (live.length < 2) text = R.public ? 'Waiting for more racers to find this room…' : 'Invite at least one friend to race.';
    else if (R.autoStartAt) text = `Starting in ${Math.max(0, Math.ceil((R.autoStartAt - this.now()) / 1000))}…`;
    else if (waiting) text = `Waiting for ${waiting} racer${waiting > 1 ? 's' : ''} to get ready…`;
    else text = R.public ? 'Everyone is ready.' : this.isHost ? 'Everyone is ready. Start when you like.' : 'Everyone is ready. Waiting for the host to start.';
    if (this.lastResults && R.phase === 'lobby') text = `Last race: ${this.lastResults.rows.slice(0, 3).map((r) => `${r.place}. ${r.name}`).join('  ')} · ${text}`;
    this.say('rmMsg', text, false);
    const lobby = R.phase === 'lobby';
    // private rooms: the host starts; guests ready up. Public rooms: everyone readies up and it starts by itself
    $('rmReady').classList.toggle('hidden', !lobby || (this.isHost && !R.public));
    $('rmReady').textContent = me?.ready ? 'Not Ready' : 'Ready';
    $('rmReady').classList.toggle('sec', !!me?.ready);
    $('rmStart').classList.toggle('hidden', !lobby || !this.isHost);
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
      this.flash('rmCopy', '✓ Link copied');
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
    const grid = m.grid.map((g) => ({ id: g.id, name: cleanName(g.name) || 'Driver', car: g.car }));
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
