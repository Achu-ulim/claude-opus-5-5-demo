import * as THREE from 'three';
import { mulberry32 } from './util.js';

export let MAX_ANISO = 8;
export function setMaxAniso(v) { MAX_ANISO = v; }

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function toTex(c, { repeat = true, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = MAX_ANISO;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noiseFill(g, w, h, base, amount, rnd, size = 2, count = 0) {
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const n = count || (w * h) / 6;
  for (let i = 0; i < n; i++) {
    const v = (rnd() - 0.5) * amount;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    const s = size * (0.5 + rnd());
    g.fillRect(rnd() * w, rnd() * h, s, s);
  }
}

const cache = new Map();
function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

// Road: u spans the full road width, v runs along the road (one tile = 24 m)
export function roadTexture(style) {
  return cached('road-' + style, () => {
    const W = 512, H = 1024;
    const [c, g] = mk(W, H);
    const rnd = mulberry32(7);
    if (style === 'asphalt') {
      noiseFill(g, W, H, '#474b55', 0.16, rnd, 2);
      // Dark tire-track bands
      for (const x of [0.3, 0.7]) {
        const grd = g.createLinearGradient(W * x - 40, 0, W * x + 40, 0);
        grd.addColorStop(0, 'rgba(0,0,0,0)');
        grd.addColorStop(0.5, 'rgba(0,0,0,0.12)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(W * x - 40, 0, 80, H);
      }
      g.fillStyle = '#f2f2f2';
      g.fillRect(14, 0, 8, H);
      g.fillRect(W - 22, 0, 8, H);
      g.fillStyle = '#e8c33a';
      g.fillRect(W / 2 - 5, 0, 4, H);
      g.fillRect(W / 2 + 1, 0, 4, H);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      for (let y = 0; y < H; y += 256) {
        g.fillRect(W * 0.25 - 3, y, 6, 128);
        g.fillRect(W * 0.75 - 3, y, 6, 128);
      }
      // Blue neon road edges
      g.fillStyle = '#2aa8ff';
      g.fillRect(0, 0, 8, H);
      g.fillRect(W - 8, 0, 8, H);
    } else if (style === 'flagstone') {
      g.fillStyle = '#9d9587';
      g.fillRect(0, 0, W, H);
      const cw = 64, ch = 56;
      for (let y = -ch; y < H + ch; y += ch) {
        const off = ((y / ch) & 1) * cw * 0.5;
        for (let x = -cw; x < W + cw; x += cw) {
          const j = () => (rnd() - 0.5) * 14;
          const x0 = x + off + 3, y0 = y + 3, x1 = x + off + cw - 3, y1 = y + ch - 3;
          const l = 168 + rnd() * 32;
          g.fillStyle = `rgb(${l},${l - 10 - rnd() * 8},${l - 26 - rnd() * 10})`;
          g.beginPath();
          g.moveTo(x0 + j(), y0 + j() * 0.5);
          g.lineTo(x1 + j(), y0 + j() * 0.5);
          g.lineTo(x1 + j() * 0.5, y1 + j());
          g.lineTo(x0 + j() * 0.5, y1 + j());
          g.closePath();
          g.fill();
          g.fillStyle = 'rgba(255,255,255,0.08)';
          g.fillRect(x0 + 6, y0 + 4, cw * 0.4, 3);
        }
      }
      for (let i = 0; i < 4000; i++) {
        g.fillStyle = `rgba(0,0,0,${rnd() * 0.08})`;
        g.fillRect(rnd() * W, rnd() * H, 2, 2);
      }
      // Blue curbs
      g.fillStyle = '#2f7fd8';
      g.fillRect(0, 0, 14, H);
      g.fillRect(W - 14, 0, 14, H);
      g.fillStyle = '#f5f3ee';
      g.fillRect(14, 0, 6, H);
      g.fillRect(W - 20, 0, 6, H);
    } else if (style === 'sandstone') {
      g.fillStyle = '#c9a36a';
      g.fillRect(0, 0, W, H);
      const bw = 128, bh = 96;
      for (let y = 0; y < H; y += bh) {
        const off = ((y / bh) & 1) * bw * 0.5;
        for (let x = -bw; x < W + bw; x += bw) {
          const l = rnd() * 22;
          g.fillStyle = `rgb(${222 - l},${188 - l},${128 - l})`;
          g.fillRect(x + off + 2, y + 2, bw - 4, bh - 4);
          g.strokeStyle = 'rgba(120,80,40,0.25)';
          g.lineWidth = 2;
          g.beginPath();
          let cx = x + off + rnd() * bw, cy = y + rnd() * bh;
          g.moveTo(cx, cy);
          for (let k = 0; k < 4; k++) { cx += (rnd() - 0.5) * 30; cy += (rnd() - 0.5) * 30; g.lineTo(cx, cy); }
          g.stroke();
        }
      }
      for (let i = 0; i < 6000; i++) {
        g.fillStyle = `rgba(${rnd() > 0.5 ? '255,240,200' : '90,60,30'},${rnd() * 0.12})`;
        g.fillRect(rnd() * W, rnd() * H, 2, 2);
      }
      // Purple road edges (based on the Pharaoh's Pyramid concept art)
      g.fillStyle = '#5b3f9e';
      g.fillRect(0, 0, 18, H);
      g.fillRect(W - 18, 0, 18, H);
      g.fillStyle = '#f3e3b5';
      g.fillRect(18, 0, 5, H);
      g.fillRect(W - 23, 0, 5, H);
    } else if (style === 'plate') {
      g.fillStyle = '#3c4a66';
      g.fillRect(0, 0, W, H);
      // Diamond-plate steel
      for (let y = 0; y < H; y += 24) {
        for (let x = 0; x < W; x += 24) {
          const ox = ((y / 24) & 1) * 12;
          g.fillStyle = 'rgba(160,190,230,0.18)';
          g.save();
          g.translate(x + ox, y);
          g.rotate(Math.PI / 4);
          g.fillRect(-6, -1.5, 12, 3);
          g.restore();
        }
      }
      g.strokeStyle = 'rgba(20,28,45,0.8)';
      g.lineWidth = 3;
      for (let y = 0; y <= H; y += 256) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      for (const x of [W / 3, (2 * W) / 3]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      for (let i = 0; i < 3000; i++) {
        g.fillStyle = `rgba(255,255,255,${rnd() * 0.08})`;
        g.fillRect(rnd() * W, rnd() * H, 2, 2);
      }
      // Snowy edges and bright blue edge lines
      const grd = g.createLinearGradient(0, 0, 40, 0);
      grd.addColorStop(0, 'rgba(240,248,255,0.95)');
      grd.addColorStop(1, 'rgba(240,248,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 40, H);
      g.save();
      g.translate(W, 0);
      g.scale(-1, 1);
      g.fillStyle = grd;
      g.fillRect(0, 0, 40, H);
      g.restore();
      g.fillStyle = '#39c5ff';
      g.fillRect(22, 0, 6, H);
      g.fillRect(W - 28, 0, 6, H);
    }
    const t = toTex(c);
    return t;
  });
}

export function curbTexture(a = '#e53935', b = '#ffffff') {
  return cached('curb' + a + b, () => {
    const [c, g] = mk(64, 256);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i % 2 ? b : a;
      g.fillRect(0, i * 64, 64, 64);
    }
    g.fillStyle = 'rgba(0,0,0,0.15)';
    g.fillRect(0, 0, 6, 256);
    return toTex(c);
  });
}

export function checkerTexture(a = '#111', b = '#fff', nx = 8, ny = 2) {
  return cached(`chk${a}${b}${nx}${ny}`, () => {
    const [c, g] = mk(nx * 32, ny * 32);
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        g.fillStyle = (x + y) % 2 ? a : b;
        g.fillRect(x * 32, y * 32, 32, 32);
      }
    const t = toTex(c, { repeat: true });
    t.magFilter = THREE.NearestFilter;
    return t;
  });
}

// Walls: one tile covers 16 m
export function wallTexture(style) {
  return cached('wall-' + style, () => {
    const W = 1024, H = 128;
    const [c, g] = mk(W, H);
    const rnd = mulberry32(3);
    if (style === 'city') {
      // Sponsor boards along the barrier
      ['pirelli', 'mobil1', 'michelin', 'castrol'].forEach((id, i) => paintBrand(g, id, i * 256, 0, 256, H));
      g.fillStyle = 'rgba(0,0,0,0.5)';
      for (let i = 0; i < 4; i++) g.fillRect(i * 256, 0, 4, H);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(0, H - 10, W, 10);
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillRect(0, 0, W, 5);
    } else if (style === 'aegean') {
      g.fillStyle = '#f4f1ea';
      g.fillRect(0, 0, W, H);
      for (let i = 0; i < 3000; i++) {
        g.fillStyle = `rgba(150,140,120,${rnd() * 0.1})`;
        g.fillRect(rnd() * W, rnd() * H, 3, 3);
      }
      g.fillStyle = '#2d6fc4';
      g.fillRect(0, 0, W, 18);
      // Blue railing grid
      g.strokeStyle = '#3a82d6';
      g.lineWidth = 5;
      for (let x = 0; x < W; x += 64) {
        g.strokeRect(x + 8, 30, 48, 60);
        g.beginPath();
        g.moveTo(x + 8, 30); g.lineTo(x + 56, 90);
        g.moveTo(x + 56, 30); g.lineTo(x + 8, 90);
        g.stroke();
      }
      g.fillStyle = '#d8d2c4';
      g.fillRect(0, H - 22, W, 22);
    } else if (style === 'egypt') {
      g.fillStyle = '#d2ad6f';
      g.fillRect(0, 0, W, H);
      for (let y = 20; y < H; y += 36) {
        for (let x = 0; x < W; x += 96) {
          const o = ((y / 36) | 0) % 2 ? 48 : 0;
          g.strokeStyle = 'rgba(110,70,30,0.45)';
          g.lineWidth = 2;
          g.strokeRect(x + o, y, 96, 36);
        }
      }
      g.fillStyle = '#4f3a96';
      g.fillRect(0, 0, W, 20);
      g.fillStyle = '#e8c547';
      g.fillRect(0, 20, W, 4);
      // Hieroglyphs
      g.fillStyle = 'rgba(80,45,20,0.55)';
      for (let x = 30; x < W; x += 120) {
        g.beginPath();
        g.arc(x, 70, 12, 0, Math.PI * 2);
        g.fill();
        g.fillRect(x + 22, 56, 6, 30);
        g.beginPath();
        g.moveTo(x + 40, 88); g.lineTo(x + 52, 56); g.lineTo(x + 64, 88); g.fill();
        g.fillRect(x + 72, 66, 22, 5);
      }
    } else if (style === 'snow') {
      // Sponsor boards below the snow cap
      ['michelin', 'redbull', 'goodyear', 'motul'].forEach((id, i) => paintBrand(g, id, i * 256, 14, 256, H - 14));
      g.fillStyle = 'rgba(0,0,0,0.5)';
      for (let i = 0; i < 4; i++) g.fillRect(i * 256, 0, 4, H);
      g.fillStyle = '#f5fbff';
      g.fillRect(0, 0, W, 14);
    }
    return toTex(c);
  });
}

export function groundTexture(type) {
  return cached('ground-' + type, () => {
    const S = 512;
    const [c, g] = mk(S, S);
    const rnd = mulberry32(11);
    if (type === 'grass') {
      noiseFill(g, S, S, '#5fae4a', 0.18, rnd, 3);
      for (let i = 0; i < 9000; i++) {
        g.fillStyle = rnd() > 0.5 ? 'rgba(120,190,80,0.35)' : 'rgba(40,110,40,0.3)';
        g.fillRect(rnd() * S, rnd() * S, 1.5, 4);
      }
    } else if (type === 'sand') {
      noiseFill(g, S, S, '#e2bf82', 0.12, rnd, 3);
      g.strokeStyle = 'rgba(170,120,60,0.18)';
      g.lineWidth = 3;
      for (let i = 0; i < 26; i++) {
        g.beginPath();
        const y = rnd() * S;
        g.moveTo(0, y);
        for (let x = 0; x <= S; x += 32) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 8);
        g.stroke();
      }
    } else if (type === 'snow') {
      noiseFill(g, S, S, '#dde8f4', 0.1, rnd, 4);
      for (let i = 0; i < 800; i++) {
        g.fillStyle = `rgba(170,200,235,${rnd() * 0.25})`;
        g.beginPath();
        g.arc(rnd() * S, rnd() * S, 2 + rnd() * 10, 0, Math.PI * 2);
        g.fill();
      }
    } else if (type === 'aegean') {
      noiseFill(g, S, S, '#b7b27e', 0.2, rnd, 3);
      for (let i = 0; i < 400; i++) {
        g.fillStyle = `rgba(${rnd() > 0.5 ? '120,150,70' : '200,190,160'},${0.3 + rnd() * 0.3})`;
        g.beginPath();
        g.arc(rnd() * S, rnd() * S, 2 + rnd() * 7, 0, Math.PI * 2);
        g.fill();
      }
    } else if (type === 'plaza') {
      g.fillStyle = '#c9c4ba';
      g.fillRect(0, 0, S, S);
      for (let y = 0; y < S; y += 32)
        for (let x = 0; x < S; x += 32) {
          const l = 190 + rnd() * 30;
          g.fillStyle = `rgb(${l},${l - 4},${l - 12})`;
          g.fillRect(x + 1, y + 1, 30, 30);
        }
    }
    return toTex(c);
  });
}

// Building facades: window grid
export function facadeTexture(kind) {
  return cached('facade-' + kind, () => {
    const W = 256, H = 512;
    const [c, g] = mk(W, H);
    const rnd = mulberry32(kind.length * 17 + 5);
    if (kind === 'glass') {
      const grd = g.createLinearGradient(0, 0, W, H);
      grd.addColorStop(0, '#6fb6ec');
      grd.addColorStop(1, '#2d6aa8');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y += 24) {
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.fillRect(0, y, W, 2);
      }
      for (let x = 0; x < W; x += 32) {
        g.fillStyle = 'rgba(20,50,90,0.5)';
        g.fillRect(x, 0, 3, H);
      }
      for (let i = 0; i < 40; i++) {
        g.fillStyle = `rgba(255,255,255,${rnd() * 0.25})`;
        g.fillRect(((rnd() * 8) | 0) * 32 + 3, ((rnd() * 21) | 0) * 24 + 2, 29, 22);
      }
    } else if (kind === 'office') {
      g.fillStyle = '#e9e3d6';
      g.fillRect(0, 0, W, H);
      for (let y = 10; y < H; y += 32)
        for (let x = 10; x < W; x += 30) {
          g.fillStyle = rnd() > 0.85 ? '#fff4c2' : rnd() > 0.5 ? '#5b87b8' : '#476f9c';
          g.fillRect(x, y, 20, 20);
        }
    } else if (kind === 'modern') {
      g.fillStyle = '#d7dde6';
      g.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y += 40) {
        g.fillStyle = '#3f6fa3';
        g.fillRect(0, y + 8, W, 26);
        g.fillStyle = 'rgba(255,255,255,0.3)';
        g.fillRect(0, y + 10, W, 4);
      }
    } else if (kind === 'aegean') {
      g.fillStyle = '#f7f5f0';
      g.fillRect(0, 0, W, H);
      for (let i = 0; i < 2000; i++) {
        g.fillStyle = `rgba(160,150,130,${rnd() * 0.08})`;
        g.fillRect(rnd() * W, rnd() * H, 3, 3);
      }
      for (let y = 40; y < H; y += 128)
        for (let x = 30; x < W; x += 110) {
          g.fillStyle = '#2466b8';
          g.beginPath();
          g.moveTo(x, y + 70);
          g.lineTo(x, y + 20);
          g.arc(x + 25, y + 20, 25, Math.PI, 0);
          g.lineTo(x + 50, y + 70);
          g.fill();
          g.fillStyle = '#9ec8f0';
          g.fillRect(x + 8, y + 22, 34, 40);
          g.fillStyle = '#2466b8';
          g.fillRect(x + 23, y + 18, 4, 46);
        }
    } else if (kind === 'egypt') {
      g.fillStyle = '#d9b77a';
      g.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y += 32)
        for (let x = 0; x < W; x += 64) {
          g.strokeStyle = 'rgba(120,80,40,0.4)';
          g.strokeRect(x + (((y / 32) & 1) * 32), y, 64, 32);
        }
    } else if (kind === 'night') {
      // dark tower with a scatter of lit windows; used as its own emissive map so the windows glow at night
      g.fillStyle = '#10131f';
      g.fillRect(0, 0, W, H);
      // whole floors tend to be lit or dark together, mostly in warm office light
      for (let y = 10; y < H; y += 32) {
        const floorLit = rnd() < 0.45 ? 0.75 : 0.12;
        const tint = rnd() < 0.8 ? '#ffd48a' : '#8fe3ff';
        for (let x = 10; x < W; x += 30) {
          g.fillStyle = rnd() < floorLit ? tint : '#1b2233';
          g.fillRect(x, y, 20, 18);
        }
      }
      for (let y = 0; y < H; y += 176) {
        g.fillStyle = rnd() > 0.5 ? '#ff2d95' : '#27c7ff';
        g.fillRect(0, y, W, 3);
      }
    } else if (kind === 'gold') {
      const grd = g.createLinearGradient(0, 0, W, H);
      grd.addColorStop(0, '#f6d7a0');
      grd.addColorStop(0.5, '#c98f4a');
      grd.addColorStop(1, '#7a4f2a');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y += 20) {
        g.fillStyle = 'rgba(255,240,210,0.3)';
        g.fillRect(0, y, W, 2);
      }
      for (let x = 0; x < W; x += 26) {
        g.fillStyle = 'rgba(60,35,15,0.45)';
        g.fillRect(x, 0, 2, H);
      }
    } else if (kind === 'lodge') {
      g.fillStyle = '#7a4a2a';
      g.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y += 20) {
        g.fillStyle = y % 40 ? '#8b5a36' : '#6d3f22';
        g.fillRect(0, y, W, 18);
      }
      for (let y = 60; y < H; y += 140)
        for (let x = 40; x < W; x += 110) {
          g.fillStyle = '#ffd36b';
          g.fillRect(x, y, 44, 50);
          g.strokeStyle = '#3a2210';
          g.lineWidth = 5;
          g.strokeRect(x, y, 44, 50);
        }
    }
    return toTex(c);
  });
}

export function billboardTexture(title, sub, c1 = '#ff7a00', c2 = '#ffd000', fg = '#ffffff') {
  return cached(`bb${title}${sub}${c1}${c2}`, () => {
    const [c, g] = mk(512, 256);
    const grd = g.createLinearGradient(0, 0, 512, 256);
    grd.addColorStop(0, c1);
    grd.addColorStop(1, c2);
    g.fillStyle = grd;
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = 'rgba(255,255,255,0.15)';
    for (let i = 0; i < 6; i++) g.fillRect(-40 + i * 110, 0, 40, 256);
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 10;
    g.strokeRect(5, 5, 502, 246);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'italic 900 92px "Arial Black", Arial, sans-serif';
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = 8;
    g.fillText(title, 256, sub ? 108 : 128, 472);
    if (sub) {
      g.font = 'bold 40px "PingFang SC","Microsoft YaHei",sans-serif';
      g.fillText(sub, 256, 196, 472);
    }
    const t = toTex(c, { repeat: false });
    return t;
  });
}

// Sponsor boards: real brands drawn as wordmarks in their house colours (type and colour only, no logo artwork).
// Each painter fills a w×h panel with its top-left corner at the origin. Fonts use '#' as the pixel-size placeholder.
const HEAVY = '"Arial Black", "Arial Bold", Arial, sans-serif';

// Shrinks `size` until `text` fits in maxW; leaves the font set on g
function fitFont(g, text, font, size, maxW) {
  g.font = font.replace('#', size);
  const tw = g.measureText(text).width;
  if (tw > maxW) {
    size = Math.floor((size * maxW) / tw);
    g.font = font.replace('#', size);
  }
  return size;
}

// Plain wordmark centred on a flat background; `deco` paints extras (stripes, rules) before the text
function wordmark(bg, fg, text, font, deco = null) {
  return (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    if (deco) deco(g, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const s = fitFont(g, text, font, Math.round(h * 0.56), w * 0.84);
    g.fillStyle = fg;
    g.fillText(text, w / 2, h / 2 + s * 0.35);
  };
}

const rules = (color) => (g, w, h) => {
  g.fillStyle = color;
  g.fillRect(w * 0.06, h * 0.12, w * 0.88, Math.max(2, h * 0.025));
  g.fillRect(w * 0.06, h * 0.86, w * 0.88, Math.max(2, h * 0.025));
};

const band = (color, y0, y1) => (g, w, h) => {
  g.fillStyle = color;
  g.fillRect(0, h * y0, w, h * (y1 - y0));
};

// Wordmark with an outline, for brands whose letters sit on a busy or low-contrast background
function outlined(g, w, h, text, font, fill, stroke, size, maxW, y) {
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const s = fitFont(g, text, font, size, maxW);
  g.lineJoin = 'round';
  g.lineWidth = s * 0.12;
  g.strokeStyle = stroke;
  g.strokeText(text, w / 2, y ?? h / 2 + s * 0.35);
  g.fillStyle = fill;
  g.fillText(text, w / 2, y ?? h / 2 + s * 0.35);
}

const BRANDS = {
  // The long P: its top stroke runs over the rest of the word
  pirelli(g, w, h) {
    g.fillStyle = '#000000';
    g.fillRect(0, 0, w, h);
    const font = `900 #px ${HEAVY}`;
    let s = h * 0.4;
    g.font = font.replace('#', s * 1.5);
    let wp = g.measureText('P').width;
    g.font = font.replace('#', s);
    let wr = g.measureText('IRELLI').width;
    const k = Math.min(1, (w * 0.84) / (wp + wr));
    s *= k; wp *= k; wr *= k;
    const x0 = (w - wp - wr) / 2, y = h / 2 + s * 0.54;
    g.fillStyle = '#ffd100';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = font.replace('#', s * 1.5);
    g.fillText('P', x0, y);
    g.font = font.replace('#', s);
    g.fillText('IRELLI', x0 + wp, y);
    g.fillRect(x0 + wp * 0.5, y - s * 1.07, wr + wp * 0.5, s * 0.19);
  },
  shell: wordmark('#fbce07', '#dd1d21', 'Shell', 'bold #px Arial, Helvetica, sans-serif', band('#dd1d21', 0.86, 1)),
  redbull(g, w, h) {
    g.fillStyle = '#0b1e4f';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffc906';
    g.beginPath();
    g.arc(w / 2, h / 2, h * 0.36, 0, Math.PI * 2);
    g.fill();
    outlined(g, w, h, 'Red Bull', 'bold #px Futura, "Century Gothic", "Trebuchet MS", Arial, sans-serif', '#db0a40', '#ffffff', Math.round(h * 0.4), w * 0.84);
  },
  // Red speed lines either side of the italic letters
  dhl(g, w, h) {
    g.fillStyle = '#ffcc00';
    g.fillRect(0, 0, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const s = fitFont(g, 'DHL', `italic 900 #px ${HEAVY}`, Math.round(h * 0.6), w * 0.56);
    const tw = g.measureText('DHL').width, y = h / 2 + s * 0.35;
    g.fillStyle = '#d40511';
    g.fillText('DHL', w / 2, y);
    const lh = s * 0.11;
    for (let i = 0; i < 3; i++) {
      const ly = y - s * 0.66 + i * s * 0.24;
      g.fillRect(w * 0.04, ly, w / 2 - tw / 2 - s * 0.12 - w * 0.04, lh);
      g.fillRect(w / 2 + tw / 2 + s * 0.04, ly, w * 0.96 - (w / 2 + tw / 2 + s * 0.04), lh);
    }
  },
  rolex: wordmark('#006039', '#d4af5a', 'ROLEX', 'bold #px Georgia, "Times New Roman", serif', rules('#d4af5a')),
  michelin: wordmark('#27509b', '#fce500', 'MICHELIN', `italic 900 #px ${HEAVY}`),
  // Blue letters, red "o" and red "1"
  mobil1(g, w, h) {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    band('#0d3d91', 0.88, 1)(g, w, h);
    const blue = '#0d3d91', red = '#e2231a';
    const parts = [['M', blue], ['o', red], ['bil', blue], [' 1', red]];
    const text = parts.map((p) => p[0]).join('');
    const s = fitFont(g, text, 'bold #px Arial, Helvetica, sans-serif', Math.round(h * 0.56), w * 0.84);
    let x = (w - g.measureText(text).width) / 2;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    for (const [t, col] of parts) {
      g.fillStyle = col;
      g.fillText(t, x, h / 2 + s * 0.35);
      x += g.measureText(t).width;
    }
  },
  castrol(g, w, h) {
    g.fillStyle = '#009a44';
    g.fillRect(0, 0, w, h);
    outlined(g, w, h, 'Castrol', `italic 900 #px ${HEAVY}`, '#e4002b', '#ffffff', Math.round(h * 0.5), w * 0.84);
  },
  // Orange disc with a navy ring on Gulf blue
  gulf(g, w, h) {
    g.fillStyle = '#8fc9ea';
    g.fillRect(0, 0, w, h);
    const r = h * 0.42;
    g.fillStyle = '#f47b20';
    g.beginPath();
    g.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = r * 0.09;
    g.strokeStyle = '#0b2a5b';
    g.stroke();
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const s = fitFont(g, 'Gulf', `900 #px ${HEAVY}`, Math.round(r * 0.8), r * 1.55);
    g.fillStyle = '#0b2a5b';
    g.fillText('Gulf', w / 2, h / 2 + s * 0.35);
  },
  sony: wordmark('#000000', '#ffffff', 'SONY', 'bold #px "Times New Roman", Times, Georgia, serif'),
  panasonic: wordmark('#ffffff', '#0049ab', 'Panasonic', 'bold #px Arial, Helvetica, sans-serif'),
  bridgestone: wordmark('#111111', '#ffffff', 'BRIDGESTONE', `italic 900 #px ${HEAVY}`, band('#e4002b', 0.84, 0.92)),
  samsung: wordmark('#1428a0', '#ffffff', 'SAMSUNG', `900 #px ${HEAVY}`),
  emirates: wordmark('#d71921', '#ffffff', 'Fly Emirates', 'italic bold #px Georgia, "Times New Roman", serif'),
  petronas: wordmark('#00a19c', '#ffffff', 'PETRONAS', `900 #px ${HEAVY}`),
  goodyear: wordmark('#0f2b6b', '#fdd100', 'GOODYEAR', `900 #px ${HEAVY}`, rules('#fdd100')),
  motul: wordmark('#e30613', '#ffffff', 'MOTUL', `italic 900 #px ${HEAVY}`),
  // Chow green with a yellow locator bubble beside the lowercase wordmark
  chowdeck(g, w, h) {
    g.fillStyle = '#0c513f';
    g.fillRect(0, 0, w, h);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    const s = fitFont(g, 'chowdeck', 'bold #px "Arial Rounded MT Bold", "Helvetica Rounded", Arial, sans-serif', Math.round(h * 0.44), w * 0.66);
    const tw = g.measureText('chowdeck').width, r = s * 0.4;
    const x0 = (w - (r * 2 + s * 0.22 + tw)) / 2, cx = x0 + r, cy = h / 2 - r * 0.3;
    g.fillStyle = '#ffc501';
    g.beginPath();
    g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25);
    g.lineTo(cx, cy + r * 1.6);
    g.closePath();
    g.fill();
    g.fillStyle = '#0c513f';
    g.beginPath();
    g.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.fillText('chowdeck', x0 + r * 2 + s * 0.22, h / 2 + s * 0.3);
  },
  // Navy-to-blue wordmark, the purple arrow sweeping up past the GO
  manlago(g, w, h) {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    const s = fitFont(g, 'MANLAGO', `900 #px ${HEAVY}`, Math.round(h * 0.42), w * 0.88);
    const tw = g.measureText('MANLAGO').width, x0 = (w - tw) / 2, y = h / 2 + s * 0.3;
    const grd = g.createLinearGradient(x0, 0, x0 + tw, 0);
    grd.addColorStop(0, '#1b1f6e');
    grd.addColorStop(1, '#2563eb');
    g.fillStyle = grd;
    g.fillText('MANLAGO', x0, y);
    const ax0 = x0 + tw * 0.6, ay0 = y - s * 0.86, ax1 = x0 + tw + s * 0.12, ay1 = y - s * 1.22;
    const qx = (ax0 + ax1) / 2, qy = ay0 + s * 0.12;
    g.strokeStyle = g.fillStyle = '#7c3aed';
    g.lineWidth = s * 0.07;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(ax0, ay0);
    g.quadraticCurveTo(qx, qy, ax1, ay1);
    g.stroke();
    const a = Math.atan2(ay1 - qy, ax1 - qx), L = s * 0.22;
    g.beginPath();
    g.moveTo(ax1 + Math.cos(a) * L * 0.4, ay1 + Math.sin(a) * L * 0.4);
    g.lineTo(ax1 + Math.cos(a + 2.6) * L, ay1 + Math.sin(a + 2.6) * L);
    g.lineTo(ax1 + Math.cos(a - 2.6) * L, ay1 + Math.sin(a - 2.6) * L);
    g.closePath();
    g.fill();
    g.fillStyle = '#64748b';
    g.textAlign = 'center';
    g.font = `bold ${Math.round(s * 0.26)}px Arial, sans-serif`;
    g.fillText('ENTERPRISE TECH SOLUTIONS', w / 2, y + s * 0.5, w * 0.9);
  },
  monster(g, w, h) {
    g.fillStyle = '#000000';
    g.fillRect(0, 0, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const s = fitFont(g, 'MONSTER', `italic 900 #px ${HEAVY}`, Math.round(h * 0.42), w * 0.86);
    g.fillStyle = '#95d600';
    g.fillText('MONSTER', w / 2, h * 0.5 + s * 0.2);
    g.font = `bold ${Math.round(s * 0.4)}px Arial, sans-serif`;
    g.fillStyle = '#ffffff';
    g.fillText('ENERGY', w / 2, h * 0.5 + s * 0.75);
  },
};

function paintBrand(g, id, x, y, w, h) {
  g.save();
  g.translate(x, y);
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();
  BRANDS[id](g, w, h);
  g.restore();
}

// Podium backdrop: the Grand Prix name over a step-and-repeat wall of sponsor boards
export function podiumBackdropTexture(title, brands) {
  return cached(`podium-${title}`, () => {
    const W = 1024, H = 448;
    const [c, g] = mk(W, H);
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#23232e');
    grd.addColorStop(1, '#101016');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#e10600';
    g.fillRect(0, 0, W, 16);
    g.fillRect(0, H - 16, W, 16);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const s = fitFont(g, title, `italic 900 #px ${HEAVY}`, 64, W * 0.9);
    g.fillText(title, W / 2, 40 + s * 0.85);
    const cols = 6, rows = 3, pw = 160, ph = 80, gap = 8;
    const x0 = (W - cols * pw - (cols - 1) * gap) / 2, y0 = 130;
    for (let r = 0; r < rows; r++)
      for (let k = 0; k < cols; k++) paintBrand(g, brands[(r * 2 + k) % brands.length], x0 + k * (pw + gap), y0 + r * (ph + gap), pw, ph);
    return toTex(c, { repeat: false });
  });
}

export function brandTexture(id, w = 512, h = 256) {
  return cached(`brand-${id}-${w}x${h}`, () => {
    const [c, g] = mk(w, h);
    paintBrand(g, id, 0, 0, w, h);
    return toTex(c, { repeat: false });
  });
}

export function chevronTexture(bg = '#ffd000', fg = '#1a1a1a') {
  return cached('chev' + bg + fg, () => {
    const [c, g] = mk(256, 128);
    g.fillStyle = bg;
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = fg;
    for (let i = 0; i < 4; i++) {
      const x = 20 + i * 60;
      g.beginPath();
      g.moveTo(x, 16);
      g.lineTo(x + 26, 16);
      g.lineTo(x + 56, 64);
      g.lineTo(x + 26, 112);
      g.lineTo(x, 112);
      g.lineTo(x + 30, 64);
      g.closePath();
      g.fill();
    }
    return toTex(c, { repeat: false });
  });
}

// Boost pads: blue neon arrows (the blue arrows from the City 11 concept art)
export function boostPadTexture(color = '#27c7ff') {
  return cached('boost' + color, () => {
    const [c, g] = mk(256, 512);
    g.clearRect(0, 0, 256, 512);
    g.fillStyle = 'rgba(10,30,60,0.55)';
    g.fillRect(0, 0, 256, 512);
    g.shadowColor = color;
    g.shadowBlur = 24;
    g.fillStyle = color;
    for (let i = 0; i < 4; i++) {
      const y = 480 - i * 120;
      g.beginPath();
      g.moveTo(28, y);
      g.lineTo(128, y - 80);
      g.lineTo(228, y);
      g.lineTo(228, y - 36);
      g.lineTo(128, y - 116);
      g.lineTo(28, y - 36);
      g.closePath();
      g.fill();
    }
    g.shadowBlur = 0;
    g.strokeStyle = color;
    g.lineWidth = 8;
    g.strokeRect(4, 4, 248, 504);
    const t = toTex(c, { repeat: false });
    return t;
  });
}

export function softDotTexture() {
  return cached('dot', () => {
    const [c, g] = mk(64, 64);
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.7)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return toTex(c, { repeat: false, srgb: false });
  });
}

export function cloudTexture() {
  return cached('cloud', () => {
    const [c, g] = mk(256, 128);
    const rnd = mulberry32(99);
    for (let i = 0; i < 26; i++) {
      const x = 40 + rnd() * 176, y = 50 + rnd() * 40, r = 18 + rnd() * 30;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.95)');
      grd.addColorStop(0.6, 'rgba(255,255,255,0.6)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    return toTex(c, { repeat: false });
  });
}

export function textTexture(text, { w = 512, h = 128, bg = null, fg = '#fff', font = 'italic 900 80px "Arial Black", Arial', stroke = null } = {}) {
  return cached(`txt${text}${w}${h}${bg}${fg}${font}${stroke}`, () => {
    const [c, g] = mk(w, h);
    if (bg) {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
    }
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = 10;
      g.strokeText(text, w / 2, h / 2, w - 24);
    }
    g.fillStyle = fg;
    g.fillText(text, w / 2, h / 2, w - 24);
    return toTex(c, { repeat: false });
  });
}

export function rockTexture(base = '#b5532f') {
  return cached('rock' + base, () => {
    const S = 256;
    const [c, g] = mk(S, S);
    const rnd = mulberry32(5);
    noiseFill(g, S, S, base, 0.25, rnd, 4);
    for (let y = 0; y < S; y += 14) {
      g.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.1})`;
      g.fillRect(0, y, S, 3 + rnd() * 4);
    }
    return toTex(c);
  });
}

export function tunnelTexture() {
  return cached('tunnel', () => {
    const [c, g] = mk(256, 256);
    g.fillStyle = '#3b3f4a';
    g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 32) {
      g.fillStyle = '#343842';
      g.fillRect(0, y, 256, 2);
    }
    g.fillStyle = '#fff7d0';
    g.shadowColor = '#fff2a8';
    g.shadowBlur = 20;
    g.fillRect(118, 20, 20, 90);
    g.shadowBlur = 0;
    g.fillStyle = '#2aa8ff';
    g.fillRect(0, 230, 256, 8);
    return toTex(c);
  });
}
