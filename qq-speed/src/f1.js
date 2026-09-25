// Formula 1: teams, the 24 Grands Prix, and the map configs built from them.
// Circuits are sketches of the real layouts ([x, z, y] with y = elevation in meters), scaled to a raceable length at load.

export const F1_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

// Liveries are approximations of the team colors; no logos
// `dot` is the color used on the minimap and standings when the main livery color is too dark to see
export const TEAMS = [
  { id: 'mclaren', name: 'McLaren', body: 0xff8000, accent: 0x1b1b1b, trim: 0x47c7fc, pace: 1.0 },
  { id: 'ferrari', name: 'Ferrari', body: 0xdc0000, accent: 0x111111, trim: 0xfff200, pace: 0.995 },
  { id: 'mercedes', name: 'Mercedes', dot: 0x00d2be, body: 0x1d1f22, accent: 0xc0c6cc, trim: 0x00d2be, pace: 0.993 },
  { id: 'redbull', name: 'Red Bull Racing', dot: 0x3671c6, body: 0x1e2a4a, accent: 0xe21b4d, trim: 0xffc906, pace: 0.99 },
  { id: 'aston', name: 'Aston Martin', body: 0x00665e, accent: 0x0f1a18, trim: 0xcedc00, pace: 0.978 },
  { id: 'williams', name: 'Williams', dot: 0x00a3e0, body: 0x0a2a6e, accent: 0xffffff, trim: 0x00a3e0, pace: 0.976 },
  { id: 'alpine', name: 'Alpine', body: 0x0078c1, accent: 0x111111, trim: 0xff87bc, pace: 0.972 },
  { id: 'rb', name: 'Racing Bulls', body: 0xf2f2f2, accent: 0x1634cc, trim: 0xe8002d, pace: 0.97 },
  { id: 'audi', name: 'Audi', body: 0x9aa0a6, accent: 0x151515, trim: 0xff2d2d, pace: 0.968 },
  { id: 'haas', name: 'Haas', body: 0xf4f4f4, accent: 0x1b1b1b, trim: 0xe10600, pace: 0.966 },
  { id: 'cadillac', name: 'Cadillac', dot: 0xc9a24a, body: 0x141414, accent: 0xeeeeee, trim: 0xc9a24a, pace: 0.958 },
];

// Every F1 car shares this handling; team pace nudges straight-line speed and acceleration
const F1_TUNE = { vmax: 64, vmaxNitro: 83, accel: 31, nitroAccel: 45, brake: 62, turnRate: 2.15, grip: 16, driftYaw: 1.4, driftGrip: 2.2, maxDriftAngle: 1.05, gaugeRate: 0.4 };
export function teamTune(team) {
  return { ...F1_TUNE, vmax: F1_TUNE.vmax * team.pace, vmaxNitro: F1_TUNE.vmaxNitro * team.pace, accel: F1_TUNE.accel * (0.5 + 0.5 * team.pace) };
}

// ---------- Scenery themes ----------
const THEMES = {
  park: {
    sky: { top: '#2f7fe0', horizon: '#d6ecff', bottom: '#8fb8d8', sun: [-0.45, 0.62, -0.55], sunColor: '#fff4dc', sunI: 2.6 },
    hemi: ['#d6ecff', '#6f8a5a', 1.1], fog: ['#cfe6fb', 380, 2300], ground: 'grass', tint: [0.9, 0.98, 0.86],
    mountains: { color: 0x6f95b8, r0: 1600, r1: 500, h0: 120, h1: 180 }, bgm: 0,
    props: { trees: 'tree', treeCount: 700, skyline: { kinds: ['glass', 'modern', 'office'], density: 0.25, h: [20, 70], ring: 260 } },
  },
  city: {
    sky: { top: '#3a86e0', horizon: '#e2efff', bottom: '#9cc0dc', sun: [0.4, 0.6, -0.5], sunColor: '#fff2d6', sunI: 2.6 },
    hemi: ['#e0efff', '#7a8a6a', 1.1], fog: ['#d9e8f7', 380, 2300], ground: 'grass', tint: [0.86, 0.92, 0.84],
    mountains: { color: 0x7c93ad, r0: 1600, r1: 500, h0: 110, h1: 170 }, bgm: 0,
    props: { trees: 'tree', treeCount: 350, skyline: { kinds: ['glass', 'modern', 'office'], density: 0.55, h: [24, 110], ring: 120 } },
  },
  forest: {
    sky: { top: '#3f86d6', horizon: '#e3f0ff', bottom: '#a9c4dc', sun: [-0.3, 0.55, 0.6], sunColor: '#fff6e0', sunI: 2.5 },
    hemi: ['#e6f2ff', '#5f7d4a', 1.15], fog: ['#dbe9f5', 360, 2200], ground: 'grass', tint: [0.82, 0.95, 0.8],
    mountains: { color: 0x5f7f5a, r0: 1400, r1: 500, h0: 200, h1: 260 }, bgm: 3,
    props: { trees: 'pine', treeCount: 1100, pineSnow: false, skyline: null },
  },
  coast: {
    sky: { top: '#2f86e6', horizon: '#e0f2ff', bottom: '#9cc6e6', sun: [0.5, 0.55, -0.45], sunColor: '#fff1d6', sunI: 2.7 },
    hemi: ['#e8f4ff', '#a39a7a', 1.12], fog: ['#dcefff', 420, 2400], ground: 'grass', tint: [0.95, 1.0, 0.86],
    water: { color: '#1a8fd8', deep: '#07477f', y: -1.6 }, sea: true,
    mountains: { color: 0x8f9a7a, r0: 1500, r1: 500, h0: 150, h1: 220 }, bgm: 1,
    props: { trees: 'palm', treeCount: 260, boats: true, skyline: { kinds: ['modern', 'office', 'glass'], density: 0.45, h: [14, 60], ring: 120 } },
  },
  dry: {
    sky: { top: '#3b86d8', horizon: '#f6ead2', bottom: '#dcc9a6', sun: [0.35, 0.6, 0.5], sunColor: '#fff0cf', sunI: 2.8 },
    hemi: ['#fff1d8', '#a88f5a', 1.05], fog: ['#efe2c6', 420, 2500], ground: 'sand', tint: [0.95, 0.93, 0.85],
    mountains: { color: 0xb09a72, r0: 1500, r1: 600, h0: 90, h1: 140 }, bgm: 2,
    props: { trees: 'tree', treeCount: 250, skyline: { kinds: ['modern', 'office'], density: 0.2, h: [14, 40], ring: 200 } },
  },
  desertNight: {
    sky: { top: '#0a1030', horizon: '#6a4a6e', bottom: '#2a2030', sun: [-0.4, 0.45, 0.6], sunColor: '#c8d4ff', sunI: 1.2 },
    hemi: ['#8a90c8', '#6a5040', 1.0], fog: ['#3a3050', 380, 2200], ground: 'sand', tint: [0.72, 0.66, 0.6],
    mountains: { color: 0x5a4a44, r0: 1500, r1: 600, h0: 60, h1: 100 }, bgm: 2,
    props: { trees: 'palm', treeCount: 180, night: true, floodlights: true, skyline: { kinds: ['night'], density: 0.18, h: [20, 70], ring: 220 } },
  },
  nightCity: {
    sky: { top: '#070b24', horizon: '#3b2a78', bottom: '#15122e', sun: [0.3, 0.6, -0.5], sunColor: '#b8c6ff', sunI: 1.1 },
    hemi: ['#6a78c8', '#2a2440', 1.05], fog: ['#2a2358', 300, 1900], ground: 'grass', tint: [0.22, 0.25, 0.38],
    mountains: { color: 0x241f4a, r0: 1500, r1: 500, h0: 120, h1: 180 }, bgm: 0,
    props: { trees: 'tree', treeCount: 200, night: true, floodlights: true, skyline: { kinds: ['night'], density: 0.6, h: [30, 140], ring: 110 } },
  },
  nightCoast: {
    sky: { top: '#081230', horizon: '#40407a', bottom: '#15122e', sun: [0.3, 0.6, -0.5], sunColor: '#b8c6ff', sunI: 1.1 },
    hemi: ['#6a78c8', '#2a2440', 1.05], fog: ['#262a58', 320, 2000], ground: 'sand', tint: [0.6, 0.58, 0.62],
    water: { color: '#0e3a6e', deep: '#04142c', y: -1.6 }, sea: true,
    mountains: { color: 0x2a2848, r0: 1500, r1: 500, h0: 80, h1: 120 }, bgm: 2,
    props: { trees: 'palm', treeCount: 200, night: true, floodlights: true, boats: true, skyline: { kinds: ['night'], density: 0.35, h: [30, 120], ring: 150 } },
  },
};

// ---------- The calendar ----------
// sketch units are arbitrary; `len` is the target lap length in meters
export const GPS = [
  { id: 'australia', name: 'Australian GP', circuit: 'Albert Park, Melbourne', flag: '🇦🇺', theme: 'park', len: 2500, lake: true,
    sketch: [[0, 0], [40, 0], [48, 6], [46, 14], [54, 20], [64, 16], [74, 22], [82, 34], [96, 40], [104, 52], [98, 62], [86, 64], [72, 60], [58, 66], [40, 70], [24, 66], [12, 58], [6, 46], [-4, 40], [-10, 28], [-8, 12]] },
  { id: 'china', name: 'Chinese GP', circuit: 'Shanghai International Circuit', flag: '🇨🇳', theme: 'city', len: 2700,
    sketch: [[0, 0], [60, 0], [74, -8], [76, -22], [66, -30], [56, -24], [48, -30], [40, -44], [52, -54], [66, -50], [74, -58], [70, -70], [20, -72], [-30, -72], [-40, -66], [-34, -58], [-10, -54], [0, -44], [-12, -34], [-20, -20], [-12, -8]] },
  { id: 'japan', name: 'Japanese GP', circuit: 'Suzuka', flag: '🇯🇵', theme: 'forest', len: 2800, hills: 8, crossover: true,
    // figure of eight: the back straight crosses over the run to the hairpin
    sketch: [[-30, 0, 0], [10, 0, 0], [30, 0, 0], [42, -6, 0], [44, -18, 0], [36, -24, 0], [28, -20, 0], [20, -26, 0], [14, -34, 0], [6, -40, 0], [-4, -46, 0], [-14, -54, 0], [-22, -62, 0], [-26, -72, 0], [-18, -80, 0], [-6, -76, 0], [6, -82, 0], [18, -88, 0], [30, -84, 0], [30, -72, 3], [16, -60, 7], [1, -48, 8], [-12, -37, 7], [-24, -28, 3], [-34, -20, 0], [-40, -12, 0], [-40, -4, 0]] },
  { id: 'bahrain', name: 'Bahrain GP', circuit: 'Bahrain International Circuit', flag: '🇧🇭', theme: 'desertNight', len: 2600,
    sketch: [[0, 0], [60, 0], [70, -6], [66, -14], [58, -14], [54, -22], [60, -30], [72, -34], [84, -40], [80, -50], [70, -52], [62, -60], [50, -58], [44, -50], [30, -48], [18, -56], [6, -62], [-8, -58], [-14, -48], [-8, -38], [-16, -28], [-18, -16], [-12, -6]] },
  { id: 'saudi', name: 'Saudi Arabian GP', circuit: 'Jeddah Corniche', flag: '🇸🇦', theme: 'nightCoast', len: 3000,
    sketch: [[76, 4], [56, 8], [36, 6], [20, 10], [4, 9], [-6, 2], [-4, -8], [8, -12], [24, -12], [34, -14], [46, -10], [58, -16], [72, -12], [86, -18], [100, -14], [112, -20], [122, -18], [134, -12], [137, -2], [127, 4], [112, 4], [96, 6]] },
  { id: 'miami', name: 'Miami GP', circuit: 'Miami International Autodrome', flag: '🇺🇸', theme: 'coast', len: 2600,
    sketch: [[0, 0], [40, 0], [52, 6], [54, 18], [46, 28], [40, 40], [48, 50], [62, 52], [74, 46], [80, 34], [92, 30], [100, 40], [96, 56], [84, 66], [60, 70], [30, 70], [10, 64], [-2, 54], [-6, 40], [-2, 28], [-8, 16], [-8, 6]] },
  { id: 'canada', name: 'Canadian GP', circuit: 'Circuit Gilles Villeneuve, Montréal', flag: '🇨🇦', theme: 'park', len: 2700, lake: true,
    sketch: [[60, -10], [80, -14], [100, -10], [116, -16], [128, -12], [133, -4], [127, 3], [112, 5], [96, 10], [70, 8], [50, 12], [30, 10], [12, 12], [0, 8], [-4, -2], [6, -10], [20, -8], [40, -14]] },
  { id: 'monaco', name: 'Monaco GP', circuit: 'Circuit de Monaco', flag: '🇲🇨', theme: 'coast', len: 2000, hills: 6, dense: true,
    sketch: [[0, 0, 0], [20, 0, 1], [26, 6, 3], [30, 16, 6], [38, 22, 8], [46, 20, 8], [50, 12, 6], [56, 8, 5], [62, 14, 4], [60, 24, 3], [54, 30, 2], [46, 36, 1], [34, 40, 0], [22, 38, 0], [14, 44, 0], [6, 40, 0], [4, 30, 0], [-4, 24, 0], [-10, 16, 0], [-8, 6, 0]] },
  { id: 'barcelona', name: 'Barcelona GP', circuit: 'Circuit de Barcelona-Catalunya', flag: '🇪🇸', theme: 'dry', len: 2600, hills: 5,
    sketch: [[0, 0], [70, 0], [80, -6], [78, -16], [86, -22], [96, -30], [92, -42], [80, -46], [68, -40], [56, -46], [44, -40], [36, -30], [24, -28], [12, -34], [2, -30], [-6, -20], [-6, -8]] },
  { id: 'austria', name: 'Austrian GP', circuit: 'Red Bull Ring, Spielberg', flag: '🇦🇹', theme: 'forest', len: 2300, hills: 14,
    sketch: [[0, 0, 0], [40, -6, 3], [50, -14, 6], [46, -24, 8], [56, -40, 10], [64, -52, 9], [56, -58, 8], [44, -50, 6], [34, -40, 5], [22, -36, 4], [12, -40, 3], [2, -34, 2], [-4, -22, 1], [-6, -10, 0]] },
  { id: 'britain', name: 'British GP', circuit: 'Silverstone', flag: '🇬🇧', theme: 'park', len: 2900,
    sketch: [[0, 0], [36, 0], [48, -4], [56, -12], [52, -24], [60, -34], [72, -38], [84, -32], [96, -40], [104, -52], [96, -62], [80, -60], [64, -66], [48, -72], [34, -66], [26, -56], [12, -52], [0, -44], [-10, -34], [-12, -20], [-8, -8]] },
  { id: 'belgium', name: 'Belgian GP', circuit: 'Spa-Francorchamps', flag: '🇧🇪', theme: 'forest', len: 3300, hills: 18,
    sketch: [[0, -10, 6], [0, 10, 7], [2, 24, 8], [8, 30, 8], [14, 26, 7], [14, 14, 5], [14, 2, 3], [12, -6, 2], [18, -14, 6], [22, -24, 11], [28, -40, 15], [34, -54, 17], [38, -62, 17], [46, -62, 16], [52, -56, 14], [62, -58, 12], [72, -66, 10], [70, -78, 8], [62, -86, 7], [66, -96, 6], [58, -106, 5], [44, -108, 5], [30, -104, 5], [16, -100, 5], [4, -94, 5], [-6, -92, 5], [-8, -84, 5], [-4, -70, 5], [-2, -40, 6]] },
  { id: 'hungary', name: 'Hungarian GP', circuit: 'Hungaroring', flag: '🇭🇺', theme: 'forest', len: 2400, hills: 8,
    sketch: [[0, 0], [40, 0], [48, 6], [46, 14], [36, 18], [30, 26], [36, 36], [48, 40], [58, 48], [70, 46], [76, 36], [70, 26], [76, 18], [86, 14], [90, 4], [82, -4], [70, -8], [58, -14], [44, -16], [30, -12], [18, -16], [6, -12]] },
  { id: 'netherlands', name: 'Dutch GP', circuit: 'Zandvoort', flag: '🇳🇱', theme: 'coast', len: 2300, hills: 6,
    sketch: [[0, 0], [40, 0], [50, 6], [46, 14], [36, 14], [30, 22], [34, 32], [44, 38], [56, 36], [64, 28], [72, 34], [74, 46], [66, 54], [50, 56], [36, 52], [20, 50], [8, 44], [0, 34], [-6, 22], [-6, 10]] },
  { id: 'italy', name: 'Italian GP', circuit: 'Monza', flag: '🇮🇹', theme: 'park', len: 2900,
    sketch: [[0, 0], [50, 0], [58, 4], [66, 0], [76, 2], [88, 8], [96, 18], [100, 30], [96, 40], [90, 46], [92, 54], [86, 60], [70, 64], [50, 66], [38, 70], [30, 66], [20, 62], [4, 58], [-10, 52], [-18, 40], [-18, 26], [-14, 12], [-8, 4]] },
  { id: 'madrid', name: 'Spanish GP', circuit: 'Madring, Madrid', flag: '🇪🇸', theme: 'city', len: 2600,
    sketch: [[0, 0], [50, 0], [60, 8], [58, 20], [48, 24], [44, 34], [52, 44], [66, 46], [78, 40], [84, 28], [92, 20], [102, 24], [104, 38], [96, 50], [80, 58], [60, 62], [40, 58], [24, 52], [12, 44], [4, 32], [-4, 20], [-6, 8]] },
  { id: 'azerbaijan', name: 'Azerbaijan GP', circuit: 'Baku City Circuit', flag: '🇦🇿', theme: 'coast', len: 2900, dense: true,
    sketch: [[0, 0], [20, 0], [22, 10], [32, 12], [34, 22], [44, 24], [46, 34], [40, 42], [30, 44], [28, 54], [36, 62], [30, 70], [18, 70], [10, 62], [-10, 62], [-40, 60], [-70, 56], [-90, 50], [-96, 40], [-90, 30], [-70, 24], [-50, 18], [-30, 10], [-14, 4]] },
  { id: 'singapore', name: 'Singapore GP', circuit: 'Marina Bay Street Circuit', flag: '🇸🇬', theme: 'nightCity', len: 2500,
    sketch: [[0, 0], [30, 0], [36, -8], [46, -10], [48, -20], [40, -26], [42, -36], [54, -38], [66, -32], [70, -20], [80, -16], [86, -6], [80, 4], [68, 6], [60, 14], [48, 16], [36, 24], [20, 24], [8, 18], [-4, 20], [-12, 12], [-8, 4]] },
  { id: 'usa', name: 'United States GP', circuit: 'Circuit of the Americas, Austin', flag: '🇺🇸', theme: 'dry', len: 2800, hills: 6,
    sketch: [[0, 0, 0], [30, 0, 1], [40, -6, 6], [47, 0, 8], [43, 9, 7], [44, 18, 6], [50, 24, 5], [60, 20, 5], [70, 26, 4], [78, 36, 3], [74, 46, 3], [62, 50, 2], [40, 56, 1], [14, 62, 0], [-6, 60, 0], [-12, 52, 0], [-8, 44, 0], [-16, 36, 0], [-24, 40, 0], [-30, 32, 0], [-26, 22, 0], [-18, 16, 0], [-14, 6, 0]] },
  { id: 'mexico', name: 'Mexico City GP', circuit: 'Autódromo Hermanos Rodríguez', flag: '🇲🇽', theme: 'city', len: 2600,
    sketch: [[0, 0], [60, 0], [70, 6], [66, 14], [72, 22], [82, 24], [88, 34], [84, 44], [72, 46], [62, 52], [50, 50], [40, 56], [30, 50], [34, 42], [26, 38], [14, 40], [4, 34], [-4, 24], [-6, 12]] },
  { id: 'brazil', name: 'São Paulo GP', circuit: 'Interlagos', flag: '🇧🇷', theme: 'city', len: 2400, hills: 10,
    sketch: [[0, 0, 8], [14, -2, 6], [22, -10, 4], [34, -18, 2], [54, -20, 1], [66, -14, 1], [66, -4, 2], [56, 2, 3], [50, 12, 4], [56, 22, 5], [48, 30, 6], [36, 26, 6], [28, 32, 7], [16, 32, 8], [6, 26, 9], [-6, 22, 9], [-14, 14, 9], [-12, 4, 9]] },
  { id: 'lasvegas', name: 'Las Vegas GP', circuit: 'Las Vegas Strip Circuit', flag: '🇺🇸', theme: 'nightCity', len: 2900,
    sketch: [[0, 0], [40, 0], [46, 6], [44, 16], [52, 22], [60, 20], [62, 10], [70, 4], [100, 4], [130, 4], [140, 10], [140, 24], [132, 30], [100, 32], [70, 32], [40, 34], [20, 34], [6, 30], [0, 20], [-4, 10]] },
  { id: 'qatar', name: 'Qatar GP', circuit: 'Lusail International Circuit', flag: '🇶🇦', theme: 'desertNight', len: 2700,
    sketch: [[0, 0], [60, 0], [72, -4], [76, -14], [68, -22], [74, -32], [86, -36], [94, -46], [88, -58], [74, -60], [62, -54], [50, -58], [36, -54], [26, -46], [14, -48], [2, -42], [-6, -32], [-4, -20], [-8, -10]] },
  { id: 'abudhabi', name: 'Abu Dhabi GP', circuit: 'Yas Marina', flag: '🇦🇪', theme: 'nightCoast', len: 2800,
    sketch: [[0, 0], [20, 0], [26, -8], [22, -18], [30, -26], [60, -26], [90, -26], [104, -30], [110, -40], [102, -48], [88, -46], [70, -50], [54, -48], [44, -54], [36, -50], [30, -40], [18, -36], [6, -40], [-4, -34], [-8, -22], [-6, -10]] },
];

// Scale a sketch so the (straight-segment) lap length matches `len`, and center it on the origin
export function circuitPoints(gp) {
  const P = gp.sketch.map((p) => [p[0], p[1], p[2] || 0]);
  let L = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const k = (gp.len / L) * 1.02; // the spline cuts corners slightly, so aim a touch long
  const cx = P.reduce((s, p) => s + p[0], 0) / P.length, cz = P.reduce((s, p) => s + p[1], 0) / P.length;
  return P.map(([x, z, y]) => [Math.round((x - cx) * k), Math.round((z - cz) * k), y]);
}

// Map configs in the same shape as maps.js, so the rest of the game can load a Grand Prix like any other track
export const F1_MAPS = GPS.map((gp) => {
  const th = THEMES[gp.theme];
  return {
    id: 'f1-' + gp.id,
    name: gp.name,
    tag: gp.circuit,
    f1: gp,
    theme: th,
    layoutData: { width: 24, points: circuitPoints(gp) },
    sky: th.sky, hemi: th.hemi, fog: th.fog, ground: th.ground, groundTint: '#ffffff',
    water: th.water || (gp.lake ? { color: '#2a7fc0', deep: '#0b3f7a', y: -1.6 } : undefined),
    mountains: th.mountains,
    track: {
      road: 'asphalt', wall: 'city', curbA: '#e10600', curbB: '#ffffff', deckColor: 0x9aa0aa,
      checkerA: '#101010', checkerB: '#ffffff', boostColor: '#27c7ff',
      boostPads: [],
      shoulder: { width: 10, tex: 'plaza' },
    },
    // only Suzuka's crossover is a real bridge; elsewhere the ground follows the track up and down
    isBridge: gp.crossover ? (x, z, y) => y > 5.5 : undefined,
    bgm: th.bgm,
  };
});
