// Confetti on a 2D overlay canvas that sits above every screen. Only animates while pieces are alive.

const PALETTE = ['#ffd23a', '#ff5fa8', '#27c7ff', '#ff8a00', '#b36bff', '#6dff9e', '#ffffff'];
const GOLD = ['#ffd23a', '#ffe98a', '#ffb13b', '#fff3c4', '#ffffff'];
const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export class Confetti {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.parts = [];
    this.rainT = 0;
    this.rainColors = PALETTE;
    this.running = false;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.c.width = Math.floor(this.w * this.dpr);
    this.c.height = Math.floor(this.h * this.dpr);
  }

  // one piece: a paper strip that flutters (flip + wobble) as it falls
  spawn(x, y, vx, vy, colors) {
    const round = Math.random() < 0.15;
    this.parts.push({
      x, y, vx, vy,
      color: colors[(Math.random() * colors.length) | 0],
      w: round ? 5 + Math.random() * 3 : 6 + Math.random() * 6,
      h: round ? 0 : 10 + Math.random() * 8,
      round,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 12,
      flip: Math.random() * Math.PI * 2,
      vflip: 6 + Math.random() * 8,
      wob: Math.random() * Math.PI * 2,
      life: 4 + Math.random() * 2.5,
    });
  }

  // a cone of confetti fired from (x, y) toward `angle` (radians, 0 = right, -PI/2 = up)
  cannon(x, y, angle, count, colors = PALETTE, power = 1) {
    if (REDUCED) count = Math.round(count / 4);
    const scale = Math.min(1.4, Math.max(0.7, Math.min(this.w, this.h) / 700));
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * 0.9;
      const sp = (700 + Math.random() * 900) * power * scale;
      this.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, colors);
    }
    this.start();
  }

  // steady fall from the top edge for `seconds`
  rain(seconds, colors = PALETTE) {
    if (REDUCED) return;
    this.rainT = Math.max(this.rainT, seconds);
    this.rainColors = colors;
    this.start();
  }

  // presets: 'win' (race win), 'podium', 'champion' (cup or title)
  celebrate(kind = 'win', colors) {
    const W = this.w, H = this.h;
    if (kind === 'podium') {
      this.cannon(W * 0.5, H, -Math.PI / 2, 90, colors || PALETTE, 0.8);
      return;
    }
    const cols = colors || (kind === 'champion' ? GOLD.concat(PALETTE) : PALETTE);
    const n = kind === 'champion' ? 170 : 120;
    this.cannon(0, H, -Math.PI / 3, n, cols);
    this.cannon(W, H, (-Math.PI * 2) / 3, n, cols);
    this.rain(kind === 'champion' ? 6 : 2.5, cols);
    if (kind === 'champion') {
      // a second volley once the first has peaked
      setTimeout(() => {
        this.cannon(W * 0.15, H, -Math.PI / 2.4, 110, cols);
        this.cannon(W * 0.85, H, -Math.PI / 1.7, 110, cols);
      }, 900);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(() => this.frame());
  }

  frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.rainT > 0) {
      this.rainT -= dt;
      const n = Math.round(dt * Math.max(60, this.w / 6));
      for (let i = 0; i < n; i++) this.spawn(Math.random() * this.w, -20, (Math.random() - 0.5) * 80, 60 + Math.random() * 120, this.rainColors);
    }
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const keep = [];
    for (const p of this.parts) {
      p.life -= dt;
      // air drag slows the burst quickly, then paper drifts down at a gentle terminal speed
      p.vx *= Math.pow(0.12, dt);
      p.vy = p.vy * Math.pow(0.12, dt) + 900 * dt;
      if (p.vy > 260) p.vy = 260;
      p.wob += dt * 5;
      p.x += (p.vx + Math.sin(p.wob) * 40) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.flip += p.vflip * dt;
      if (p.life <= 0 || p.y > this.h + 40) continue;
      keep.push(p);
      g.save();
      g.globalAlpha = Math.min(1, p.life / 0.8);
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.fillStyle = p.color;
      if (p.round) {
        g.beginPath();
        g.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        g.fill();
      } else {
        g.scale(1, Math.cos(p.flip)); // the flip that makes paper strips shimmer
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      g.restore();
    }
    this.parts = keep;
    if (keep.length || this.rainT > 0) requestAnimationFrame(() => this.frame());
    else {
      g.clearRect(0, 0, this.w, this.h);
      this.running = false;
    }
  }
}
