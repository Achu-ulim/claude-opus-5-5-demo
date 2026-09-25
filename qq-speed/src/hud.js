import { formatTime } from './util.js';
import { PIT, pitLat } from './pitlane.js';

const $ = (id) => document.getElementById(id);

export const ITEM_INFO = {
  nitro: { icon: '🔥', name: 'Nitro' },
  missile: { icon: '🚀', name: 'Missile' },
  banana: { icon: '🍌', name: 'Banana' },
  shield: { icon: '😇', name: 'Angel' },
  magnet: { icon: '🧲', name: 'Magnet' },
};

export class HUD {
  constructor() {
    this.el = $('hud');
    this.rank = $('rank');
    this.lap = $('lap');
    this.time = $('time');
    this.best = $('best');
    this.spd = $('spd');
    this.rk = $('rk');
    this.rkof = $('rkof');
    this.gaugeFill = $('gaugefill');
    this.gauge = $('gauge');
    this.n2o = [$('n2o0'), $('n2o1')];
    this.msgs = $('msgs');
    this.cd = $('countdown');
    this.warnEl = $('warn');
    this.finalEl = $('finalcount');
    this.vig = $('vignette');
    this.hit = $('hitflash');
    this.items = $('items');
    this.slots = [$('slot0'), $('slot1')];
    this.keys = $('keys');
    this.songtip = $('songtip');
    this.mm = $('mm');
    this.mmx = this.mm.getContext('2d');
    this.sp = $('sp');
    this.spx = this.sp.getContext('2d');
    this.fx = $('fx');
    this.fxx = this.fx.getContext('2d');
    this.lines = [];
    this.cache = {};
    this.resizeFx();
    window.addEventListener('resize', () => this.resizeFx());
  }

  resizeFx() {
    const r = Math.min(window.devicePixelRatio || 1, 1.5);
    this.fx.width = Math.floor(window.innerWidth * r);
    this.fx.height = Math.floor(window.innerHeight * r);
  }

  setSim(on) { $('carstat').classList.toggle('hidden', !on); if (!on) this.pitGuide(null); }

  // screen arrow toward the pit entry: angle in radians (0 = straight ahead, + = to the left), distance in meters
  pitGuide(g) {
    const el = $('pitguide');
    this.guideLevel = g ? g.level : 0;
    if (!g) { this.set('pgVis', el, 'glass hidden', 'className'); return; }
    this.set('pgVis', el, 'glass' + (g.level >= 1 ? ' on' : ''), 'className');
    this.set('pgRot', $('pg-arrow').style, `rotate(${(-g.angle * 180 / Math.PI).toFixed(0)}deg)`, 'transform');
    this.set('pgDist', $('pg-dist'), g.dist < 1000 ? `${Math.round(g.dist / 10) * 10} m` : `${(g.dist / 1000).toFixed(1)} km`);
    this.set('pgTitle', $('pg-title'), g.level >= 1 ? 'PIT ENTRY' : 'PIT NEEDED');
    // keep it just under the top bar / charge bar, whichever is lower
    const topc = $('topc').getBoundingClientRect(), gauge = $('gaugebox').getBoundingClientRect();
    const top = Math.max(topc.bottom, gauge.top < innerHeight / 2 ? gauge.bottom : 0) + 8;
    this.set('pgTop', el.style, Math.round(top) + 'px', 'top');
    // narrow screens: slide right of the car status panel rather than cover it
    const cs = $('carstat').getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    const cx = innerWidth / 2;
    const hits = cs.width && cx - w / 2 < cs.right && cx + w / 2 > cs.left && top < cs.bottom && top + h > cs.top;
    this.set('pgLeft', el.style, hits ? Math.round(cs.right + 8 + w / 2) + 'px' : '50%', 'left');
  }

  // fuel, tyres, part health, and what the team is doing in the pits
  carStatus(c, box, pit, toEntry = null) {
    // sit just below the standings (which grow with the grid), and below the charge bar if they would collide
    const cs = $('carstat');
    const rank = this.rank.getBoundingClientRect(), gauge = $('gaugebox').getBoundingClientRect();
    let top = rank.bottom + 8;
    const left = rank.left, right = left + cs.offsetWidth;
    if (gauge.width && left < gauge.right && right > gauge.left && top < gauge.bottom && top + cs.offsetHeight > gauge.top) top = gauge.bottom + 8;
    this.set('csTop', cs.style, Math.round(top) + 'px', 'top');
    const pct = (v) => Math.round(v * 100) + '%';
    const health = (v) => (v < 0.3 ? 'ok' : v < 0.65 ? 'warn' : 'bad');
    this.set('csFuel', $('cs-fuel').style, pct(c.fuel), 'width');
    this.set('csFuelV', $('cs-fuelv'), pct(c.fuel));
    this.set('csFuelC', $('cs-fuel'), 'fill ' + (c.fuel > 0.3 ? 'ok' : c.fuel > 0.12 ? 'warn' : 'bad'), 'className');
    this.set('csTyre', $('cs-tyre').style, pct(1 - c.tyre), 'width');
    this.set('csTyreV', $('cs-tyrev'), pct(1 - c.tyre));
    this.set('csTyreC', $('cs-tyre'), 'fill ' + health(c.tyre), 'className');
    for (const k of ['wing', 'engine', 'susp']) this.set('cs' + k, $('cs-' + k), 'part ' + health(c[k]), 'className');
    this.set('csBox', $('cs-box'), box && !pit ? 'cs-box' : 'cs-box hidden', 'className');
    this.set('csBoxT', $('cs-box'), toEntry != null ? `BOX · ${Math.round(toEntry / 10) * 10} m` : 'BOX THIS LAP');
    let msg = '';
    if (pit) {
      if (pit.phase === 'stop') {
        const w = pit.work;
        const jobs = [w.tyres && 'tyres', w.fuelTo - w.fuelFrom > 0.02 && 'fuel', w.from.wing + w.from.engine + w.from.susp > 0.05 && 'repairs'].filter(Boolean);
        msg = `${jobs.join(' · ') || 'check-up'} ${Math.max(0, w.time - pit.timer).toFixed(1)}s`;
      } else msg = pit.phase === 'out' ? 'PIT EXIT' : 'PIT LIMITER 80';
    }
    this.set('csPit', $('cs-pit'), msg ? 'cs-pit' : 'cs-pit hidden', 'className');
    this.set('csPitMsg', $('cs-pitmsg'), msg.toUpperCase());
    this.set('csPitBar', $('cs-pitbar').style, pit?.phase === 'stop' ? pct(Math.min(1, pit.timer / pit.work.time)) : '0%', 'width');
  }

  show(v) { this.el.classList.toggle('hidden', !v); if (!v) this.clearFx(); }

  set(key, el, val, prop = 'textContent') {
    if (this.cache[key] === val) return;
    this.cache[key] = val;
    el[prop] = val;
  }

  setItemMode(on) {
    this.items.classList.toggle('hidden', !on);
    $('gaugebox').classList.toggle('hidden', on);
    this.cache = {};
  }

  setupMinimap(track, pit = null) {
    const W = this.mm.width, pad = 26;
    const b = track.bounds;
    const sc = (W - pad * 2) / Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    this.mmT = (x, z) => [W / 2 + (x - b.cx) * sc, W / 2 - (z - b.cz) * sc];
    const off = document.createElement('canvas');
    off.width = off.height = W;
    const g = off.getContext('2d');
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= track.N; i += 2) {
        const k = i % track.N;
        const [x, y] = this.mmT(track.px[k], track.pz[k]);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
    };
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0,0,0,.55)';
    g.lineWidth = 16;
    path();
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.92)';
    g.lineWidth = 9;
    path();
    g.stroke();
    // Color elevated sections
    g.strokeStyle = 'rgba(39,199,255,.9)';
    g.lineWidth = 5;
    for (let i = 0; i < track.N; i++) {
      if (!track.bridge[i]) continue;
      const [x1, y1] = this.mmT(track.px[i], track.pz[i]);
      const j = (i + 1) % track.N;
      const [x2, y2] = this.mmT(track.px[j], track.pz[j]);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
    // the pit lane, in orange beside the straight, with a "P" badge
    if (pit) {
      const q = {};
      g.strokeStyle = 'rgba(255,177,59,.95)';
      g.lineWidth = 4;
      g.beginPath();
      for (let u = 0; u <= PIT.exit; u += 6) {
        track.sample(pit.d(u), q);
        const lat = pitLat(pit, track.halfW, u) + 6;
        const [x, y] = this.mmT(q.x + q.rx * lat, q.z + q.rz * lat);
        if (u === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      track.sample(pit.d(pit.boxU(5)), q);
      const [px, py] = this.mmT(q.x + q.rx * 30, q.z + q.rz * 30);
      g.fillStyle = '#ffb13b';
      g.beginPath(); g.arc(px, py, 13, 0, 7); g.fill();
      g.fillStyle = '#04122c';
      g.font = '900 17px Arial';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('P', px, py + 1);
      track.sample(pit.d(0), q);
      this.mmPitEntry = this.mmT(q.x + q.rx * (track.halfW + 2), q.z + q.rz * (track.halfW + 2));
    } else this.mmPitEntry = null;
    const s = track.sample(0, {});
    const [sx, sy] = this.mmT(s.x, s.z);
    g.save();
    g.translate(sx, sy);
    g.rotate(s.hd - Math.PI / 2);
    g.fillStyle = '#111';
    g.fillRect(-3, -12, 6, 24);
    g.fillStyle = '#fff';
    for (let k = 0; k < 4; k++) g.fillRect(k % 2 ? 0 : -3, -12 + k * 6, 3, 6);
    g.restore();
    this.mmBase = off;
  }

  drawMinimap(racers, player) {
    const g = this.mmx, W = this.mm.width;
    g.clearRect(0, 0, W, W);
    if (this.mmBase) g.drawImage(this.mmBase, 0, 0);
    // pulsing ring on the pit entry while a stop is called or needed
    if (this.mmPitEntry && this.guideLevel > 0) {
      const t = performance.now() / 1000, k = (t * 1.4) % 1;
      const [x, y] = this.mmPitEntry;
      g.strokeStyle = `rgba(255,177,59,${1 - k})`;
      g.lineWidth = 5;
      g.beginPath(); g.arc(x, y, 10 + k * 26, 0, 7); g.stroke();
      g.fillStyle = '#ffb13b';
      g.beginPath(); g.arc(x, y, 8, 0, 7); g.fill();
    }
    for (const r of racers) {
      if (r === player) continue;
      const [x, y] = this.mmT(r.x, r.z);
      g.fillStyle = '#' + (r.model.userData.skin.dot ?? r.model.userData.skin.body).toString(16).padStart(6, '0');
      g.strokeStyle = '#fff';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, 8, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    const [x, y] = this.mmT(player.x, player.z);
    g.save();
    g.translate(x, y);
    g.rotate(player.h + Math.PI);
    g.fillStyle = '#ffd23a';
    g.strokeStyle = '#000';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, 16);
    g.lineTo(11, -11);
    g.lineTo(0, -5);
    g.lineTo(-11, -11);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  drawSpeedo(kmh, boost) {
    const g = this.spx, W = this.sp.width, c = W / 2, R = W * 0.4;
    g.clearRect(0, 0, W, W);
    const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5, maxK = 300;
    g.lineCap = 'round';
    g.lineWidth = 26;
    g.strokeStyle = 'rgba(8,20,50,.7)';
    g.beginPath();
    g.arc(c, c, R, a0, a0 + sweep);
    g.stroke();
    const f = Math.min(1, kmh / maxK);
    const grd = g.createLinearGradient(0, W, W, 0);
    if (boost) { grd.addColorStop(0, '#27c7ff'); grd.addColorStop(1, '#ffffff'); }
    else { grd.addColorStop(0, '#27c7ff'); grd.addColorStop(0.6, '#ffd23a'); grd.addColorStop(1, '#ff5a1f'); }
    g.strokeStyle = grd;
    g.lineWidth = 18;
    g.shadowColor = boost ? '#27c7ff' : '#ff8a00';
    g.shadowBlur = 18;
    g.beginPath();
    g.arc(c, c, R, a0, a0 + sweep * f);
    g.stroke();
    g.shadowBlur = 0;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,.7)';
    g.fillStyle = 'rgba(255,255,255,.75)';
    g.font = 'italic 900 20px Arial Black, Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let k = 0; k <= 10; k++) {
      const a = a0 + (sweep * k) / 10;
      const r1 = R - 26, r2 = R - (k % 2 ? 34 : 42);
      g.beginPath();
      g.moveTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
      g.lineTo(c + Math.cos(a) * r2, c + Math.sin(a) * r2);
      g.stroke();
      if (k % 2 === 0) g.fillText(String(k * 30), c + Math.cos(a) * (R - 62), c + Math.sin(a) * (R - 62));
    }
  }

  update(st) {
    this.set('lap', this.lap, st.lap);
    this.set('time', this.time, formatTime(st.time));
    this.set('best', this.best, 'Best Lap ' + formatTime(st.best));
    this.set('spd', this.spd, String(Math.round(st.kmh)));
    this.set('brk', $('brakeind'), st.braking ? 'on' : '', 'className');
    this.set('brkSp', $('speedo'), st.braking ? 'brake' : '', 'className');
    if (st.throttle != null) this.set('thr', $('thrfill').style, Math.round(st.throttle * 100) + '%', 'width');
    this.set('rk', this.rk, String(st.rank));
    this.set('rkof', this.rkof, '/' + st.total);
    const gw = Math.round(st.gauge * 100);
    this.set('gauge', this.gaugeFill.style, gw + '%', 'width');
    this.gauge.classList.toggle('full', st.gauge >= 0.999);
    for (let k = 0; k < 2; k++) this.n2o[k].classList.toggle('on', st.nitro > k);
    // big grids: top three, a gap, then the cars around the player
    const me = st.standings.findIndex((r) => r.me);
    const show = st.standings.length <= 8 ? null : new Set([0, 1, 2, me - 1, me, me + 1, me + 2].filter((i) => i >= 0 && i < st.standings.length));
    // a gap of a single row is not worth a "⋯": show that row instead
    if (show) for (let i = 1; i < st.standings.length - 1; i++) if (!show.has(i) && show.has(i - 1) && show.has(i + 1)) show.add(i);
    let prev = -1;
    const rows = st.standings.map((r, i) => {
      if (show && !show.has(i)) return '';
      const gap = show && i > prev + 1 ? '<div class="row gap">⋯</div>' : '';
      prev = i;
      return `${gap}<div class="row${r.me ? ' me' : ''}${r.fin ? ' fin' : ''}"><span class="p">${i + 1}</span><span class="dot" style="background:${r.color}"></span><span class="n">${r.name}</span>${r.tag ? `<span class="tg ${r.tag}">${r.tag}</span>` : ''}</div>`;
    }).join('');
    this.set('rows', this.rank, rows, 'innerHTML');
    if (st.items) {
      for (let k = 0; k < 2; k++) {
        const it = st.items[k];
        const html = it ? `${ITEM_INFO[it].icon}<small>${ITEM_INFO[it].name}</small>` : '';
        this.set('slot' + k, this.slots[k], html, 'innerHTML');
      }
    }
    this.vig.style.opacity = st.nitroOn ? 1 : st.smallOn ? 0.8 : 0;
    this.vig.classList.toggle('small', !st.nitroOn && st.smallOn);
  }

  message(text, color = '#27c7ff', small = false) {
    const d = document.createElement('div');
    d.className = 'msg' + (small ? ' sm' : '');
    d.style.setProperty('--c', color);
    d.textContent = text;
    this.msgs.appendChild(d);
    while (this.msgs.children.length > 3) this.msgs.firstChild.remove();
    setTimeout(() => d.remove(), 1150);
  }

  countdown(t) {
    this.cd.innerHTML = t ? `<span>${t}</span>` : '';
  }

  warn(text) {
    if (this.cache.warn === text) return;
    this.cache.warn = text;
    this.warnEl.classList.toggle('hidden', !text);
    if (text) this.warnEl.textContent = text;
  }

  finalCount(text) {
    if (this.cache.fc === text) return;
    this.cache.fc = text;
    this.finalEl.classList.toggle('hidden', !text);
    if (text) this.finalEl.textContent = text;
  }

  flash() {
    this.hit.style.transition = 'none';
    this.hit.style.opacity = 1;
    requestAnimationFrame(() => {
      this.hit.style.transition = 'opacity .5s';
      this.hit.style.opacity = 0;
    });
  }

  song(name) {
    this.songtip.textContent = '♪ ' + name;
    this.songtip.classList.add('show');
    clearTimeout(this.songT);
    this.songT = setTimeout(() => this.songtip.classList.remove('show'), 2200);
  }

  toggleKeys() { this.keys.classList.toggle('hidden'); }

  clearFx() { this.fxx.clearRect(0, 0, this.fx.width, this.fx.height); this.lines.length = 0; }

  // Speed lines
  speedLines(dt, k, color) {
    const g = this.fxx, W = this.fx.width, H = this.fx.height;
    g.clearRect(0, 0, W, H);
    if (k <= 0.01 && !this.lines.length) return;
    const cx = W / 2, cy = H * 0.45;
    const spawn = k * 90 * dt * 60 / 60;
    for (let i = 0; i < spawn * 1.2; i++)
      this.lines.push({ a: Math.random() * Math.PI * 2, r: 0.35 + Math.random() * 0.2, v: 1.8 + Math.random() * 1.6, l: 0.08 + Math.random() * 0.14, w: 1 + Math.random() * 2.5 });
    const D = Math.hypot(W, H) / 2;
    g.strokeStyle = color;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const L = this.lines[i];
      L.r += L.v * dt;
      if (L.r > 1.2) { this.lines.splice(i, 1); continue; }
      const r1 = L.r * D, r2 = (L.r + L.l) * D;
      g.globalAlpha = Math.min(1, k * 1.2) * Math.min(1, (L.r - 0.3) * 3) * 0.55;
      g.lineWidth = L.w * (W / 1400);
      g.beginPath();
      g.moveTo(cx + Math.cos(L.a) * r1, cy + Math.sin(L.a) * r1 * 0.75);
      g.lineTo(cx + Math.cos(L.a) * r2, cy + Math.sin(L.a) * r2 * 0.75);
      g.stroke();
    }
    g.globalAlpha = 1;
  }
}
