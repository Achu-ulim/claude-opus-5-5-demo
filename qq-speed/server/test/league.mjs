// End-to-end check of online leagues against a running server: create → join → race night in a league room → result → standings.
// Start the server first (npm run preview, which is wrangler dev on port 8787), then: npm run test:league [-- base URL]
// One race is driven for real over WebSockets, so it takes about as long as a lap can be driven (~30 s). It cleans up after itself.
import { TRACK_LEN, MAX_SPEED, LEAGUE_FORMATS } from '../../src/netproto.js';

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
let failures = 0;
const check = (cond, what, extra) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${!cond && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON (e.g. a 204) */ }
  return { status: res.status, body: json, headers: res.headers };
}

// a racer's connection to a room: messages queue up until a test step waits for one of a type
function racer(room) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?action=join&room=${room}`, { headers: { Origin: ORIGIN } });
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
    next(t, pred = () => true, ms = 15_000) {
      const i = inbox.findIndex((m) => m.t === t && pred(m));
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { t, pred, resolve };
        waiting.push(w);
        setTimeout(() => { if (waiting.includes(w)) reject(new Error(`no '${t}' message within ${ms} ms`)); }, ms);
      });
    },
    async hello(ticket) { await opened; this.send({ t: 'hello', ticket, name: 'ignored', car: 9 }); return this.next(ticket ? 'welcome' : 'error'); },
    close: () => ws.close(),
  };
}

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`No server at ${BASE}. Start one with: npm run preview`);
    process.exit(2);
  }

  // ---------- validation ----------
  const night = { day: 5, time: '20:00' };
  const arcade = { name: 'Test Night', format: 'arcade', rounds: 4, laps: 1, maxPlayers: 4, night, aiFill: true, oneDriverPerTeam: false, private: true, ghost: false };
  let r = await api('/league/create', { ...arcade, format: 'kart', player: { name: 'Alice', car: 0 } });
  check(r.status === 400 && r.body.error === 'bad_format', 'create: unknown format is refused', r.body);
  r = await api('/league/create', { ...arcade, name: '<<>>', player: { name: 'Alice', car: 0 } });
  check(r.status === 400 && r.body.error === 'bad_name', 'create: a name that cleans to nothing is refused', r.body);
  r = await api('/league/create', { ...arcade, night: { day: 7, time: '25:00' }, player: { name: 'Alice', car: 0 } });
  check(r.status === 400 && r.body.error === 'bad_night', 'create: bad race night is refused', r.body);
  r = await api('/league/create', { ...arcade, maxPlayers: 11, player: { name: 'Alice', car: 0 } });
  check(r.status === 400 && r.body.error === 'bad_maxPlayers', 'create: 11 seats is F1 only', r.body);
  r = await api('/league?code=L-0O1I');
  check(r.status === 400 && r.body.error === 'bad_code', 'get: a code with characters outside the code set is refused', r.body);
  r = await api('/league/explode', { code: 'L-2345' });
  check(r.status === 404, 'unknown action → 404', r.status);
  r = await api('/league?code=L-2345', null, null, { Origin: 'https://evil.example' });
  check(r.status === 403, 'a page not on ALLOWED_ORIGINS is refused', r.status);
  r = await api('/league?code=L-2345', null, null, { Origin: 'https://driftbolt.netlify.app' });
  check(r.headers.get('access-control-allow-origin') === 'https://driftbolt.netlify.app', 'an allowed page gets CORS headers', r.headers.get('access-control-allow-origin'));

  // ---------- an arcade league: create, join ----------
  r = await api('/league/create', { ...arcade, name: '  Test   Night <b>', player: { name: 'Alice', car: 0 } });
  check(r.status === 200 && /^L-[A-HJ-NP-Z2-9]{4}$/.test(r.body.code), 'create: an L-XXXX code', r.body);
  const code = r.body.code, alice = r.body.member.token;
  check(r.body.league.admin === true && r.body.league.settings.name === 'Test Night b', 'create: the creator is admin and the name is cleaned', r.body.league?.settings?.name);
  check(r.body.league.calendar.length === 4, 'create: a 4-round calendar', r.body.league.calendar);

  r = await api(`/league?code=${code.toLowerCase().replace('-', ' ')}`);
  check(r.status === 200 && r.body.preview && r.body.members === 1, 'get without a token: a preview (code typed loosely)', r.body);
  r = await api('/league/join', { code, name: 'Bob', car: 3 });
  check(r.status === 200 && r.body.member?.token, 'join: Bob', r.body);
  const bob = r.body.member.token, bobId = r.body.member.id;
  r = await api('/league/join', { code, name: 'ALICE', car: 1 });
  check(r.status === 409 && r.body.error === 'name_taken', 'join: a name already in the league is refused', r.body);
  r = await api('/league/join', { code, name: 'Eve', car: 99 });
  check(r.status === 400 && r.body.error === 'bad_car', 'join: a car that does not exist is refused', r.body);
  r = await api('/league/join', { code, name: 'Cara', car: 5 });
  check(r.status === 200, 'join: Cara (who will not turn up)', r.body);
  const cara = r.body.member.token;
  r = await api('/league/join', { code, name: 'Dan', car: 2 });
  check(r.status === 200, 'join: Dan fills the fourth seat', r.body);
  const danId = r.body.member.id;
  r = await api('/league/join', { code, name: 'Fay', car: 2 });
  check(r.status === 409 && r.body.error === 'full', 'join: a full league is refused', r.body);

  // ---------- members, admins ----------
  r = await api('/league/kick', { code, member: danId }, bob);
  check(r.status === 403 && r.body.error === 'not_admin', 'kick: only the admin', r.body);
  r = await api('/league/kick', { code, member: danId }, alice);
  check(r.status === 200 && !r.body.members.some((m) => m.id === danId), 'kick: the admin removes Dan', r.body.members);
  r = await api('/league/update', { code, settings: { laps: 2 } }, bob);
  check(r.status === 403, 'update: only the admin', r.body);
  r = await api('/league/update', { code, settings: { format: 'f1', maxPlayers: 6, rounds: 6 } }, alice);
  check(r.status === 409 && r.body.error === 'started', 'update: the format stays what members joined', r.body);
  r = await api('/league/update', { code, settings: { private: false, night: { day: 6, time: '19:30' } } }, alice);
  check(r.status === 200 && r.body.settings.night.day === 6 && r.body.settings.private === false, 'update: night and privacy', r.body.settings);
  r = await api('/league/chat', { code, msg: 'hello <script>' }, bob);
  check(r.status === 400 && r.body.error === 'bad_msg', 'chat: free text is refused', r.body);
  r = await api('/league/chat', { code, msg: 'GG' }, bob);
  check(r.status === 200 && r.body.feed.some((f) => f.k === 'chat' && f.msg === 'GG'), 'chat: a quick-chat message lands in the feed', r.body.feed);
  r = await api('/league/chat', { code, msg: 'Nice lap' }, bob);
  check(r.status === 429, 'chat: too fast is refused', r.status);
  r = await api('/league/in', { code, in: true }, alice);
  check(r.status === 200 && r.body.next.in === 1, '"I\'m in" counts for the next round', r.body.next);
  r = await api('/league?code=' + code, null, 'x'.repeat(24));
  check(r.status === 200 && r.body.preview, 'a token that is not a member only gets the preview', r.body);

  // ---------- race night ----------
  r = await api('/league/open', { code }, bob);
  check(r.status === 403, 'open: only the admin', r.body);
  r = await api('/league/open', { code }, alice);
  check(r.status === 200 && r.body.race?.room && r.body.race.ticket, 'open: a race room and a ticket for the admin', r.body.race);
  const room = r.body.race.room, map = r.body.race.map, aliceTicket = r.body.race.ticket;
  r = await api('/league/open', { code }, alice);
  check(r.status === 409 && r.body.error === 'race_open', 'open: one race at a time', r.body);
  r = await api('/league?code=' + code, null, bob);
  const bobTicket = r.body.race?.ticket;
  check(bobTicket && bobTicket !== aliceTicket, 'get: Bob has his own ticket', r.body.race);

  const stranger = racer(room);
  const err = await stranger.hello(null);
  check(err.code === 'not_member', 'a league room turns away anyone without a ticket', err);
  stranger.close();

  const A = racer(room), B = racer(room);
  const wa = await A.hello(aliceTicket);
  const wb = await B.hello(bobTicket);
  const view = await B.next('room', (m) => m.players.length === 2);
  check(view.league?.code === code && view.players.map((p) => p.name).sort().join() === 'Alice,Bob', 'the room seats Alice and Bob under their league names', view.players);
  check(view.players.find((p) => p.name === 'Bob').car === 3, 'cars come from the league, not from hello', view.players);
  A.send({ t: 'cfg', map: 'snow' });
  A.send({ t: 'set', ready: true });
  B.send({ t: 'set', ready: true });
  await sleep(300);
  A.send({ t: 'start' });
  const load = await A.next('load');
  await B.next('load');
  check(load.cfg.map === map && load.cfg.laps === 1, 'the race uses the league\'s track and laps (cfg changes are ignored)', load.cfg);
  const ai = load.grid.filter((g) => g.ai);
  check(load.grid.length === 4 && ai.length === 2 && load.aiBy === wa.id, 'AI drivers fill the two empty seats, driven by the host', load);
  A.send({ t: 'loaded', seq: load.seq });
  B.send({ t: 'loaded', seq: load.seq });
  const go = await A.next('go');
  // a lap can't be quicker than the track at top speed, and the server knows how long the race has run
  const minLap = TRACK_LEN[map] / MAX_SPEED;
  const wait = go.startAt + (minLap + 1.6) * 1000 - Date.now();
  console.log(`      racing on ${map}: waiting ${(wait / 1000).toFixed(0)} s for a believable lap…`);
  await sleep(wait);
  A.send({ t: 'lap', seq: load.seq, lap: 1, time: minLap + 0.5 });
  B.send({ t: 'lap', seq: load.seq, lap: 1, time: minLap + 0.9 });
  B.send({ t: 'lap', seq: load.seq, lap: 1, time: minLap + 1.0, as: ai[0].id }); // Bob doesn't drive the AI
  A.send({ t: 'lap', seq: load.seq, lap: 1, time: minLap + 1.2, as: ai[0].id });
  await A.next('lap', (m) => m.id === ai[0].id);
  A.send({ t: 'ev', k: 'celeb', kind: 'donuts' }); // the winner's celebration lets the race end at once
  const res = await A.next('results');
  check(res.rows.map((x) => x.name).slice(0, 3).join() === 'Alice,Bob,' + ai[0].name, 'room results: Alice, Bob, then the AI Alice drove', res.rows);
  check(res.rows[3].dns === true && res.rows[3].ai, 'room results: the AI nobody drove did not start', res.rows[3]);
  A.close();
  B.close();

  // ---------- the league after the race ----------
  let L = null;
  for (let i = 0; i < 20 && !(L?.results?.length); i++) { await sleep(250); L = (await api('/league?code=' + code, null, alice)).body; }
  check(L.results?.length === 1 && L.round === 1 && !L.race, 'the room reported back: round 1 done', { round: L.round, race: L.race });
  const rows = Object.fromEntries((L.results[0]?.rows || []).map((x) => [x.name, x]));
  const pts = LEAGUE_FORMATS.arcade.points;
  check(rows.Alice?.pts === pts[0] && rows.Alice.pos === 1, `Alice wins: ${pts[0]} pts`, rows.Alice);
  check(rows.Bob?.pts === pts[1] && rows.Bob.pos === 2, `Bob second: ${pts[1]} pts`, rows.Bob);
  check(rows[ai[0].name]?.pts === pts[2], `the driven AI third: ${pts[2]} pts`, rows[ai[0].name]);
  check(rows[ai[1].name]?.status === 'DNS' && rows[ai[1].name].pts === 0, 'the undriven AI: DNS, no points', rows[ai[1].name]);
  check(rows.Cara?.status === 'DNS' && rows.Cara.pts === 0, 'Cara never came: DNS', rows.Cara);
  const top = L.standings.drivers[0];
  check(top.name === 'Alice' && top.pts === pts[0] && top.wins === 1 && top.rounds[0] === 1, 'standings: Alice leads with a win', top);
  check(L.standings.drivers.find((d) => d.name === 'Cara')?.rounds[0] === 'DNS', 'standings: Cara\'s round 1 is a DNS', L.standings.drivers);
  check(L.feed.some((f) => f.k === 'win' && f.name === 'Alice') && L.feed.some((f) => f.k === 'fastest' && f.name === 'Alice'), 'feed: winner and fastest lap', L.feed.slice(-4));
  check(L.next?.round === 1 && L.next.startsAt > Date.now(), 'the next round is on the next race night', L.next);

  // ---------- an F1 league: teams ----------
  r = await api('/league/create', { name: 'Grid', format: 'f1', rounds: 6, laps: 3, maxPlayers: 6, night, player: { name: 'Max', team: 'mclaren' } });
  check(r.status === 200 && r.body.league.calendar.length === 6, 'F1: create with 6 Grands Prix', r.body);
  const f1 = r.body.code, max = r.body.member.token;
  r = await api('/league/join', { code: f1, name: 'Lando', team: 'mclaren' });
  check(r.status === 409 && r.body.error === 'team_taken', 'F1: one driver per team', r.body);
  r = await api('/league/join', { code: f1, name: 'Lando', team: 'brabham' });
  check(r.status === 400 && r.body.error === 'bad_team', 'F1: a team that is not on the grid is refused', r.body);
  r = await api('/league?code=' + f1);
  check(r.body.taken?.join() === 'mclaren', 'F1: the preview shows which teams are taken', r.body);
  await api('/league/leave', { code: f1 }, max);
  r = await api('/league?code=' + f1);
  check(r.status === 404, 'the last member out takes the league with them', r.status);

  // ---------- leaving ----------
  r = await api('/league/leave', { code }, alice);
  check(r.status === 200, 'the admin leaves', r.body);
  r = await api('/league?code=' + code, null, bob);
  check(r.body.admin === true && r.body.members.find((m) => m.id === bobId)?.admin, 'the admin role passes to the next member', r.body.members);
  r = await api('/league?code=' + code, null, cara);
  check(r.body.standings?.drivers.find((d) => d.name === 'Alice')?.pts === pts[0], 'standings keep a driver who left', r.body.standings?.drivers);
  await api('/league/leave', { code }, cara);
  await api('/league/leave', { code }, bob);

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
