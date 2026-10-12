// Pictures the Garage puts on a car (carModel.js): skins (liveries) drawn on the doors and hood, number plates, and
// the player's uploaded logo. Skins and plates are painted on canvases here, so they need no image files; each is
// drawn once per design (and per light or dark paint) and shared by every car that wears it. These textures aren't
// disposed with a car: they stay for the next car that needs them. Plates are the exception, as there's one per
// number: only the last PLATES_KEPT stay, and the GPU copy of one that falls out is freed (a car still showing it
// uploads it again). Like textures.js, a texture lets go of its canvas once three has uploaded it, and is painted
// again if three ever needs the pixels back: the painters are deterministic, so the repaint is the same picture.
import * as THREE from 'three';
import { DEFAULT_PLATE } from './netproto.js';
import { repaintable } from './textures.js';

const cache = new Map();
const PLATES_KEPT = 16;
function canvasTexture(key, w, h, draw) {
  let t = cache.get(key);
  if (t) {
    // most recently used last
    cache.delete(key);
    cache.set(key, t);
    return t;
  }
  const paint = () => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    return c;
  };
  t = new THREE.CanvasTexture(paint());
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  repaintable(t, paint);
  cache.set(key, t);
  if (key.startsWith('plate:')) {
    const plates = [...cache.keys()].filter((k) => k.startsWith('plate:'));
    for (const k of plates.slice(0, Math.max(0, plates.length - PLATES_KEPT))) { cache.get(k).dispose(); cache.delete(k); }
  }
  return t;
}
// a small preview drawn straight onto its own canvas (no full-size texture), as a data URL
function preview(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'));
  return c.toDataURL();
}

// a small seeded random, so a skin draws the same on every car and every visit
function rnd(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---------- Skins ----------
// Two canvases per design: the side (u along the car from the front wheel back, v up the door) and the hood (u across,
// v toward the nose). A design leaves either out when it has nothing there. `light`: the paint is light, so ink that
// would vanish on it (white stripes) turns dark.
export const SIDE_W = 1024, SIDE_H = 256, HOOD_W = 512, HOOD_H = 512;
// does this design glow (its own light, like the neon underglow)?
export const LIVERY_GLOW = { splash: 0.9 };

function flameTongues(c, x0, y0, len, h, n, dir, r) {
  // classic hot-rod flames: tongues licking back from a solid base, yellow at the root to red at the tips
  const g = dir.x ? c.createLinearGradient(x0, 0, x0 + dir.x * len, 0) : c.createLinearGradient(0, y0, 0, y0 + dir.y * len);
  g.addColorStop(0, '#fff3a0');
  g.addColorStop(0.25, '#ffd23a');
  g.addColorStop(0.6, '#ff7a1a');
  g.addColorStop(1, '#d81e1e');
  c.beginPath();
  if (dir.x) {
    // a rounded nose at the front, so the flames don't start on a hard edge
    c.moveTo(x0 + len * 0.12, y0);
    for (let i = 0; i < n; i++) {
      const a = y0 + (h * i) / n, b = y0 + (h * (i + 1)) / n, tip = len * (0.55 + r() * 0.45), m = (a + b) / 2;
      c.bezierCurveTo(x0 + tip * 0.45, a - h * 0.02, x0 + tip * 0.8, m - h * 0.06, x0 + tip, m);
      c.bezierCurveTo(x0 + tip * 0.7, m + h * 0.02, x0 + tip * 0.35, b - h * 0.04, x0 + len * 0.2, b);
    }
    c.lineTo(x0 + len * 0.12, y0 + h);
    c.quadraticCurveTo(x0 - len * 0.04, y0 + h / 2, x0 + len * 0.12, y0);
  } else {
    c.moveTo(x0, y0);
    for (let i = 0; i < n; i++) {
      const a = x0 + (h * i) / n, b = x0 + (h * (i + 1)) / n, tip = len * (0.55 + r() * 0.45), m = (a + b) / 2;
      c.bezierCurveTo(a + h * 0.02, y0 + dir.y * tip * 0.45, m + h * 0.06, y0 + dir.y * tip * 0.8, m, y0 + dir.y * tip);
      c.bezierCurveTo(m - h * 0.02, y0 + dir.y * tip * 0.7, b - h * 0.04, y0 + dir.y * tip * 0.35, b, y0 + dir.y * len * 0.2);
    }
    c.lineTo(x0 + h, y0);
  }
  c.closePath();
  c.fillStyle = g;
  c.fill();
  c.lineWidth = 6;
  c.strokeStyle = 'rgba(20,10,10,.85)';
  c.stroke();
}

function bolt(c, pts, fill, edge) {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  c.lineJoin = 'miter';
  c.lineWidth = 10;
  c.strokeStyle = edge;
  c.stroke();
  c.fillStyle = fill;
  c.fill();
}

function blossom(c, x, y, r, rot) {
  c.save();
  c.translate(x, y);
  c.rotate(rot);
  for (let k = 0; k < 5; k++) {
    c.rotate((Math.PI * 2) / 5);
    c.beginPath();
    c.ellipse(0, -r * 0.55, r * 0.36, r * 0.55, 0, 0, Math.PI * 2);
    c.fillStyle = k % 2 ? '#ffc2dc' : '#ff9ac6';
    c.fill();
  }
  c.beginPath();
  c.arc(0, 0, r * 0.18, 0, Math.PI * 2);
  c.fillStyle = '#fff3a0';
  c.fill();
  c.restore();
}

function carbonWeave(c, x, y, w, h) {
  c.save();
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  c.fillStyle = '#16171c';
  c.fillRect(x, y, w, h);
  const s = 16;
  for (let j = 0; j * s < h; j++) for (let i = 0; i * s < w; i++) {
    const px = x + i * s, py = y + j * s, g = c.createLinearGradient(px, py, px + s, py + s);
    const on = (i + j) % 2;
    g.addColorStop(0, on ? '#2c2f38' : '#1d1f26');
    g.addColorStop(1, on ? '#15161b' : '#30333d');
    c.fillStyle = g;
    c.fillRect(px + 1, py + 1, s - 2, s - 2);
  }
  c.restore();
}

const LIVERIES = {
  stripes: {
    side(c, w, h, light) {
      c.fillStyle = light ? '#15161b' : '#f4f1e8';
      c.fillRect(0, h * 0.62, w, h * 0.07);
      c.fillRect(0, h * 0.74, w, h * 0.025);
    },
    hood(c, w, h, light) {
      c.fillStyle = light ? '#15161b' : '#f4f1e8';
      c.fillRect(w * 0.27, 0, w * 0.18, h);
      c.fillRect(w * 0.55, 0, w * 0.18, h);
    },
  },
  checker: {
    side(c, w, h, light) {
      const s = h / 6;
      for (let i = 0; i * s < w * 0.55; i++) for (let j = 0; j < 6; j++) {
        if ((i + j) % 2) continue;
        // the flag fades out toward the front
        c.globalAlpha = Math.min(1, (i * s) / (w * 0.4));
        c.fillStyle = light ? '#15161b' : '#f4f1e8';
        c.fillRect(w - (i + 1) * s, j * s, s, s);
      }
      c.globalAlpha = 1;
    },
    hood(c, w, h, light) {
      const s = w / 12;
      for (let j = 0; j * s < h; j++) for (let i = 4; i < 8; i++) {
        if ((i + j) % 2) continue;
        c.fillStyle = light ? '#15161b' : '#f4f1e8';
        c.fillRect(i * s, j * s, s, s);
      }
    },
  },
  carbon: {
    hood(c, w, h) {
      carbonWeave(c, w * 0.06, h * 0.02, w * 0.88, h * 0.96);
      c.strokeStyle = 'rgba(255,255,255,.25)';
      c.lineWidth = 4;
      c.strokeRect(w * 0.06, h * 0.02, w * 0.88, h * 0.96);
    },
    side(c, w, h) { carbonWeave(c, 0, h * 0.78, w, h * 0.22); },
  },
  tiger: {
    side(c, w, h, light) {
      const r = rnd(7);
      c.fillStyle = light ? '#15161b' : '#ff8a1a';
      for (let i = 0; i < 11; i++) {
        const x = (w * (i + 0.3)) / 11, top = r() < 0.5;
        const y0 = top ? 0 : h, dir = top ? 1 : -1, len = h * (0.45 + r() * 0.4), wd = 26 + r() * 22;
        c.beginPath();
        c.moveTo(x - wd, y0);
        c.quadraticCurveTo(x + wd * 0.2, y0 + dir * len * 0.5, x + wd * 1.6, y0 + dir * len);
        c.quadraticCurveTo(x + wd * 0.6, y0 + dir * len * 0.4, x + wd * 0.5, y0);
        c.fill();
      }
    },
    hood(c, w, h, light) {
      const r = rnd(11);
      c.fillStyle = light ? '#15161b' : '#ff8a1a';
      for (const side of [-1, 1]) for (let i = 0; i < 6; i++) {
        const y = (h * (i + 0.4)) / 6, x0 = side < 0 ? 0 : w, len = w * (0.22 + r() * 0.16), wd = 14 + r() * 12;
        c.beginPath();
        c.moveTo(x0, y - wd);
        c.quadraticCurveTo(x0 - side * len * 0.5, y, x0 - side * len, y + wd * 1.6);
        c.quadraticCurveTo(x0 - side * len * 0.4, y + wd * 0.5, x0, y + wd);
        c.fill();
      }
    },
  },
  flames: {
    side(c, w, h) { flameTongues(c, 0, h * 0.1, w * 0.75, h * 0.8, 5, { x: 1 }, rnd(3)); },
    hood(c, w, h) { flameTongues(c, w * 0.12, h, h * 0.8, w * 0.76, 5, { y: -1 }, rnd(5)); },
  },
  camo: {
    side(c, w, h) {
      const r = rnd(21), s = 16, cols = ['#3b4232', '#5a6648', '#7d8763', '#262a20'];
      for (let j = 0; j * s < h; j++) for (let i = 0; i * s < w; i++) {
        // clumps: neighbours tend to share a colour
        const n = Math.sin(i * 0.31 + j * 0.53) + Math.sin(i * 0.17 - j * 0.71 + 2) + r() * 0.8;
        c.fillStyle = cols[Math.max(0, Math.min(3, Math.floor(n + 1.6)))];
        c.fillRect(i * s, j * s, s, s);
      }
    },
    hood(c, w, h) { LIVERIES.camo.side(c, w, h); },
  },
  bolt: {
    side(c, w, h) {
      bolt(c, [[w * 0.02, h * 0.42], [w * 0.4, h * 0.3], [w * 0.36, h * 0.5], [w * 0.98, h * 0.26], [w * 0.55, h * 0.62], [w * 0.6, h * 0.46], [w * 0.04, h * 0.6]], '#ffd23a', '#15161b');
    },
    hood(c, w, h) {
      bolt(c, [[w * 0.62, h * 0.04], [w * 0.3, h * 0.55], [w * 0.5, h * 0.52], [w * 0.36, h * 0.96], [w * 0.72, h * 0.42], [w * 0.52, h * 0.45]], '#ffd23a', '#15161b');
    },
  },
  sakura: {
    side(c, w, h) {
      const r = rnd(13);
      // a branch along the bottom, blossoms thicker toward the rear
      c.strokeStyle = '#3a2420';
      c.lineWidth = 8;
      c.beginPath();
      c.moveTo(w, h * 0.92);
      c.bezierCurveTo(w * 0.7, h * 0.7, w * 0.45, h * 0.95, w * 0.15, h * 0.62);
      c.stroke();
      for (let i = 0; i < 26; i++) {
        const x = w * (1 - Math.pow(r(), 1.6)), y = h * (0.2 + r() * 0.75);
        blossom(c, x, y, 14 + r() * 16, r() * 6);
      }
    },
    hood(c, w, h) {
      const r = rnd(17);
      for (let i = 0; i < 14; i++) {
        const corner = i % 2, x = corner ? w * (0.75 + r() * 0.22) : w * (0.03 + r() * 0.22), y = h * r();
        blossom(c, x, y, 16 + r() * 14, r() * 6);
      }
    },
  },
  splash: {
    side(c, w, h) {
      const r = rnd(29), cols = ['#ff3da6', '#36e2ff', '#ffd23a', '#7cff6b'];
      for (let i = 0; i < 9; i++) {
        const x = w * (0.08 + r() * 0.84), y = h * (0.2 + r() * 0.6), rad = 26 + r() * 30;
        c.fillStyle = cols[i % cols.length];
        c.beginPath();
        c.arc(x, y, rad, 0, Math.PI * 2);
        c.fill();
        // drips and droplets around each splat
        for (let k = 0; k < 9; k++) {
          const a = r() * Math.PI * 2, d = rad * (1.1 + r() * 1.3);
          c.beginPath();
          c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7, 3 + r() * 8, 0, Math.PI * 2);
          c.fill();
        }
        c.fillRect(x - 5, y, 10, rad + r() * h * 0.3);
      }
    },
    hood(c, w, h) { LIVERIES.splash.side(c, w, h); },
  },
};

// the texture for one face ('side' | 'hood') of a skin, or null when the design leaves that face bare
export function liveryTexture(id, face, light = false) {
  const d = LIVERIES[id]?.[face];
  if (!d) return null;
  const [w, h] = face === 'side' ? [SIDE_W, SIDE_H] : [HOOD_W, HOOD_H];
  return canvasTexture(`livery:${id}:${face}:${light ? 1 : 0}`, w, h, (c) => d(c, w, h, light));
}

// a preview of a skin for the Garage: the side and the hood, side by side on a car-coloured ground
const swatches = new Map();
export function liverySwatch(id, paint = 0x3a3d52, light = false) {
  const key = `${id}:${paint}:${light}`;
  if (swatches.has(key)) return swatches.get(key);
  const d = LIVERIES[id];
  const url = preview(240, 92, (x) => {
    x.fillStyle = '#' + paint.toString(16).padStart(6, '0');
    x.fillRect(0, 0, 240, 92);
    // each face drawn at full size into a scaled, clipped corner of the small canvas
    const face = (fn, dx, dy, dw, dh, w, h) => {
      if (!fn) return;
      x.save();
      x.beginPath();
      x.rect(dx, dy, dw, dh);
      x.clip();
      x.translate(dx, dy);
      x.scale(dw / w, dh / h);
      fn(x, w, h, light);
      x.restore();
    };
    face(d?.side, 0, 22, 160, 40, SIDE_W, SIDE_H);
    face(d?.hood, 166, 8, 70, 76, HOOD_W, HOOD_H);
  });
  if (swatches.size > 80) swatches.clear();
  swatches.set(key, url);
  return url;
}

// ---------- Tyre lettering ----------
// White-letter tyres: the brand around the sidewall, white on clear (the material tints it). u runs round the tyre,
// v outward, so the letters stand up from the rim.
export function tyreLettersTexture() {
  return canvasTexture('tyre:letters', 1024, 64, (c, w, h) => {
    c.fillStyle = '#fff';
    c.font = '800 40px "Chakra Petch","Arial Narrow",Arial,sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let k = 0; k < 4; k++) c.fillText('DRIFTBOLT  RACING', (w * (k + 0.5)) / 4, h / 2 + 2);
  });
}

// ---------- Number plates ----------
export const PLATE_W = 512, PLATE_H = 112;
// plates that light up (emissive)
export const PLATE_GLOW = { neon: 1.6 };
const PLATES = {
  euro: { bg: '#f4f4ee', ink: '#15161b', band: '#1f47b8', edge: '#15161b' },
  classic: { bg: '#f5c400', ink: '#15161b', edge: '#15161b' },
  black: { bg: '#0c0d10', ink: '#d7dae5', edge: '#9aa3b5' },
  gold: { bg: '#15120a', ink: ['#a67c00', '#ffe680', '#a67c00'], edge: '#e0b23a' },
  neon: { bg: '#07080f', ink: '#36e2ff', edge: '#36e2ff', glow: true },
};
export function plateTexture(style, text) {
  const t = text || DEFAULT_PLATE;
  return canvasTexture(`plate:${style}:${t}`, PLATE_W, PLATE_H, (c, w, h) => drawPlate(c, w, h, style, t));
}
// a plate for the Garage's list, at half size
export function plateSwatch(style, text) {
  return preview(PLATE_W / 2, PLATE_H / 2, (c) => { c.scale(0.5, 0.5); drawPlate(c, PLATE_W, PLATE_H, style, text || DEFAULT_PLATE); });
}
function drawPlate(c, w, h, style, t) {
  const p = PLATES[style] || PLATES.euro;
  c.fillStyle = p.bg;
  c.beginPath();
  c.roundRect(2, 2, w - 4, h - 4, 14);
  c.fill();
  c.lineWidth = 6;
  c.strokeStyle = p.edge;
  c.beginPath();
  c.roundRect(8, 8, w - 16, h - 16, 10);
  c.stroke();
  let x0 = 0;
  if (p.band) {
    // the blue band: a ring of stars and the game's initials
    c.fillStyle = p.band;
    c.fillRect(11, 11, 58, h - 22);
    c.fillStyle = '#ffd23a';
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      c.beginPath();
      c.arc(40 + Math.cos(a) * 17, 40 + Math.sin(a) * 17, 3, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = '#fff';
    c.font = '700 26px "Chakra Petch",Arial,sans-serif';
    c.textAlign = 'center';
    c.fillText('DB', 40, 92);
    x0 = 64;
  }
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  // as big as fits
  let size = 84;
  const font = (s) => `700 ${s}px "Chakra Petch","Arial Narrow",Arial,sans-serif`;
  c.font = font(size);
  while (size > 30 && c.measureText(t).width > w - x0 - 40) c.font = font((size -= 4));
  if (Array.isArray(p.ink)) {
    const g = c.createLinearGradient(0, 20, 0, h - 20);
    p.ink.forEach((col, i) => g.addColorStop(i / (p.ink.length - 1), col));
    c.fillStyle = g;
  } else c.fillStyle = p.ink;
  if (p.glow) { c.shadowColor = p.ink; c.shadowBlur = 18; }
  c.fillText(t, (x0 + w) / 2, h / 2 + 4);
  c.shadowBlur = 0;
}
