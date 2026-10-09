// Online leagues: the leagues this player is in, joining one by code or invite link, creating one, and a league's home
// (next race, standings, feed). Talks to the server's /league API (server/src/index.js). Race nights use the normal room
// screens in online.js, with the seat the league hands out.
import { LEAGUE_FORMATS, LEAGUE_NAME_LEN, LEAGUE_LOBBY_OPEN, normLeagueCode, cleanName } from './netproto.js';
import { formatTime } from './util.js';
import { GPS, TEAMS } from './f1.js';
import { CARS } from './carModel.js';
import { MAPS } from './maps.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const STORE = 'driftbolt.leagues'; // [{ code, token, id, name, format }]: the leagues this browser has joined
const SCREENS = ['menu', 'pause', 'settings', 'garage', 'chal', 'result', 'cups', 'board', 'f1s', 'f1w', 'f1st', 'online'];
const ERRORS = {
  not_found: 'No league with that code. Check it, or ask for a fresh invite.',
  bad_code: 'League codes look like L-7QM4.',
  full: 'That league is full.',
  name_taken: 'Someone in that league already races under that name. Pick another driver name.',
  team_taken: 'That team has just been taken. Pick another.',
  bad_name: 'Pick a driver name first.',
  name_registered: 'That name belongs to a registered driver. Log in as them from Settings, or pick another driver name.',
  session: 'Your login has expired. Log in again to join or create leagues.',
  not_member: 'You are no longer in that league.',
  slow_down: 'One message every few seconds.',
  unreachable: 'Can\'t reach the online server. Check your connection and try again.',
  offline: 'Online play isn\'t set up for this copy of the game.',
};

function loadMine() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE));
    return Array.isArray(v) ? v.filter((x) => x && normLeagueCode(x.code) === x.code && /^[a-z0-9]{24}$/.test(x.token)) : [];
  } catch { return []; }
}
function saveMine(list) { try { localStorage.setItem(STORE, JSON.stringify(list)); } catch { /* ignore */ } }

// a calendar entry or room map ('f1-monaco', 'monaco' in an F1 calendar, 'city') as a name
export const trackName = (id) => GPS.find((g) => g.id === String(id).replace(/^f1-/, ''))?.name || MAPS.find((m) => m.id === id)?.name || id;
const teamOf = (id) => TEAMS.find((t) => t.id === id);

// the next start of a weekly race night ({ day 0-6, time 'HH:MM' } in UTC) at or after `from` (same rule as the server)
export function nextNight({ day, time }, from = Date.now()) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(from);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) + ((day - d.getUTCDay() + 7) % 7) * 86_400_000;
  if (at < from) at += 7 * 86_400_000;
  return at;
}
const two = (n) => String(n).padStart(2, '0');
const clock = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;
// race night as the form shows it (this player's day and time) and as the server keeps it (UTC), via its next occurrence
const localNight = (night) => { const d = new Date(nextNight(night)); return { day: d.getDay(), time: clock(d) }; };
function utcNight(day, time) {
  const [h, m] = time.split(':').map(Number);
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((day - now.getDay() + 7) % 7), h, m);
  return { day: d.getUTCDay(), time: `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` };
}
const ONLINE_FOR = 3 * 60_000; // a member seen this recently shows as online (the home polls every 15 s)
const POLL = 15_000;
// "Just now", "5 min ago", "Yesterday"
function ago(t) {
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}
// a round's short label in the table: the GP's code, or the track's first letters
const roundCode = (id) => GPS.find((g) => g.id === String(id).replace(/^f1-/, ''))?.code || trackName(id).slice(0, 3).toUpperCase();
const DAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LAPS = [2, 3, 5];
// what a new league starts with in each format (the design's defaults)
const FORMAT_DEFAULTS = { f1: { rounds: 6, laps: 3, players: 11 }, arcade: { rounds: 8, laps: 2, players: 6 } };
const FORMAT_CARDS = [
  ['f1', 'Formula 1 Championship', 'Grands Prix from the F1 calendar. Each player drives for a team.'],
  ['arcade', 'Arcade Cup', 'Driftbolt tracks with drifts, boosts and items. Any car.'],
];
// race night in this player's time: "Fridays 21:00"
const nightText = (night) => { const d = new Date(nextNight(night)); return `${d.toLocaleDateString('en', { weekday: 'long' })}s ${clock(d)}`; };
// a moment in this player's time: "Fri 21:00"
const whenText = (t) => { const d = new Date(t); return `${d.toLocaleDateString('en', { weekday: 'short' })} ${clock(d)}`; };
// time left: "1D 04:12", "04:12:09", "12:09"
function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}D ${two(h)}:${two(m)}` : h ? `${two(h)}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}

export class Leagues {
  constructor(game, online) {
    this.game = game;
    this.online = online;
    // the HTTP side of the same server the rooms use
    this.base = online.url ? online.url.replace(/^ws/, 'http') : '';
    this.mine = loadMine();
    this.cache = {}; // code → the latest view of each league
    this.from = 'online';
    this.joining = null;
    this.bind();
  }

  // ---------- server ----------
  // every call is a POST (reads too: POST /league/get), so no service worker or HTTP cache ever answers with an old league
  async call(path, body, token) {
    if (!this.base) throw { code: 'offline' };
    let res;
    try {
      res = await fetch(this.base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
      });
    } catch { throw { code: 'unreachable' }; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { code: data.error || 'unreachable', status: res.status };
    return data;
  }

  // logged in: the league names this member after their account (the server checks the session)
  session() { const s = this.game.account.token; return s ? { session: s } : {}; }

  say(text, bad = true) {
    $('lgMsg').textContent = text;
    $('lgMsg').classList.toggle('bad', bad && !!text);
  }

  // a league this browser belongs to: its token, kept in localStorage
  remember(code, member, view) {
    this.mine = this.mine.filter((m) => m.code !== code);
    this.mine.push({ code, token: member.token, id: member.id, name: view.settings.name, format: view.settings.format });
    saveMine(this.mine);
    this.cache[code] = view;
  }

  forget(code) {
    this.mine = this.mine.filter((m) => m.code !== code);
    saveMine(this.mine);
    delete this.cache[code];
  }

  // ---------- screens ----------
  bind() {
    $('onLeagues').addEventListener('click', () => { this.game.audio.play('click'); this.open('online'); });
    $('lgBack').addEventListener('click', () => {
      this.game.audio.play('click');
      if (this.from === 'f1s') this.game.showF1();
      else this.online.open();
    });
    $('lgCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); });
    $('lgJoinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = normLeagueCode($('lgCode').value);
      if (!code) return this.say(ERRORS.bad_code);
      this.preview(code);
    });
    $('lgCards').addEventListener('click', (e) => {
      const c = e.target.closest('.lgcard');
      if (c) { this.game.audio.play('click'); this.openHome(c.dataset.code); }
    });
    $('lgNew').addEventListener('click', () => { this.game.audio.play('click'); this.openCreate(); });
    $('lcBack').addEventListener('click', () => {
      this.game.audio.play('click');
      if (this.editing) this.openHome(this.editing);
      else this.open();
    });
    $('lcName').addEventListener('input', (e) => { this.form.name = e.target.value; this.renderPreview(); });
    $('lcTime').addEventListener('input', (e) => { if (e.target.value) { this.form.time = e.target.value; this.renderPreview(); } });
    $('lcGo').addEventListener('click', () => this.submit());
    $('lcOpenNow').addEventListener('click', () => this.openNow());
    // league home
    $('lhBack').addEventListener('click', () => { this.game.audio.play('click'); this.open(); });
    $('lhSettings').addEventListener('click', () => { this.game.audio.play('click'); if (this.view?.admin) this.openCreate(this.view); });
    $('lhCopy').addEventListener('click', () => this.copyInvite());
    $('lhShare').addEventListener('click', () => this.shareInvite());
    $('lhLeave').addEventListener('click', () => this.leave());
    $('lhNext').addEventListener('click', (e) => {
      if (e.target.closest('#lhIn')) this.toggleIn();
      if (e.target.closest('#lhJoin')) this.joinRace();
    });
    $('lhChat').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-msg]');
      if (b) this.chat(b.dataset.msg);
    });
    $('lgCreate').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (!b || b.disabled) return;
      this.game.audio.play('click');
      const F = this.form, k = b.dataset.k, v = b.dataset.v;
      if (k === 'format') {
        // a new format brings its own choices: keep what still fits, the format's defaults for the rest
        F.format = v;
        const L = LEAGUE_FORMATS[v], D = FORMAT_DEFAULTS[v];
        if (!L.rounds.includes(F.rounds)) F.rounds = D.rounds;
        if (!L.players.includes(F.players)) F.players = D.players;
      } else if (k === 'switch') F[v] = !F[v];
      else F[k] = +v;
      this.renderCreate();
    });
    $('lgJoinBox').addEventListener('click', (e) => {
      const t = e.target.closest('.lgteam');
      if (t && !t.disabled) {
        this.game.audio.play('click');
        this.joining.team = t.dataset.team;
        return this.renderJoinBox();
      }
      if (e.target.closest('#lgJoinGo')) this.join();
      if (e.target.closest('#lgJoinX')) { this.joining = null; this.renderJoinBox(); }
    });
  }

  // where the screen came from decides where Back goes: the F1 hub or the Online screen
  show(view, acc = 'arcade') {
    SCREENS.forEach((i) => $(i).classList.add('hidden'));
    $('lg').classList.remove('hidden');
    $('lg').dataset.acc = acc;
    for (const v of ['lgList', 'lgCreate', 'lgHome']) $(v)?.classList.toggle('hidden', v !== view);
    $('lg').scrollTop = 0;
  }

  open(from = this.from, msg = '') {
    this.from = from;
    this.show('lgList');
    this.say(msg || (this.base ? '' : ERRORS.offline));
    this.renderList();
    this.refreshList();
  }

  // invite links (?league=L-XXXX) open the list with that league ready to join
  boot() {
    const code = normLeagueCode(new URLSearchParams(location.search).get('league'));
    if (!code) return;
    history.replaceState(null, '', location.pathname);
    if (this.mine.some((m) => m.code === code)) return this.openHome(code);
    this.open('online');
    $('lgCode').value = code;
    this.preview(code);
  }

  // ---------- list ----------
  async refreshList() {
    const gone = [];
    await Promise.all(this.mine.map(async (m) => {
      try {
        const v = await this.call('/league/get', { code: m.code }, m.token);
        // the server answers a token it no longer knows with the public preview
        if (v.preview) gone.push(m);
        else this.cache[m.code] = v;
      } catch (e) {
        if (e.code === 'not_found' || e.code === 'not_member') gone.push(m);
      }
    }));
    // a league that was deleted, or that removed this player: off the list
    for (const m of gone) this.forget(m.code);
    if (gone.length) this.say(`${gone.map((m) => m.name).join(', ')}: ${gone.length > 1 ? 'those leagues are' : 'that league is'} no longer yours, so ${gone.length > 1 ? 'they were' : 'it was'} taken off the list.`);
    if (!$('lgList').classList.contains('hidden')) this.renderList();
  }

  renderList() {
    $('lgCards').innerHTML = this.mine.map((m) => {
      const v = this.cache[m.code];
      const f1 = (v?.settings.format || m.format) === 'f1';
      const kind = `${f1 ? 'F1' : 'Arcade'} league · ${m.code}`;
      if (!v || v.preview) return `<button type="button" class="lgcard${f1 ? ' f1' : ''}" data-code="${m.code}"><span class="k">${kind}</span><span class="n">${esc(m.name || m.code)}</span><span class="nx">Loading…</span></button>`;
      const pos = v.standings.drivers.findIndex((d) => d.id === v.me) + 1;
      const mine = v.standings.drivers[pos - 1];
      const next = v.done ? 'Season over' : `Round ${v.round + 1} of ${v.calendar.length} · ${trackName(v.next.map)}`;
      const when = v.race ? '<span class="live">Lobby open</span>' : v.done ? '' : `<span>${whenText(v.next.startsAt)} · in ${countdown(v.next.startsAt - Date.now()).toLowerCase()}</span>`;
      return `<button type="button" class="lgcard${f1 ? ' f1' : ''}" data-code="${m.code}"><span class="k">${kind}${v.admin ? ' · admin' : ''}</span><span class="n">${esc(v.settings.name)}</span>
        <span class="nx">${next}</span><span class="when">${when}<span>${v.round ? `P${pos} · ${mine?.pts ?? 0} pts` : `${v.members.length} driver${v.members.length > 1 ? 's' : ''}`}</span></span></button>`;
    }).join('') || '<p class="lgempty">You aren\'t in a league yet. Create one for your friends, or join one with its code.</p>';
  }

  // ---------- join ----------
  async preview(code) {
    if (this.mine.some((m) => m.code === code)) return this.openHome(code);
    this.say(`Looking up ${code}…`, false);
    try {
      const p = await this.call('/league/get', { code });
      const free = TEAMS.map((t) => t.id).filter((id) => !(p.settings.oneDriverPerTeam && p.taken.includes(id)));
      const fav = TEAMS[this.game.settings.f1?.team]?.id;
      this.joining = { p, team: free.includes(fav) ? fav : free[0] };
      this.say(p.full ? ERRORS.full : '');
      this.renderJoinBox();
    } catch (e) {
      this.joining = null;
      this.renderJoinBox();
      this.say(ERRORS[e.code] || ERRORS.unreachable);
    }
  }

  renderJoinBox() {
    const box = $('lgJoinBox');
    box.classList.toggle('hidden', !this.joining);
    if (!this.joining) return;
    const { p, team } = this.joining, S = p.settings, f1 = p.format === 'f1';
    box.dataset.acc = p.format;
    const pick = f1
      ? `<div class="olab">Pick your team${S.oneDriverPerTeam ? ' <small>one driver per team</small>' : ''}</div><div class="lgteams">${TEAMS.map((t) => {
        const taken = S.oneDriverPerTeam && p.taken.includes(t.id);
        return `<button type="button" class="lgteam${t.id === team ? ' sel' : ''}" data-team="${t.id}" style="--tc:${hex(t.dot ?? t.body)}" aria-pressed="${t.id === team}"${taken ? ' disabled' : ''}>
          <span class="liv"><i style="background:${hex(t.body)}"></i><i style="background:${hex(t.trim)}"></i></span><b>${t.name}</b>${taken ? '<small>Taken</small>' : ''}</button>`;
      }).join('')}</div>`
      : `<p class="lgnote">You'll race your lobby car, the <b>${CARS[this.game.settings.skin]?.name || CARS[0].name}</b>, all season.</p>`;
    box.innerHTML = `<div class="lgjh"><div><span class="k">${f1 ? 'F1' : 'Arcade'} league · ${p.code}</span><b>${esc(p.name)}</b>
        <small>${p.members} of ${S.maxPlayers} drivers · ${nightText(S.night)} your time · ${S.rounds} rounds · ${S.laps} laps${S.aiFill ? ' · AI fill the empty seats' : ''}</small></div>
        <button class="lgx" id="lgJoinX" type="button" aria-label="Close" title="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      ${p.done ? '<p class="lgnote">This league\'s season is over.</p>' : pick}
      <div class="lgjrow"><label for="lgJName">Driver name</label><input id="lgJName" maxlength="16" autocomplete="off" spellcheck="false" value="${esc(this.game.league.name)}"${this.game.account.user ? ' readonly title="Your account name"' : ''}>
        <button class="lgcreate" id="lgJoinGo" type="button"${p.full || p.done ? ' disabled' : ''}>Join league</button></div>`;
  }

  async join() {
    const { p, team } = this.joining;
    const name = cleanName($('lgJName').value);
    if (!name) return this.say(ERRORS.bad_name);
    this.game.league.name = name; // the driver name everywhere else, too
    $('lgJoinGo').disabled = true;
    this.say(`Joining ${p.name}…`, false);
    try {
      const r = await this.call('/league/join', { code: p.code, name, ...(p.format === 'f1' ? { team } : { car: this.game.settings.skin }), ...this.session() });
      this.remember(r.code, r.member, r.league);
      this.joining = null;
      this.renderJoinBox();
      $('lgCode').value = '';
      this.openHome(r.code);
    } catch (e) {
      this.say(ERRORS[e.code] || ERRORS.unreachable);
      if (e.code === 'session') this.game.account.expired(ERRORS.session);
      // someone took the team meanwhile: show the grid as it is now
      if (e.code === 'team_taken') this.preview(p.code);
      else $('lgJoinGo').disabled = false;
    }
  }

  // ---------- create, and an admin's settings (the same form) ----------
  openCreate(edit = null) {
    const S = edit?.settings;
    const night = S ? localNight(S.night) : { day: 5, time: '20:00' };
    this.editing = edit ? edit.code : null;
    this.form = S
      ? { name: S.name, format: S.format, rounds: S.rounds, laps: S.laps, players: S.maxPlayers, ...night, aiFill: S.aiFill, oneDriverPerTeam: S.oneDriverPerTeam, private: S.private, ghost: S.ghost }
      : { name: 'Friday Night Grand Prix', format: 'f1', ...FORMAT_DEFAULTS.f1, ...night, aiFill: true, oneDriverPerTeam: true, private: true, ghost: false };
    this.show('lgCreate', this.form.format);
    $('lcName').value = this.form.name;
    $('lcTime').value = this.form.time;
    $('lcTitle').textContent = edit ? 'League settings' : 'Create a league';
    $('lcLab').textContent = edit ? `${edit.code} · admin` : 'Online';
    $('lcGo').textContent = edit ? 'Save changes' : 'Create league';
    $('lcInv').innerHTML = edit
      ? `<div class="olab">Invite code</div><b>${edit.code}</b><small>The format${edit.round || edit.race ? ' and the number of rounds are' : ' is'} fixed now that drivers have joined${edit.round || edit.race ? ' and racing has started' : ''}.</small>`
      : '<div class="olab">Invite code (after creating)</div><b>L-????</b><small>Friends join with the code or the invite link.</small>';
    $('lcMsg').textContent = '';
    // an admin can open tonight's room early (it starts five minutes later, or once everyone in it is ready)
    $('lcOpenNow').classList.toggle('hidden', !edit || edit.done || !!edit.race);
    this.renderCreate();
  }

  renderCreate() {
    const F = this.form, f1 = F.format === 'f1', L = LEAGUE_FORMATS[F.format];
    const E = this.editing && this.cache[this.editing];
    $('lg').dataset.acc = F.format;
    const pressed = (on) => `${on ? ' sel' : ''}" aria-pressed="${on}`;
    $('lcFormats').innerHTML = FORMAT_CARDS.map(([k, name, desc]) => `<button type="button" class="lgfmt ${k}${pressed(F.format === k)}" data-k="format" data-v="${k}"${E ? ' disabled' : ''}><b>${name}</b><span>${desc}</span></button>`).join('');
    const seg = (el, key, list, locked = () => false) => {
      $(el).innerHTML = list.map((v) => `<button type="button" class="opt${pressed(v === F[key])}" data-k="${key}" data-v="${v}"${locked(v) ? ' disabled' : ''}>${v}</button>`).join('');
    };
    // once racing has started the calendar can't change; seats can't drop below the drivers already in
    seg('lcRounds', 'rounds', L.rounds, () => !!E && (E.round > 0 || !!E.race));
    seg('lcLaps', 'laps', LAPS);
    seg('lcPlayers', 'players', L.players, (v) => !!E && v < E.members.length);
    $('lcDays').innerHTML = DAYS.map((d) => `<button type="button" class="lgday${pressed(d === F.day)}" data-k="day" data-v="${d}">${DAY_NAMES[d]}</button>`).join('');
    const sw = (key, name, desc, fixed) => `<div class="lgsw"><span><b>${name}</b><small>${desc}</small></span>
      <button type="button" class="switch" role="switch" data-k="switch" data-v="${key}" aria-checked="${fixed ?? F[key]}" aria-label="${name}"${fixed !== undefined ? ' disabled' : ''}><i></i></button></div>`;
    $('lcSwitches').innerHTML = [
      sw('aiFill', 'Fill the grid with AI', 'Empty seats get AI drivers'),
      // arcade members keep the car they join with: shown, but not a choice
      f1 ? sw('oneDriverPerTeam', 'One driver per team', 'Players pick a free team when they join') : sw('lockCar', 'Lock car for the season', 'Players keep the car they join with', true),
      sw('private', 'Private league', 'Only people with the code can join'),
      sw('ghost', 'Late players race a ghost', 'Missed a round? Set a time later in the week'),
    ].join('');
    this.renderPreview();
  }

  renderPreview() {
    const F = this.form, f1 = F.format === 'f1';
    const pts = LEAGUE_FORMATS[F.format].points;
    $('lcPName').textContent = cleanName(F.name, LEAGUE_NAME_LEN) || 'Your league';
    const rows = [
      ['Format', f1 ? 'Formula 1' : 'Arcade Cup'],
      ['Calendar', `${F.rounds} rounds · ${F.laps} laps`],
      ['Race night', nightText(utcNight(F.day, F.time))],
      ['Grid', `${F.players} players${F.aiFill ? ' + AI' : ''}`],
      ['Points', `${pts.slice(0, 3).join(' · ')} …`],
    ];
    // the creator drives the team picked in the F1 hub, or the lobby car
    if (!this.editing) rows.push(['You drive', f1 ? TEAMS[this.game.settings.f1.team]?.name || TEAMS[0].name : CARS[this.game.settings.skin]?.name || CARS[0].name]);
    $('lcSum').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
  }

  async submit() {
    const F = this.form;
    const name = cleanName(F.name, LEAGUE_NAME_LEN);
    if (!name) return ($('lcMsg').textContent = 'Give the league a name.');
    if (!/^\d\d:\d\d$/.test(F.time)) return ($('lcMsg').textContent = 'Pick a start time.');
    const settings = { name, format: F.format, rounds: F.rounds, laps: F.laps, maxPlayers: F.players, night: utcNight(F.day, F.time), aiFill: F.aiFill, oneDriverPerTeam: F.oneDriverPerTeam, private: F.private, ghost: F.ghost };
    $('lcGo').disabled = true;
    $('lcMsg').textContent = this.editing ? 'Saving…' : 'Creating your league…';
    try {
      if (this.editing) {
        const code = this.editing, m = this.mine.find((x) => x.code === code);
        this.cache[code] = await this.call('/league/update', { code, settings }, m.token);
        m.name = name;
        saveMine(this.mine);
        this.openHome(code);
      } else {
        const driver = cleanName(this.game.league.name) || 'Driver';
        const player = F.format === 'f1' ? { name: driver, team: (TEAMS[this.game.settings.f1.team] || TEAMS[0]).id } : { name: driver, car: this.game.settings.skin };
        const r = await this.call('/league/create', { ...settings, player, ...this.session() });
        this.remember(r.code, r.member, r.league);
        this.openHome(r.code, true);
      }
    } catch (e) {
      $('lcMsg').textContent = e.code === 'team_taken' ? 'Two drivers already share a team, so "one driver per team" can\'t be switched on.'
        : ERRORS[e.code] || `That didn't work (${e.code}).`;
      if (e.code === 'session') this.game.account.expired(ERRORS.session);
    }
    $('lcGo').disabled = false;
  }

  // ---------- a league's home ----------
  get view() { return this.cache[this.home]; }
  homeOpen() { return !$('lg').classList.contains('hidden') && !$('lgHome').classList.contains('hidden'); }
  token(code = this.home) { return this.mine.find((m) => m.code === code)?.token; }

  async openHome(code, created = false) {
    const m = this.mine.find((x) => x.code === code);
    if (!m) return this.open();
    this.home = code;
    this.show('lgHome', this.cache[code]?.settings?.format || m.format);
    $('lhMsg').textContent = created ? `League created. Invite your friends with the code ${code}, or send them the invite link.` : '';
    if (this.cache[code] && !this.cache[code].preview) this.renderHome();
    else {
      $('lhName').textContent = m.name;
      $('lhLab').textContent = 'Loading…';
      for (const id of ['lhNext', 'lhHead', 'lhBody', 'lhFeed', 'lhChat']) $(id).innerHTML = '';
    }
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.onTick(), 1000);
    await this.refreshHome();
  }

  async refreshHome() {
    const code = this.home;
    this.lastFetch = Date.now();
    try {
      const v = await this.call('/league/get', { code }, this.token(code));
      if (v.preview) {
        this.forget(code);
        return this.homeOpen() && this.open(this.from, ERRORS.not_member);
      }
      this.cache[code] = v;
      if (this.homeOpen() && this.home === code) this.renderHome();
    } catch (e) {
      if (e.code === 'not_found') {
        this.forget(code);
        return this.homeOpen() && this.open(this.from, 'That league no longer exists.');
      }
      if (this.homeOpen()) $('lhMsg').textContent = ERRORS[e.code] || ERRORS.unreachable;
    }
  }

  // every second while the home shows: the countdown, a refresh every POLL, and one as soon as the lobby should be open
  onTick() {
    if (!this.homeOpen()) { clearInterval(this.ticker); this.ticker = 0; return; }
    const v = this.view;
    if (!v || v.preview) return;
    this.renderCountdown();
    const opensAt = v.next && !v.race ? v.next.startsAt - LEAGUE_LOBBY_OPEN : Infinity;
    const since = Date.now() - (this.lastFetch || 0);
    if (since > POLL || (Date.now() >= opensAt && since > 3000)) this.refreshHome();
  }

  renderHome() {
    const v = this.view, S = v.settings, f1 = S.format === 'f1';
    $('lg').dataset.acc = S.format;
    const n = v.members.length, ai = S.aiFill ? Math.max(0, S.maxPlayers - n) : 0;
    $('lhLab').textContent = `${f1 ? 'F1' : 'Arcade'} league · ${n} player${n === 1 ? '' : 's'}${ai ? ` + ${ai} AI` : ''}${v.admin ? ' · you are admin' : ''}`;
    $('lhName').textContent = S.name;
    $('lhCode').textContent = v.code;
    $('lhSettings').classList.toggle('hidden', !v.admin);
    $('lhShare').classList.toggle('hidden', !navigator.share);
    this.renderNext();
    this.renderTable();
    this.renderFeed();
    $('lhChat').innerHTML = v.chat.map((c) => `<button type="button" data-msg="${esc(c)}">${esc(c)}</button>`).join('');
  }

  renderNext() {
    const v = this.view, S = v.settings;
    if (v.done) {
      const champ = v.standings.drivers[0];
      $('lhNext').innerHTML = `<div class="lhrd"><span class="lhk">Season</span><b>OVER</b></div>
        <div><div class="lhgp">${champ ? `${esc(this.who(champ))} ${champ.id === v.me ? 'are' : 'is'} champion` : 'Season over'}</div><div class="lhsub">All ${v.calendar.length} rounds raced. ${champ ? `${champ.pts} points, ${champ.wins} win${champ.wins === 1 ? '' : 's'}.` : ''}</div></div><div></div>`;
      return;
    }
    const x = v.next, race = v.race, me = v.members.find((m) => m.id === v.me);
    const start = new Date(race ? race.startsAt : x.startsAt);
    const sub = `${start.toLocaleDateString('en', { weekday: 'long' })} ${clock(start)} · ${S.laps} lap${S.laps === 1 ? '' : 's'} · ${race ? 'the lobby is open' : 'lobby opens 15 minutes before'} · ${x.in} player${x.in === 1 ? ' says' : 's say'} they're in`;
    const btn = race
      ? '<button class="lhbig join" id="lhJoin" type="button">Join race</button>'
      : `<button class="lhbig" id="lhIn" type="button" aria-pressed="${!!me?.in}">${me?.in ? '✓ I\'m in' : 'I\'m in'}</button>`;
    $('lhNext').innerHTML = `<div class="lhrd"><span class="lhk">Round</span><b>${x.round + 1}/${v.calendar.length}</b></div>
      <div><div class="lhgp">${esc(trackName(x.map))}</div><div class="lhsub">${sub}</div></div>
      <div class="lhgo"><div class="lhcd"><span class="lhk" id="lhCdK">Starts in</span><b id="lhCount"></b></div>${btn}</div>`;
    this.renderCountdown();
  }

  renderCountdown() {
    const v = this.view, el = $('lhCount');
    if (!el || !v?.next) return;
    const left = (v.race ? v.race.startsAt : v.next.startsAt) - Date.now();
    el.textContent = left > 0 ? countdown(left) : 'NOW';
    $('lhCdK').textContent = left > 0 ? 'Starts in' : 'Racing';
  }

  who(d) { return d.ai ? `AI · ${d.name}` : d.id === this.view.me ? 'You' : d.name; }

  // drivers by points: an online dot, team (F1) or car (arcade), a chip per round raced, and points
  renderTable() {
    const v = this.view, S = v.settings, f1 = S.format === 'f1';
    const scoring = LEAGUE_FORMATS[S.format].points.length;
    const old = (k) => (k < v.results.length - 2 ? ' old' : '');
    $('lhHead').innerHTML = `<tr><th>Pos</th><th>Player</th><th>${f1 ? 'Team' : 'Car'}</th>${v.results.map((r, k) => `<th class="r${old(k)}" title="Round ${r.round + 1}: ${esc(trackName(r.map))}">${roundCode(r.map)}</th>`).join('')}<th>Pts</th></tr>`;
    const chip = (p) => (p === null ? '<span class="chip none">–</span>'
      : typeof p === 'string' ? `<span class="chip ${p === 'DNS' ? 'dns' : 'out'}">${p}</span>`
        : `<span class="chip${p === 1 ? ' p1' : p <= 3 ? ' pod' : p > scoring ? ' out' : ''}">P${p}</span>`);
    $('lhBody').innerHTML = v.standings.drivers.map((d, i) => {
      const member = v.members.find((m) => m.id === d.id);
      const dot = d.ai ? 'ai' : d.id === v.me || (member && Date.now() - member.lastSeen < ONLINE_FOR) ? 'on' : '';
      const t = f1 ? teamOf(d.team) : null, car = f1 ? null : CARS[d.car];
      const color = t ? hex(t.dot ?? t.body) : car ? hex(car.body) : '#7c7f99';
      const label = t ? t.name : car ? car.name : '';
      const state = dot === 'on' ? 'online' : dot === 'ai' ? 'AI driver' : 'offline';
      return `<tr${d.id === v.me ? ' class="me"' : ''} style="--tc:${color};--tcb:${color}24;--tce:${color}80"><td>${i + 1}</td>
        <td><span class="pl"><i class="${dot}" title="${state}" aria-label="${state}"></i>${esc(this.who(d))}${d.id === v.me ? ` <small>${esc(d.name)}</small>` : ''}${!d.ai && !member ? ' <small>left</small>' : ''}</span></td>
        <td><span class="tm"><i></i><span>${esc(label)}</span></span></td>${d.rounds.map((p, k) => `<td class="r${old(k)}">${chip(p)}</td>`).join('')}<td>${d.pts}</td></tr>`;
    }).join('');
  }

  feedText(f) {
    const n = esc(f.ai ? `AI · ${f.name}` : f.id === this.view.me ? 'You' : f.name || '');
    const acc = this.view.settings.format === 'f1' ? '#ff4545' : '#36e2ff';
    const at = f.map ? esc(trackName(f.map)) : '';
    switch (f.k) {
      case 'create': return [`${n} started the league`, acc];
      case 'join': return [`${n} joined the league`, '#7cff9e'];
      case 'leave': return [`${n} left the league`, '#a3a6bf'];
      case 'kick': return [`${n} ${f.id === this.view.me ? 'were' : 'was'} removed from the league`, '#a3a6bf'];
      case 'settings': return ['The admin changed the league settings', '#a3a6bf'];
      case 'lobby': return [`Round ${f.round + 1} lobby is open: ${at}, lights out at ${clock(new Date(f.startsAt))}`, acc];
      case 'win': return [`${n} won round ${f.round + 1} at ${at}`, '#ffd23a'];
      case 'fastest': return [`${n} set the fastest lap at ${at}: ${formatTime(f.time)}`, '#36e2ff'];
      case 'postponed': return [`Nobody made it to round ${f.round + 1}: ${at} moves to the next race night`, '#ff4545'];
      case 'champion': return [`${n} ${f.id === this.view.me ? 'are' : 'is'} the champion!`, '#ffd23a'];
      case 'chat': return [`${n}: “${esc(f.msg)}”`, '#a3a6bf'];
      default: return ['', ''];
    }
  }

  // oldest first, newest at the bottom (scrolled into view)
  renderFeed() {
    const items = this.view.feed.map((f) => [this.feedText(f), f.at]).filter(([[text]]) => text)
      .map(([[text, c], at]) => `<li style="--c:${c}"><div><span>${text}</span><small>${ago(at)}</small></div></li>`);
    const el = $('lhFeed');
    el.innerHTML = items.join('') || '<li style="--c:#7c7f99"><div><span>Nothing has happened yet.</span></div></li>';
    el.scrollTop = el.scrollHeight;
  }

  // ---------- actions ----------
  async act(path, body, done) {
    try {
      const v = await this.call(path, { code: this.home, ...body }, this.token());
      this.cache[this.home] = v;
      $('lhMsg').textContent = '';
      if (done) done(v);
      else if (this.homeOpen()) this.renderHome();
    } catch (e) {
      $('lhMsg').textContent = ERRORS[e.code] || `That didn't work (${e.code}).`;
    }
  }

  toggleIn() {
    this.game.audio.play('click');
    const me = this.view.members.find((m) => m.id === this.view.me);
    this.act('/league/in', { in: !me?.in });
  }

  chat(msg) {
    this.game.audio.play('click');
    this.act('/league/chat', { msg });
  }

  inviteUrl() { return `${location.origin}${location.pathname}?league=${this.home}`; }

  async copyInvite() {
    try {
      await navigator.clipboard.writeText(this.inviteUrl());
      this.online.flash('lhCopy', 'Link copied');
    } catch {
      prompt('Copy this invite link:', this.inviteUrl());
    }
  }

  async shareInvite() {
    try { await navigator.share({ title: 'Driftbolt', text: `Join my Driftbolt league, ${this.view.settings.name}: code ${this.home}`, url: this.inviteUrl() }); } catch { /* cancelled */ }
  }

  async leave() {
    const v = this.view;
    if (!confirm(`Leave ${v.settings.name}? Your results stay in its standings, but you'd need the code to come back${v.admin ? ', and the admin role passes to the next member' : ''}.`)) return;
    try {
      await this.call('/league/leave', { code: this.home }, this.token());
      this.forget(this.home);
      this.open(this.from, `You left ${v.settings.name}.`);
    } catch (e) {
      $('lhMsg').textContent = ERRORS[e.code] || ERRORS.unreachable;
    }
  }

  async openNow() {
    const code = this.editing;
    $('lcOpenNow').disabled = true;
    try {
      this.cache[code] = await this.call('/league/open', { code }, this.token(code));
      this.openHome(code);
    } catch (e) {
      $('lcMsg').textContent = ERRORS[e.code] || `That didn't work (${e.code}).`;
    }
    $('lcOpenNow').disabled = false;
  }

  // ---------- race night ----------
  // the lobby is open: into the league's race room with this member's ticket (the room screens are online.js's)
  joinRace() {
    const r = this.view?.race;
    if (!r?.ticket) {
      $('lhMsg').textContent = 'Your seat for tonight isn\'t ready yet. Try again in a moment.';
      return this.refreshHome();
    }
    this.online.joinLeagueRace(r.room, r.ticket, this.home);
  }
}
