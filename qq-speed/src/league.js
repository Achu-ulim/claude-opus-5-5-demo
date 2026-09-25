// Rival bank, tournaments and the leaderboard. Everything lives in localStorage, so it is per browser.
import { CARS } from './carModel.js';
import { MAPS } from './maps.js';
import { GPS, TEAMS, F1_POINTS } from './f1.js';

const KEY = 'feiche3d.league.v1';
export const POINTS = [10, 7, 5, 3, 2, 1]; // per finishing position, 6 racers
const BANK_SIZE = 40;

export const CUPS = [
  { id: 'rookie', name: 'Rookie Cup', icon: '🥉', races: 3, laps: 2, diff: 0, band: [0, 0.55], desc: 'Three races against the newer drivers in the bank.' },
  { id: 'pro', name: 'Pro Cup', icon: '🥈', races: 4, laps: 2, diff: 1, band: [0.3, 0.85], desc: 'Four random cities against seasoned rivals.' },
  { id: 'legend', name: 'Legend Cup', icon: '🏆', races: 5, laps: 3, diff: 2, band: [0.65, 1], desc: 'Five cities, three laps each, against the top of the bank.' },
];

const PREFIX = ['Neon', 'Turbo', 'Apex', 'Nitro', 'Shadow', 'Pixel', 'Blaze', 'Frost', 'Storm', 'Rocket', 'Lucky', 'Silent', 'Crimson', 'Vortex', 'Zen', 'Hyper', 'Solar', 'Lunar', 'Iron', 'Velvet', 'Rapid', 'Night', 'Gold', 'Wild'];
const NOUN = ['Fox', 'Tiger', 'Hawk', 'Wolf', 'Viper', 'Comet', 'Falcon', 'Panda', 'Raven', 'Drifter', 'Ghost', 'Rider', 'Bolt', 'Lynx', 'Cobra', 'Otter', 'Koi', 'Dragon', 'Mantis', 'Jet', 'Shark', 'Phoenix'];
const FIRST = ['Kai', 'Mira', 'Leo', 'Hana', 'Rin', 'Zoe', 'Ivan', 'Aiko', 'Nico', 'Sora', 'Luca', 'Yuki', 'Maya', 'Theo', 'Ada', 'Omar', 'Lena', 'Juno', 'Ravi', 'Emi', 'Finn', 'Noor', 'Tao', 'Ines'];

const pick = (a, rnd) => a[Math.floor(rnd() * a.length)];
const shuffle = (a, rnd = Math.random) => {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

export function randomName(rnd = Math.random, taken = new Set()) {
  for (let tries = 0; tries < 100; tries++) {
    const k = Math.floor(rnd() * 5);
    const name = k === 0 ? pick(PREFIX, rnd) + pick(NOUN, rnd)
      : k === 1 ? `${pick(FIRST, rnd)}_${pick(NOUN, rnd)}`
        : k === 2 ? pick(PREFIX, rnd) + pick(FIRST, rnd)
          : k === 3 ? pick(NOUN, rnd) + (10 + Math.floor(rnd() * 90))
            : `${pick(FIRST, rnd)}${pick(['X', 'GT', 'RS', 'Z', '99', '7'], rnd)}`;
    if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
  }
  return 'Driver' + Math.floor(rnd() * 1000);
}

// Names end up in innerHTML and on canvas name tags: keep them short and plain
export function cleanName(s) {
  return String(s || '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

const blankCareer = () => ({ pts: 0, races: 0, wins: 0, podiums: 0, cups: 0 });

// Give each rival a believable back story so the leaderboard means something from day one
function simulateHistory(talent) {
  const c = blankCareer();
  c.races = 8 + Math.floor(Math.random() * 40);
  for (let i = 0; i < c.races; i++) {
    const noise = (Math.random() + Math.random() + Math.random() - 1.5) * 2.2;
    const pos = Math.max(0, Math.min(5, Math.round((1 - talent) * 5 + noise)));
    c.pts += POINTS[pos];
    if (pos === 0) c.wins++;
    if (pos < 3) c.podiums++;
  }
  c.cups = Math.floor((c.wins / 5) * Math.random());
  return c;
}

function makeBank(taken) {
  const bank = [];
  for (let i = 0; i < BANK_SIZE; i++) {
    const talent = Math.random();
    bank.push({ id: 'r' + i + '-' + Math.random().toString(36).slice(2, 6), name: randomName(Math.random, taken), talent, car: Math.floor(Math.random() * CARS.length), career: simulateHistory(talent) });
  }
  return bank;
}

function fresh(name) {
  const taken = new Set();
  const me = { id: 'me', name: name || randomName(Math.random, taken), career: blankCareer() };
  taken.add(me.name.toLowerCase());
  return { v: 1, me, bank: makeBank(taken), records: {}, cup: null, cupWins: {} };
}

export class League {
  constructor() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(KEY)); } catch { /* ignore */ }
    this.d = d && d.v === 1 && Array.isArray(d.bank) ? d : fresh();
    this.save();
  }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.d)); } catch { /* ignore */ } }

  get name() { return this.d.me.name; }
  set name(v) {
    this.d.me.name = cleanName(v) || 'Driver';
    this.save();
  }
  randomizeName() {
    this.name = randomName(Math.random, new Set(this.d.bank.map((r) => r.name.toLowerCase())));
    return this.name;
  }

  rival(id) { return this.d.bank.find((r) => r.id === id); }

  // n random rivals, preferring talents inside [lo, hi]
  pickRivals(n, band = [0, 1]) {
    const inBand = shuffle(this.d.bank.filter((r) => r.talent >= band[0] && r.talent <= band[1]));
    const rest = shuffle(this.d.bank.filter((r) => !inBand.includes(r)));
    return [...inBand, ...rest].slice(0, n);
  }

  // order: finishing order of the race, [{ id, name, car, best, finished }]; F1 races only count toward lap records
  recordRace(mapId, order, career = true) {
    order.forEach((e, i) => {
      const who = e.id === 'me' ? this.d.me : this.rival(e.id);
      if (!who) return;
      if (career) {
        const c = who.career;
        c.races++;
        c.pts += POINTS[i] || 0;
        if (i === 0) c.wins++;
        if (i < 3) c.podiums++;
      }
      if (e.best > 0) {
        const list = (this.d.records[mapId] ||= []);
        const mine = list.find((x) => x.id === e.id);
        if (!mine) list.push({ id: e.id, name: e.name, car: e.car, time: e.best });
        else if (e.best < mine.time) Object.assign(mine, { name: e.name, car: e.car, time: e.best });
        list.sort((a, b) => a.time - b.time);
        list.length = Math.min(list.length, 10);
      }
    });
    this.save();
  }

  // ---------- Tournaments ----------
  get cup() { return this.d.cup; }

  startCup(cupId, car, mode) {
    const def = CUPS.find((c) => c.id === cupId);
    const rivals = this.pickRivals(5, def.band);
    // rivals bring their favourite car, unless it is already taken
    const used = new Set([car]);
    const cars = rivals.map((r) => {
      let c = r.car;
      if (used.has(c)) c = CARS.findIndex((_, i) => !used.has(i));
      used.add(c);
      return c;
    });
    this.d.cup = {
      id: cupId, car, mode,
      tracks: shuffle(MAPS.map((m) => m.id)).slice(0, def.races),
      idx: 0,
      rivals: rivals.map((r, i) => ({ id: r.id, car: cars[i] })),
      points: Object.fromEntries([['me', 0], ...rivals.map((r) => [r.id, 0])]),
      wins: {},
    };
    this.save();
    return this.d.cup;
  }

  cupDef() { return this.d.cup && CUPS.find((c) => c.id === this.d.cup.id); }

  raceConfig() {
    const cup = this.d.cup, def = this.cupDef();
    return {
      laps: def.laps, mode: cup.mode, skin: cup.car, diff: def.diff, cup: true,
      rivals: cup.rivals.map((x) => ({ ...this.rival(x.id), car: x.car })).filter((r) => r.id),
    };
  }

  // Standings, best first, ties broken by race wins
  cupStandings() {
    const cup = this.d.cup;
    return Object.entries(cup.points)
      .map(([id, pts]) => ({ id, pts, wins: cup.wins[id] || 0, name: id === 'me' ? this.d.me.name : this.rival(id)?.name || '?' }))
      .sort((a, b) => b.pts - a.pts || b.wins - a.wins);
  }

  // ids in finishing order; returns { gained, standings, done, champion }
  cupRaceDone(ids) {
    const cup = this.d.cup;
    const gained = {};
    ids.forEach((id, i) => {
      gained[id] = POINTS[i] || 0;
      if (id in cup.points) cup.points[id] += gained[id];
    });
    cup.wins[ids[0]] = (cup.wins[ids[0]] || 0) + 1;
    cup.idx++;
    const standings = this.cupStandings();
    const done = cup.idx >= cup.tracks.length;
    let champion = null;
    if (done) {
      champion = standings[0];
      const who = champion.id === 'me' ? this.d.me : this.rival(champion.id);
      if (who) who.career.cups++;
      if (champion.id === 'me') this.d.cupWins[cup.id] = (this.d.cupWins[cup.id] || 0) + 1;
      this.d.lastCup = { id: cup.id, standings };
      this.d.cup = null;
    }
    this.save();
    return { gained, standings, done, champion };
  }

  abandonCup() { this.d.cup = null; this.save(); }

  // ---------- Formula 1 ----------
  get f1() { return this.d.f1; }

  // rivals drive for every team except the player's
  f1Grid(team) {
    const others = TEAMS.map((_, i) => i).filter((i) => i !== team);
    return this.pickRivals(others.length, [0.25, 1]).map((r, k) => ({ id: r.id, name: r.name, talent: r.talent, team: others[k] }));
  }

  f1Single(team, laps, diff) {
    return { f1: true, laps, mode: 'speed', diff, team, points: F1_POINTS, rivals: this.f1Grid(team) };
  }

  f1Start(team, rounds, laps, diff) {
    const all = GPS.map((g) => g.id);
    // shorter seasons keep a random pick of rounds, still in calendar order
    const calendar = rounds >= all.length ? all : shuffle([...all]).slice(0, rounds).sort((a, b) => all.indexOf(a) - all.indexOf(b));
    const drivers = this.f1Grid(team);
    this.d.f1 = {
      team, laps, diff, calendar, idx: 0, drivers,
      pts: Object.fromEntries([['me', 0], ...drivers.map((d) => [d.id, 0])]),
      teamPts: Object.fromEntries(TEAMS.map((t) => [t.id, 0])),
      wins: {},
    };
    this.save();
    return this.d.f1;
  }

  f1RaceConfig() {
    const f = this.d.f1;
    return { f1: true, season: true, laps: f.laps, mode: 'speed', diff: f.diff, team: f.team, points: F1_POINTS, rivals: f.drivers.map((d) => ({ ...d, name: this.rival(d.id)?.name || d.name })) };
  }

  f1TeamOf(id) { const f = this.d.f1; return id === 'me' ? f.team : f.drivers.find((d) => d.id === id)?.team; }

  f1Standings() {
    const f = this.d.f1;
    const drivers = Object.entries(f.pts).map(([id, pts]) => ({ id, pts, wins: f.wins[id] || 0, name: id === 'me' ? this.d.me.name : this.rival(id)?.name || f.drivers.find((d) => d.id === id)?.name || '?', team: TEAMS[this.f1TeamOf(id)] }))
      .sort((a, b) => b.pts - a.pts || b.wins - a.wins);
    const teams = TEAMS.map((t) => ({ id: t.id, name: t.name, color: t.dot ?? t.body, pts: f.teamPts[t.id] || 0 })).sort((a, b) => b.pts - a.pts);
    return { drivers, teams };
  }

  // ids in finishing order; returns { gained, standings, done, champion, round, rounds }
  f1RaceDone(ids) {
    const f = this.d.f1;
    const gained = {};
    ids.forEach((id, i) => {
      const p = F1_POINTS[i] || 0;
      gained[id] = p;
      if (id in f.pts) f.pts[id] += p;
      const t = TEAMS[this.f1TeamOf(id)];
      if (t) f.teamPts[t.id] += p;
    });
    f.wins[ids[0]] = (f.wins[ids[0]] || 0) + 1;
    f.idx++;
    const standings = this.f1Standings();
    const res = { gained, standings, round: f.idx, rounds: f.calendar.length, done: f.idx >= f.calendar.length, champion: null, next: f.calendar[f.idx] };
    if (res.done) {
      res.champion = standings.drivers[0];
      if (res.champion.id === 'me') this.d.f1Titles = (this.d.f1Titles || 0) + 1;
      this.d.f1 = null;
    }
    this.save();
    return res;
  }

  f1Abandon() { this.d.f1 = null; this.save(); }

  // ---------- Leaderboard ----------
  drivers() {
    const all = [{ ...this.d.me, me: true }, ...this.d.bank];
    return all.sort((a, b) => b.career.pts - a.career.pts || b.career.wins - a.career.wins || a.career.races - b.career.races);
  }

  records(mapId) { return this.d.records[mapId] || []; }

  newBank() {
    this.d = fresh(this.d.me.name);
    this.save();
  }
}
