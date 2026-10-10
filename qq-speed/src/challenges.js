// Daily challenges: three a day (easy, medium, hard), picked by a generator seeded with the local date, so every
// player gets the same set and it works offline. Progress, the streak and XP live in the game's settings.
import { MAPS, MAP_TINT } from './maps.js';
import { mulberry32, formatTime } from './util.js';
import { partForUnlock } from './catalog.js';

const $ = (id) => document.getElementById(id);
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const TIERS = [['easy', 'Easy', '#7cff9e'], ['medium', 'Medium', '#ffd23a'], ['hard', 'Hard', '#ff5a5a']];
// Garage parts a hard challenge can award: league unlock flags, named by the parts' earn rules in catalog.js
const UNLOCK_NAMES = { chrome: 'Chrome paint', neon: 'Neon rims', green: 'Green glow' };
const XP = { easy: 100, medium: 200, hard: 400 };

// What a finished race adds to a challenge:
//   drift:       metres drifted, the best single race counts
//   perfect:     Perfect mini boosts, added up over the day
//   perfectRace: Perfect mini boosts, the best single race counts
//   finish/win:  races finished (or won) that match the challenge's track, difficulty and no-nitro rule
const TEMPLATES = {
  easy: [
    () => ({ kind: 'drift', goal: 1000, title: 'Drift 1,000 m in one race' }),
    () => ({ kind: 'perfect', goal: 3, title: 'Land 3 Perfect mini boosts' }),
    (rnd) => { const t = pick(rnd, MAPS); return { kind: 'finish', track: t.id, goal: 1, title: `Finish a race on ${t.name}` }; },
    () => ({ kind: 'win', diff: 0, goal: 1, title: 'Win a race on Rookie' }),
  ],
  medium: [
    (rnd) => ({ kind: 'drift', track: pick(rnd, MAPS).id, goal: 2000, title: 'Drift 2,000 m in one race' }),
    () => ({ kind: 'perfect', goal: 8, title: 'Land 8 Perfect mini boosts' }),
    () => ({ kind: 'win', diff: 1, goal: 1, title: 'Win a race on Skilled' }),
    (rnd) => { const t = pick(rnd, MAPS); return { kind: 'win', track: t.id, goal: 1, title: `Win a race on ${t.name}` }; },
    () => ({ kind: 'finish', noNitro: true, goal: 1, title: 'Finish a race without using nitro' }),
  ],
  hard: [
    (rnd) => ({ kind: 'win', diff: 2, noNitro: true, track: pick(rnd, MAPS).id, goal: 1, title: 'Win on Legend without using nitro' }),
    (rnd) => ({ kind: 'win', diff: 2, track: pick(rnd, MAPS).id, goal: 1, title: 'Win on Legend' }),
    (rnd) => ({ kind: 'drift', track: pick(rnd, MAPS).id, goal: 3500, title: 'Drift 3,500 m in one race' }),
    () => ({ kind: 'perfectRace', goal: 6, title: 'Land 6 Perfect mini boosts in one race' }),
  ],
};

// Achievements: lifetime badges. `got` reads the player's lifetime totals (C), the race just run (r) and the game (g);
// `of` gives progress toward a counting badge.
const KM = (m) => (m / 1000).toFixed(1).replace(/\.0$/, '');
export const ACHIEVEMENTS = [
  { id: 'firstWin', name: 'First Victory', desc: 'Win a race', got: (C) => C.wins >= 1 },
  { id: 'rocket', name: 'Rocket Start', desc: 'Nail a launch boost', got: (C, r) => !!r?.rocket },
  { id: 'double', name: 'Double Trouble', desc: 'Chain a double boost', got: (C, r) => r?.double > 0 },
  { id: 'driftKing', name: 'Drift King', desc: '10 km of drifting', got: (C) => C.driftM >= 10000, of: (C) => `${KM(C.driftM)} / 10 km` },
  { id: 'perfect', name: 'Perfectionist', desc: '100 Perfect mini boosts', got: (C) => C.perfect >= 100, of: (C) => `${C.perfect} / 100` },
  { id: 'podiums', name: 'Podium Regular', desc: '25 podium finishes', got: (C) => C.podiums >= 25, of: (C) => `${C.podiums} / 25` },
  { id: 'clean', name: 'Untouchable', desc: 'Win without hitting a wall', got: (C, r) => r?.won && r.crash === 0 },
  { id: 'pure', name: 'Pure Skill', desc: 'Win on Legend without nitro', got: (C, r) => r?.won && r.diff === 2 && r.nitro === 0 },
  { id: 'wrecker', name: 'Wrecking Ball', desc: '10 takedowns', got: (C) => C.takedowns >= 10, of: (C) => `${C.takedowns} / 10` },
  { id: 'online', name: 'Contender', desc: 'Finish an online race', got: (C, r) => r?.online && r.finished },
  { id: 'world', name: 'World Tour', desc: `Win on all ${MAPS.length} tracks`, got: (C) => MAPS.every((m) => C.trackWins.includes(m.id)), of: (C) => `${C.trackWins.length} / ${MAPS.length}` },
  { id: 'ghost', name: 'Ghostbuster', desc: 'Beat your ghost in a time trial', got: (C, r) => !!r?.beatGhost },
  { id: 'streak', name: 'Hot Streak', desc: 'A 7-day challenge streak', got: (C, r, g) => g.challenges.streak >= 7 },
  { id: 'legend', name: 'Legend', desc: 'Win the Legend Cup', got: (C, r, g) => g.league.d.cupWins.legend > 0 },
];
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3 7h7l-5.5 4.5 2 7.5L12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>';

// local calendar day, e.g. 2026-10-09
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function prevDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d - 1));
}
function seedOf(key) {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// the day's three challenges, the same for everyone on that date
export function dailySet(key) {
  const rnd = mulberry32(seedOf(key));
  const set = TIERS.map(([tier]) => ({ tier, ...pick(rnd, TEMPLATES[tier])(rnd) }));
  // the hard challenge's Garage reward: the first of these the player hasn't unlocked yet
  set[2].unlocks = Object.keys(UNLOCK_NAMES).sort(() => rnd() - 0.5);
  return set;
}

export class Challenges {
  constructor(game) {
    this.game = game;
    $('chalbtn').addEventListener('click', () => this.open());
    $('chalBack').addEventListener('click', () => this.close());
    $('chTracks').addEventListener('click', (e) => {
      const b = e.target.closest('[data-track]');
      if (!b) return;
      this.game.audio.play('click');
      this.ghostTrack = b.dataset.track;
      this.renderGhost();
    });
    $('chGhostGo').addEventListener('click', () => { clearInterval(this.tick); this.game.audio.play('click'); this.game.startTrial(this.ghostTrack); });
    $('chDaily').addEventListener('click', (e) => {
      const b = e.target.closest('[data-claim]');
      if (b) this.claim(+b.dataset.claim);
    });
    this.today();
    this.renderDot();
  }

  get S() { return this.game.settings; }

  // today's set and progress; a new day starts from zero
  today() {
    const key = dayKey();
    if (this.S.daily?.date !== key) this.S.daily = { date: key, prog: [0, 0, 0], claimed: [false, false, false] };
    if (this.set?.key !== key) this.set = Object.assign(dailySet(key), { key });
    return this.S.daily;
  }

  done(i) { return this.today().prog[i] >= this.set[i].goal; }

  // a race is over: count it. r = { track, diff (null when it doesn't count for difficulty), finished, won, nitro, drift, perfect }
  raceDone(r) {
    const D = this.today();
    const newly = [];
    this.set.forEach((c, i) => {
      if (this.done(i)) return;
      if (c.track && c.track !== r.track) return;
      const fits = (!c.noNitro || r.nitro === 0) && (c.diff == null || c.diff === r.diff);
      let p = D.prog[i];
      if (c.kind === 'drift') p = Math.max(p, Math.floor(r.drift));
      else if (c.kind === 'perfect') p += r.perfect;
      else if (c.kind === 'perfectRace') p = Math.max(p, r.perfect);
      else if (c.kind === 'finish' && r.finished && fits) p += 1;
      else if (c.kind === 'win' && r.won && fits) p += 1;
      D.prog[i] = Math.min(p, c.goal);
      if (this.done(i)) newly.push(c);
    });
    if (newly.length) this.markStreak();
    if (newly.length) this.checkBadges(); // a streak badge
    this.addCareer(r);
    const badges = this.checkBadges(r);
    this.game.save();
    this.renderDot();
    return { daily: newly, badges };
  }

  // ---------- Achievements ----------
  // lifetime totals: the player's own, so a new rival bank doesn't reset them
  get career() {
    const C = (this.S.career ||= {});
    return Object.assign(C, { driftM: C.driftM || 0, perfect: C.perfect || 0, podiums: C.podiums || 0, wins: C.wins || 0, takedowns: C.takedowns || 0, trackWins: C.trackWins || [] });
  }

  addCareer(r) {
    const C = this.career;
    C.driftM += r.drift;
    C.perfect += r.perfect;
    C.takedowns += r.takedown || 0;
    if (r.finished && !r.trial && r.place <= 3) C.podiums++;
    if (r.won) {
      C.wins++;
      if (MAPS.some((m) => m.id === r.track) && !C.trackWins.includes(r.track)) C.trackWins.push(r.track);
    }
  }

  // newly earned badges (r: the race just run, if any)
  checkBadges(r = null) {
    const got = (this.S.badges ||= {}), C = this.career, key = dayKey();
    const fresh = ACHIEVEMENTS.filter((a) => !got[a.id] && a.got(C, r, this.game));
    for (const a of fresh) got[a.id] = key;
    return fresh;
  }

  // days in a row with at least one challenge completed
  markStreak() {
    const key = dayKey(), s = (this.S.streak ||= { n: 0, last: null });
    if (s.last === key) return;
    s.n = s.last === prevDay(key) ? s.n + 1 : 1;
    s.last = key;
  }
  get streak() {
    const s = this.S.streak, key = dayKey();
    return s && (s.last === key || s.last === prevDay(key)) ? s.n : 0;
  }

  reward(i) {
    const c = this.set[i];
    // the first finish the player doesn't have yet, earned or bought with tokens
    const unlock = c.unlocks?.find((id) => !this.game.league.unlocked(id) && !this.game.has(partForUnlock(id)?.id));
    return unlock ? { unlock, label: UNLOCK_NAMES[unlock] } : { xp: XP[c.tier], label: `+${XP[c.tier]} XP` };
  }

  claim(i) {
    const D = this.today();
    if (!this.done(i) || D.claimed[i]) return;
    const r = this.reward(i);
    if (r.unlock) this.game.league.unlock(r.unlock);
    else this.S.xp = (this.S.xp || 0) + r.xp;
    D.claimed[i] = true;
    this.game.save();
    this.game.audio.play('gauge');
    this.render();
    this.renderDot();
  }

  get unclaimed() {
    const D = this.today();
    return this.set.some((c, i) => this.done(i) && !D.claimed[i]);
  }

  renderDot() { $('chalbtn').classList.toggle('dot', this.unclaimed); }

  open() {
    this.game.audio.play('click');
    $('menu').classList.add('hidden');
    $('chal').classList.remove('hidden');
    this.render();
    clearInterval(this.tick);
    this.tick = setInterval(() => this.renderClock(), 1000);
  }

  close() {
    if ($('chal').classList.contains('hidden')) return;
    this.game.audio.play('click');
    clearInterval(this.tick);
    $('chal').classList.add('hidden');
    $('menu').classList.remove('hidden');
  }

  render() {
    const D = this.today();
    $('chDaily').innerHTML = this.set.map((c, i) => {
      const [, tag, color] = TIERS[i];
      const track = c.track ? MAPS.find((m) => m.id === c.track).name : 'Any track';
      const p = D.prog[i], done = this.done(i), claimed = D.claimed[i];
      const unit = c.kind === 'drift' ? ' m' : '';
      const progress = done ? `${fmt(c.goal)}${unit} · done` : p ? `${fmt(p)} / ${fmt(c.goal)}${unit}` : 'Not started';
      const reward = claimed ? '<span class="chrw">Claimed</span>'
        : done ? `<button type="button" class="chclaim" data-claim="${i}">Claim ${this.reward(i).label}</button>`
          : `<span class="chrw">${this.reward(i).label}</span>`;
      return `<article class="chcard${done ? ' done' : ''}" style="--c:${color}">
        <div class="chtop"><span class="chtag">${tag}</span><span>${track}</span></div>
        <h3>${c.title}</h3>
        <div class="chbar"><i style="width:${Math.round((p / c.goal) * 100)}%"></i></div>
        <div class="chfoot"><span>${progress}</span>${reward}</div></article>`;
    }).join('');
    this.renderBadges();
    this.renderGhost();
    const n = this.streak;
    $('chStreak').textContent = n ? `${n}-day streak` : 'No streak yet';
    this.renderClock();
  }

  // the ghost time trial card: pick a track, see the ghost's lap and the player's best there
  renderGhost() {
    const id = (this.ghostTrack ||= MAPS.some((m) => m.id === this.S.map) ? this.S.map : MAPS[0].id);
    const name = MAPS.find((m) => m.id === id).name;
    const g = this.game.ghosts.best(id), mine = this.game.league.records(id).find((x) => x.id === 'me');
    $('chTracks').innerHTML = MAPS.map((m) => `<button type="button" class="rchip${m.id === id ? ' sel' : ''}" data-track="${m.id}" aria-pressed="${m.id === id}"${this.game.ghosts.best(m.id) ? ' title="Ghost saved"' : ''}><i style="background:${MAP_TINT[m.id]}"></i>${m.name}</button>`).join('');
    $('chGhostTitle').textContent = g ? `Beat your ghost on ${name}` : `Set a ghost lap on ${name}`;
    $('chGhostLap').textContent = formatTime(g?.t);
    $('chMyBest').textContent = formatTime(mine?.time);
    $('chGhostGo').textContent = g ? 'Race the ghost' : 'Set a ghost lap';
  }

  renderBadges() {
    if (this.checkBadges().length) this.game.save(); // the Legend Cup or a streak may have come in elsewhere
    const got = this.S.badges, C = this.career;
    $('chAchCount').textContent = `${ACHIEVEMENTS.filter((a) => got[a.id]).length} / ${ACHIEVEMENTS.length}`;
    $('chBadges').innerHTML = ACHIEVEMENTS.map((a) => `<div class="chbadge${got[a.id] ? ' got' : ''}"><span class="chico">${STAR}</span>
      <span class="chbt"><b>${a.name}</b><span>${a.desc}${!got[a.id] && a.of ? ` · ${a.of(C)}` : ''}</span></span>
      <span class="sr">${got[a.id] ? 'Unlocked' : 'Locked'}</span></div>`).join('');
  }

  // time left until local midnight; a new day brings a new set
  renderClock() {
    const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((next - now) / 1000));
    $('chTimer').textContent = [s / 3600, (s / 60) % 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':');
    if (this.set.key !== dayKey()) this.render();
  }
}
