// Road car geometry. A body is lofted: cross-sections swept along the car rather than one side profile pushed out
// sideways, so it gets rounded corners in plan, a crowned hood, sides that lean in toward the roof, fenders that swell
// over the wheels and arches with dark wells. The greenhouse is lofted the same way. Wheels have rounded tyres and
// rims in a few styles (the garage picks one). Car space: x across, y up, z along the car (+ is the nose).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const DROP = 0.1; // the body sits this much below its catalog heights, for a low, planted stance
export const WHEEL_SCALE = 0.8; // wheels a fifth smaller than the catalog's: real proportions, not toy ones

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------- 2D outlines ----------
function outline(s, pts) {
  for (const p of pts) p.length === 4 ? s.quadraticCurveTo(p[0], p[1], p[2], p[3]) : s.lineTo(p[0], p[1]);
}

// height and length lookups on a closed side outline
function sideProfile(shape) {
  const pts = shape.getPoints(20);
  pts.push(pts[0]);
  const cross = (u, v, at) => {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a[u] === b[u] || (a[u] - at) * (b[u] - at) > 0) continue;
      out.push(a[v] + ((b[v] - a[v]) * (at - a[u])) / (b[u] - a[u]));
    }
    return out;
  };
  const xs = pts.map((p) => p.x);
  const min = Math.min(...xs), max = Math.max(...xs);
  // top and bottom on a 1 cm grid, lightly smoothed, so the kinks where the outline's pieces join don't show
  // as wobbles in the paint's reflections
  const step = 0.01, n = Math.ceil((max - min) / step) + 1;
  const grid = (pick) => {
    let a = Array.from({ length: n }, (_, i) => { const c = cross('x', 'y', Math.min(max - 1e-4, Math.max(min + 1e-4, min + i * step))); return c.length ? pick(...c) : null; });
    for (let pass = 0; pass < 6; pass++) a = a.map((v, i) => (v == null || a[i - 1] == null || a[i + 1] == null ? v : 0.25 * a[i - 1] + 0.5 * v + 0.25 * a[i + 1]));
    return (x) => {
      const f = (x - min) / step, i = Math.floor(f);
      if (i < 0 || i >= n - 1 || a[i] == null || a[i + 1] == null) { const c = cross('x', 'y', x); return c.length ? pick(...c) : null; }
      return a[i] + (a[i + 1] - a[i]) * (f - i);
    };
  };
  const top = grid(Math.max), bottom = grid(Math.min);
  return {
    min, max, top, bottom,
    front: (y) => { const c = cross('y', 'x', y); return c.length ? Math.max(...c) : null; },
    rear: (y) => { const c = cross('y', 'x', y); return c.length ? Math.min(...c) : null; },
  };
}

// ---------- Loft ----------
// section(z) gives half an outline, top center (x = 0) round the right side to bottom center (x = 0), always the same
// number of points; the left half is its mirror. split: a z where faces change material (group 0 behind, 1 ahead)
function loft(zs, section, split = null) {
  const half = zs.map((z) => section(z));
  const M = half[0].length, ring = 2 * M - 2;
  const pos = new Float32Array(zs.length * ring * 3);
  let o = 0;
  zs.forEach((z, i) => {
    const h = half[i];
    for (let j = 0; j < M; j++) { pos[o++] = h[j][0]; pos[o++] = h[j][1]; pos[o++] = z; }
    for (let j = M - 2; j >= 1; j--) { pos[o++] = -h[j][0]; pos[o++] = h[j][1]; pos[o++] = z; }
  });
  const idx = [];
  let splitAt = -1;
  for (let i = 0; i < zs.length - 1; i++) {
    if (split != null && splitAt < 0 && zs[i] >= split - 1e-6) splitAt = idx.length;
    for (let j = 0; j < ring; j++) {
      const a = i * ring + j, b = i * ring + ((j + 1) % ring), c = a + ring, d = b + ring;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (split != null && splitAt > 0) { g.addGroup(0, splitAt, 0); g.addGroup(splitAt, idx.length - splitAt, 1); }
  return g;
}

// stations along the car: dense at the ends (where the plan rounds off) and around the wheel arches
function stations(z0, z1, n, extra = []) {
  const zs = [];
  for (let i = 0; i <= n; i++) zs.push(z0 + (z1 - z0) * (0.5 - 0.5 * Math.cos((Math.PI * i) / n)));
  for (const z of extra) if (z > z0 && z < z1) zs.push(z);
  zs.sort((a, b) => a - b);
  return zs.filter((z, i) => i === 0 || z - zs[i - 1] > 0.004);
}

// ---------- Body ----------
export function bodySpec(car) {
  const S = car.shape;
  const R = S.wheelR * WHEEL_SCALE;
  const shape = new THREE.Shape();
  shape.moveTo(S.len[0] + 0.08, S.sill);
  shape.lineTo(S.len[1] - 0.08, S.sill);
  outline(shape, S.top);
  shape.closePath();
  const P = sideProfile(shape);
  const B = {
    S, P, R,
    Rc: R + DROP, // wheel center in body space (the body is lowered by DROP)
    ra: R + 0.065, // arch radius
    W: S.width / 2,
    flare: Math.max(S.width / 2, S.track + S.wheelW / 2 + 0.035), // the fenders cover the tyres
    xIn: S.track - S.wheelW / 2 - 0.05, // inner wall of the wheel wells
    z0: P.min + 0.002, z1: P.max - 0.002,
    zc: (P.min + P.max) / 2, halfLen: (P.max - P.min) / 2,
    axles: S.axles,
  };
  return B;
}

// plan half-width at z: rounded corners, a slightly narrower nose, fenders flared over the wheels
function planHalf(B, z) {
  const u = Math.min(1, Math.abs(z - B.zc) / B.halfLen);
  const round = Math.pow(Math.max(0, 1 - Math.pow(u, 5)), 1 / 5);
  let w = B.W * round * (1 - 0.05 * Math.max(0, (z - B.zc) / B.halfLen));
  for (const ax of B.axles) {
    const t = Math.abs(z - ax) / (B.ra * 1.5);
    if (t < 1) w = Math.max(w, (B.W + (B.flare - B.W) * (0.5 + 0.5 * Math.cos(Math.PI * t))) * round);
  }
  return w;
}

// the top of the front and rear fenders, which rise over the wheels (above the hood on low cars)
function fenderTop(B, z) {
  let y = -1;
  for (const ax of B.axles) {
    const t = (z - ax) / (B.ra * 1.45);
    if (Math.abs(t) < 1) y = Math.max(y, B.Rc + 0.05 + B.ra * Math.sqrt(1 - t * t));
  }
  return y;
}

const TOP_N = 12, CORNER_N = 10, SIDE_N = 12;
// arches = false gives the uncut body, whose normals the cut one borrows so the paint shades smoothly up to the arch lips
function bodyHalf(B, z, arches = true) {
  const yT = B.P.top(z) ?? B.S.sill, yB = Math.min(B.P.bottom(z) ?? B.S.sill, yT - 0.002);
  const hw = Math.max(planHalf(B, z), 0.0005);
  const h = yT - yB;
  const fy = fenderTop(B, z);
  const rise = Math.max(0, fy - yT);
  const topY = (x) => yT - 0.05 * (x / hw) ** 2 + rise * smooth(B.xIn - 0.42, B.xIn + 0.1, x);
  const tumble = Math.min(0.075, 0.08 * hw) * Math.min(1, h / 0.45);
  const tuck = Math.min(0.06, 0.08 * hw);
  const rc = Math.max(0.0004, Math.min(0.17, 0.32 * (h + rise), 0.4 * hw));
  const x0 = Math.max(0, hw - tumble - rc);
  const pts = [];
  for (let k = 0; k <= TOP_N; k++) { const x = (x0 * k) / TOP_N; pts.push([x, topY(x)]); }
  const y0 = topY(x0);
  for (let k = 1; k <= CORNER_N; k++) {
    const a = (Math.PI / 2) * (1 - k / CORNER_N);
    pts.push([x0 + rc * Math.cos(a), y0 - rc + rc * Math.sin(a)]);
  }
  const yS = Math.max(yB + 0.001, y0 - rc), yR = yB + Math.min(0.06, 0.3 * (yS - yB));
  const yMax = yB + 0.42 * (yS - yB);
  let xR = hw;
  for (let k = 1; k <= SIDE_N; k++) {
    const y = yS - ((yS - yR) * k) / SIDE_N;
    const x = y > yMax ? hw - tumble * ((y - yMax) / Math.max(1e-4, yS - yMax)) ** 1.6 : hw - tuck * ((yMax - y) / Math.max(1e-4, yMax - yR)) ** 2;
    pts.push([x, y]);
    xR = x;
  }
  // rocker corner, then the floor; the extra pair at xIn makes the wheel well's inner wall
  const floor = [xR - 0.035, B.xIn + 0.003, B.xIn - 0.003, B.xIn * 0.5, 0];
  let prev = xR;
  for (const fx of floor) { const x = Math.max(0, Math.min(fx, prev - 0.0005)); pts.push([x, yB]); prev = x; }
  pts[pts.length - 1][0] = 0;
  // wheel arches: anything outboard of the well wall and inside the arch circle moves up onto it
  if (arches) for (const p of pts) {
    if (p[0] <= B.xIn) continue;
    for (const ax of B.axles) {
      const dz = z - ax, d2 = B.ra * B.ra - dz * dz;
      if (d2 > 0 && (p[1] - B.Rc) ** 2 < d2) p[1] = Math.max(p[1], B.Rc + Math.sqrt(d2));
    }
  }
  return pts;
}

export function bodyGeometry(B, split = null) {
  const extra = [];
  for (const ax of B.axles) {
    for (let d = -B.ra - 0.06; d <= B.ra + 0.06; d += 0.025) extra.push(ax + d);
    // where the arch meets the floor: a station each side, so its edge drops straight down
    const e = Math.sqrt(Math.max(0, B.ra ** 2 - (B.S.sill - B.Rc) ** 2));
    extra.push(ax - e - 0.002, ax - e + 0.002, ax + e - 0.002, ax + e + 0.002);
  }
  if (split != null) extra.push(split);
  const zs = stations(B.z0, B.z1, 96, extra);
  const g = loft(zs, (z) => bodyHalf(B, z), split);
  g.attributes.normal.array.set(loft(zs, (z) => bodyHalf(B, z, false)).attributes.normal.array);
  return g;
}

// height of the body's top surface at lateral x (the hood and fenders, not the centerline)
export function topAt(B, z, x) {
  const pts = bodyHalf(B, z, false);
  for (let i = 0; i < pts.length - 1; i++) {
    const [xa, ya] = pts[i], [xb, yb] = pts[i + 1];
    if (xa !== xb && (xa - x) * (xb - x) <= 0) return ya + ((yb - ya) * (x - xa)) / (xb - xa);
  }
  return pts[0][1];
}

// outer x of the body side at (z, y), for details that sit on it
export function sideX(B, z, y) {
  const pts = bodyHalf(B, z);
  let best = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [xa, ya] = pts[i], [xb, yb] = pts[i + 1];
    if ((ya - y) * (yb - y) > 0 || ya === yb) continue;
    best = Math.max(best, xa + ((xb - xa) * (y - ya)) / (yb - ya));
  }
  return best;
}

// where the nose (end = 1) or tail (end = -1) surface really is at (x, y), found on the lofted sections themselves;
// null if (x, y) is outside the body even mid-car
function contains(pts, x, y) {
  let inside = false;
  for (let i = 0; i < pts.length - 1; i++) {
    const [xa, ya] = pts[i], [xb, yb] = pts[i + 1];
    if ((ya > y) !== (yb > y) && xa + ((xb - xa) * (y - ya)) / (yb - ya) > x) inside = !inside;
  }
  return inside;
}
export function endZ(B, end, x, y) {
  const key = end + ':' + Math.abs(x).toFixed(3) + ':' + y.toFixed(3);
  B.ends ||= new Map();
  if (B.ends.has(key)) return B.ends.get(key);
  const ax = Math.abs(x);
  const inside = (z) => contains(bodyHalf(B, z, false), ax, y);
  let lo = B.zc, hi = end > 0 ? B.z1 : B.z0, z = null;
  if (inside(lo)) {
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inside(mid)) lo = mid; else hi = mid; }
    z = lo;
  }
  B.ends.set(key, z);
  return z;
}
// outward surface normal there (finite differences of endZ), kept from pointing too far up
export function endNormal(B, end, x, y, e = 0.03) {
  const z = endZ(B, end, x, y);
  const zx = ((endZ(B, end, x + e, y) ?? z) - (endZ(B, end, x - e, y) ?? z)) / (2 * e);
  const zy = ((endZ(B, end, x, y + e) ?? z) - (endZ(B, end, x, y - e) ?? z)) / (2 * e);
  const n = end > 0 ? new THREE.Vector3(-zx, -zy, 1) : new THREE.Vector3(zx, zy, -1);
  n.normalize();
  if (n.y > 0.8) { n.y = 0.8; const k = Math.sqrt((1 - 0.64) / (n.x * n.x + n.z * n.z)); n.x *= k; n.z *= k; }
  return n;
}

// front / rear face z at height y, set back where the plan rounds off at lateral x (a quick estimate)
export function noseZ(B, y, x = 0) {
  const f = B.P.front(y) ?? B.z1;
  const u = Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(x) / B.W), 5)), 1 / 5);
  return Math.min(f, B.zc + B.halfLen * u);
}
export function tailZ(B, y, x = 0) {
  const r = B.P.rear(y) ?? B.z0;
  const u = Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(x) / B.W), 5)), 1 / 5);
  return Math.max(r, B.zc - B.halfLen * u);
}
// top of the body at z, on the centerline
export const deckY = (B, z) => B.P.top(z) ?? B.S.sill;

// dark wheel-well liners: the arch roof and the inner wall, so the wells read as openings, not painted pockets
export function wellGeometry(B) {
  const len = B.flare - B.xIn + 0.02;
  const roof = new THREE.CylinderGeometry(B.ra - 0.012, B.ra - 0.012, len, 28, 1, true, -0.25, Math.PI + 0.5).rotateZ(Math.PI / 2);
  const wall = new THREE.CircleGeometry(B.ra - 0.012, 28, -0.25, Math.PI + 0.5).rotateY(Math.PI / 2);
  return { roof, wall, len };
}

// ---------- Greenhouse ----------
export function cabinSpec(car, B) {
  const C = car.shape.cabin;
  const shape = new THREE.Shape();
  shape.moveTo(C.pts[0][0], C.pts[0][1]);
  outline(shape, C.pts.slice(1));
  shape.closePath();
  const P = sideProfile(shape);
  const [c0, c1, c2, c3] = C.pts;
  return { P, wb: C.width / 2, z0: P.min + 0.002, z1: P.max - 0.002, zc: (P.min + P.max) / 2, halfLen: (P.max - P.min) / 2, c0, c1, c2, c3, B };
}

const CT = 5, CC = 5, CS = 4;
function cabinHalf(C, z) {
  const base = deckY(C.B, z) - 0.12;
  const yT = Math.max((C.P.top(z) ?? base) , base + 0.001);
  const u = Math.min(1, Math.abs(z - C.zc) / C.halfLen);
  const wb = Math.max(0.0005, C.wb * Math.pow(Math.max(0, 1 - Math.pow(u, 4)), 1 / 4));
  const h = yT - base;
  const wt = wb * 0.76;
  const rc = Math.max(0.0003, Math.min(0.11, 0.3 * h, 0.45 * wt));
  const x0 = Math.max(0, wt - rc);
  const pts = [];
  for (let k = 0; k <= CT; k++) { const x = (x0 * k) / CT; pts.push([x, yT - 0.035 * (x / wt) ** 2]); }
  const y0 = pts[CT][1];
  for (let k = 1; k <= CC; k++) {
    const a = (Math.PI / 2) * (1 - k / CC);
    pts.push([x0 + rc * Math.cos(a), y0 - rc + rc * Math.sin(a)]);
  }
  const [xs, ys] = pts[pts.length - 1];
  for (let k = 1; k <= CS; k++) { const t = k / CS; pts.push([xs + (wb - xs) * t, ys + (base - ys) * t]); }
  pts.push([wb * 0.5, base], [0, base]);
  return pts;
}

export function cabinGeometry(C) {
  return loft(stations(C.z0, C.z1, 44), (z) => cabinHalf(C, z));
}

// painted roof panel over the glass, from the top of the windshield to the top of the rear window
export function roofGeometry(C) {
  const za = C.c2[0] + 0.05, zb = C.c1[0] - 0.04;
  return loft(stations(za, zb, 18), (z) => {
    const p = cabinHalf(C, z).slice(0, CT + 3);
    const outer = p.map(([x, y]) => [x * 1.012 + 0.004, y + 0.012]);
    const inner = p.slice(0, -1).reverse().map(([x, y]) => [x * 0.99, y - 0.004]);
    return [...outer, ...inner];
  });
}

// pillar lines: A along the windshield's edges, C along the rear window's, B down the side between the windows
export function pillarCurves(C) {
  const corner = (z) => { const p = cabinHalf(C, z); return p[CT + CC - 1]; };
  const along = (za, zb, n) => {
    const out = [];
    for (let i = 0; i <= n; i++) { const z = za + ((zb - za) * i) / n; const [x, y] = corner(z); out.push(new THREE.Vector3(x + 0.008, y + 0.004, z)); }
    return out;
  };
  const zB = C.c2[0] + (C.c1[0] - C.c2[0]) * 0.36;
  const side = cabinHalf(C, zB).slice(CT + CC - 1);
  return {
    a: along(C.c1[0] - 0.02, C.c0[0] - 0.06, 10),
    c: along(C.c2[0] + 0.02, C.c3[0] + 0.08, 10),
    b: side.slice(0, -2).map(([x, y]) => new THREE.Vector3(x + 0.008, y, zB)),
  };
}

// ---------- Wheels ----------
// rounded tyre: a lathe around the axle (x), bead to bead
export function tyreGeometry(R, w, rimR) {
  const hw = w / 2, sh = Math.min(0.07, R * 0.16);
  const prof = [[rimR, -hw + 0.02], [R - sh, -hw], [R - sh * 0.3, -hw + sh * 0.25], [R, -hw + sh], [R, hw - sh], [R - sh * 0.3, hw - sh * 0.25], [R - sh, hw], [rimR, hw - 0.02]];
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 36);
  g.rotateZ(Math.PI / 2);
  return g;
}

export const RIMS = [
  { id: 'star', name: '5-Spoke' },
  { id: 'six', name: '6-Spoke' },
  { id: 'split', name: 'Split' },
  { id: 'mesh', name: 'Mesh' },
  { id: 'turbine', name: 'Turbine' },
  { id: 'dish', name: 'Dish' },
];
export const RIM_FOR_SPOKES = { 5: 'star', 6: 'six', 8: 'mesh', 10: 'split' };

// a spoke from the hub out to the rim, in the wheel's face (y-z plane), dished: the hub sits deeper than the rim
function spoke(rIn, rOut, wIn, wOut, t, dish, angle, twist = 0) {
  const s = new THREE.Shape();
  s.moveTo(-wIn / 2, rIn); s.lineTo(wIn / 2, rIn); s.lineTo(wOut / 2, rOut); s.lineTo(-wOut / 2, rOut); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
  g.translate(0, 0, -t / 2);
  // shape x,y = across, out along the spoke; extrude z = axle. Lean it back (dish), twist (turbine), then turn into place
  g.rotateY(twist);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) - dish * (1 - (pos.getY(i) - rIn) / (rOut - rIn)));
  g.rotateZ(angle);
  g.rotateY(Math.PI / 2); // axle along x
  g.computeVertexNormals();
  return g;
}

// rim face (spokes, lip, cap and lug nuts) as one geometry, outer face toward +x; holes: dark recesses for the dish
const rimCache = new Map();
export function rimGeometry(style, R) {
  const key = style + R.toFixed(3);
  if (rimCache.has(key)) return rimCache.get(key);
  const rimR = R * 0.74, hub = R * 0.15, t = 0.035, dish = 0.045;
  const parts = [], holes = [];
  const lip = new THREE.TorusGeometry(rimR - 0.012, 0.016, 8, 40).rotateY(Math.PI / 2);
  parts.push(lip);
  const n = { star: 5, six: 6, split: 5, mesh: 10, turbine: 12 }[style] || 0;
  for (let k = 0; k < n; k++) {
    const a = (k * Math.PI * 2) / n;
    if (style === 'star' || style === 'six') parts.push(spoke(hub * 0.9, rimR - 0.02, 0.1, 0.065, t, dish, a));
    else if (style === 'split') for (const d of [-0.11, 0.11]) parts.push(spoke(hub * 0.9, rimR - 0.02, 0.05, 0.035, t, dish, a + d * 0.6));
    else if (style === 'mesh') { parts.push(spoke(hub, rimR - 0.02, 0.035, 0.026, t * 0.8, dish, a + 0.16)); parts.push(spoke(hub, rimR - 0.02, 0.035, 0.026, t * 0.8, dish, a - 0.16)); }
    else if (style === 'turbine') parts.push(spoke(hub, rimR - 0.02, 0.07, 0.09, 0.012, dish * 0.7, a, 0.7));
  }
  if (style === 'dish') {
    const disc = new THREE.CircleGeometry(rimR - 0.015, 40).rotateY(Math.PI / 2);
    disc.translate(-0.012, 0, 0);
    parts.push(disc);
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI * 2) / 6, r = (rimR + hub) * 0.52;
      holes.push(new THREE.CircleGeometry(R * 0.11, 16).rotateY(Math.PI / 2).translate(-0.008, Math.cos(a) * r, Math.sin(a) * r));
    }
  }
  // center cap with five lug nuts round it
  parts.push(new THREE.CylinderGeometry(hub * 0.75, hub * 0.85, 0.05, 20).rotateZ(Math.PI / 2).translate(-dish - 0.005, 0, 0));
  for (let k = 0; k < 5; k++) {
    const a = (k * Math.PI * 2) / 5;
    parts.push(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 6).rotateZ(Math.PI / 2).translate(-dish + 0.012, Math.cos(a) * hub * 0.62, Math.sin(a) * hub * 0.62));
  }
  const norm = (g) => (g.index ? g.toNonIndexed() : g);
  const out = { face: mergeGeometries(parts.map((g) => { g.deleteAttribute('uv'); return norm(g); })), holes: holes.length ? mergeGeometries(holes.map((g) => { g.deleteAttribute('uv'); return norm(g); })) : null, rimR };
  rimCache.set(key, out);
  return out;
}
