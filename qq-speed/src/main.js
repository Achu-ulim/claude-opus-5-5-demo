import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LAYOUTS } from './layouts.js';
import { MAPS, MODES } from './maps.js';
import { Track } from './track.js';
import { buildSky, buildClouds, buildGround, buildWater, buildMountains, Batch, makeNoise } from './world.js';
import { buildProps, isFree } from './props.js';
import { buildCar, buildF1Car, CARS, carSpecs, renderCarThumbs, renderTeamThumbs } from './carModel.js';
import { F1_MAPS, GPS, TEAMS, teamTune } from './f1.js';
import { PlayerCar, NO_INPUT } from './vehicle.js';
import { AICar } from './ai.js';
import { League, CUPS, POINTS } from './league.js';
import { Confetti } from './confetti.js';
import { pitLayout, buildPitLane } from './pitlane.js';
import { RaceSim } from './racesim.js';
import { Particles, SkidMarks } from './effects.js';
import { GameAudio } from './audio.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { ItemSystem } from './items.js';
import { clamp, lerp, damp, dampAngle, wrapAngle, mulberry32, formatTime, smoothstep } from './util.js';
import { setMaxAniso } from './textures.js';

const $ = (id) => document.getElementById(id);
const mapById = (id) => MAPS.find((m) => m.id === id) || F1_MAPS.find((m) => m.id === id);
const ordinal = (n) => { const v = n % 100; return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'); };
const STORE = 'feiche3d.v1';
const DIFFS = [
  { id: 0, name: 'Rookie', skill: [0.55, 0.75], rubber: [0.88, 1.03] },
  { id: 1, name: 'Skilled', skill: [0.85, 1.05], rubber: [0.93, 1.06] },
  { id: 2, name: 'Legend', skill: [1.2, 1.38], rubber: [0.97, 1.1] },
];
const QUALITY = [
  { id: 'low', name: 'Smooth' },
  { id: 'mid', name: 'Balanced' },
  { id: 'high', name: 'Ultra' },
];
const LAPS = [1, 2, 3, 5];
const IS_TOUCH = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const STEER = [
  { id: 'tilt', name: 'Tilt' },
  { id: 'swipe', name: 'Swipe' },
  { id: 'buttons', name: 'Buttons' },
];
const DT = 1 / 120;
const TAKEDOWN_SPEED = 11; // m/s closing speed (~40 km/h) that wrecks the car on the receiving end
const FATAL_SPEED = 20; // Grand Prix: a car-to-car hit this hard (~72 km/h closing) retires the car
const FATAL_WALL = 45; // Grand Prix: speed into the wall (m/s) that retires the car: head-on at ~160 km/h or a steep hit flat out

// ---------- Terrain base function ----------
// Grands Prix: gentle (or hilly) ground, the sea beyond the north edge on coastal circuits, a lake in open infield
function f1Base(map, noise, track, lake) {
  const { cx, cz, maxZ } = track.bounds;
  const hills = map.f1.hills || 3;
  return (x, z) => {
    let h = 1 + noise.fbm(x * 0.004, z * 0.004, 4) * hills + Math.max(0, Math.hypot(x - cx, z - cz) - 850) * 0.12;
    if (map.theme.sea) h -= 14 * smoothstep(maxZ + 50, maxZ + 170, z);
    if (lake) h = lerp(-5, h, smoothstep(lake[2] * 0.6, lake[2], Math.hypot(x - lake[0], z - lake[1])));
    return h;
  };
}
function f1Tint(map, noise) {
  const [r, g, b] = map.theme.tint;
  return (x, z, h, col) => {
    const n = noise(x * 0.02, z * 0.02);
    if (h < -0.8) col.setRGB(1.2, 1.1, 0.85);
    else col.setRGB(r + n * 0.1, g + n * 0.06, b);
  };
}

function baseFor(id, noise, track, oases) {
  const { cx, cz } = track.bounds;
  if (id === 'city')
    return (x, z) => {
      const r = Math.abs(z);
      const river = r < 44 ? -6 : r < 64 ? lerp(-6, 0, smoothstep(44, 64, r)) : 0;
      return river + Math.max(0, Math.hypot(x - cx, z - cz) - 950) * 0.12;
    };
  if (id === 'aegean')
    return (x, z) => {
      const land = Math.pow(clamp((z + 195) / 420, 0, 1), 0.8) * 16 + noise.fbm(x * 0.008, z * 0.008) * 5 + Math.max(0, Math.hypot(x - cx, z - cz) - 900) * 0.1;
      return lerp(land, -14, smoothstep(-200, -262, z));
    };
  if (id === 'egypt')
    return (x, z) => {
      let h = 2 + noise.fbm(x * 0.0045, z * 0.0045, 4) * 18 + Math.max(0, Math.hypot(x - cx, z - cz) - 900) * 0.1;
      for (const [ox, oz, r] of oases) {
        const d = Math.hypot(x - ox, z - oz);
        if (d < r + 25) h = lerp(-2.6, h, smoothstep(r - 6, r + 25, d));
      }
      return h;
    };
  if (id === 'neon') return (x, z) => Math.max(0, Math.hypot(x - cx, z - cz) - 800) * 0.1;
  if (id === 'bay')
    return (x, z) => {
      // a channel along x = 0, hills rising to the north
      const r = Math.abs(x);
      const channel = r < 46 ? -6 : r < 66 ? lerp(-6, 0, smoothstep(46, 66, r)) : 0;
      const hills = smoothstep(-80, 320, z) * 24 + noise.fbm(x * 0.006, z * 0.006) * 5;
      return channel + (r < 66 ? 0 : hills * smoothstep(66, 140, r)) + Math.max(0, Math.hypot(x - cx, z - cz) - 900) * 0.12;
    };
  if (id === 'dune') return (x, z) => 1 + noise.fbm(x * 0.005, z * 0.005, 3) * 5 + Math.max(0, Math.hypot(x - cx, z - cz) - 850) * 0.1;
  return (x, z) => 3 + noise.fbm(x * 0.004, z * 0.004, 4) * 26 + Math.max(0, Math.hypot(x - cx, z - cz) - 650) * 0.18;
}

function tintFor(id, noise) {
  return (x, z, h, col) => {
    const n = noise(x * 0.02, z * 0.02);
    if (id === 'city') {
      if (h < -0.8) col.setRGB(1.25, 1.1, 0.8);
      else col.setRGB(0.88 + n * 0.2, 0.97 + n * 0.08, 0.86);
    } else if (id === 'aegean') {
      if (h < -0.5) col.setRGB(1.35, 1.25, 1.0);
      else { const r = clamp(0.5 + n * 1.2, 0, 1); col.setRGB(lerp(0.85, 1.2, r), lerp(1.0, 1.05, r), lerp(0.75, 1.0, r)); }
    } else if (id === 'egypt') {
      if (h < -1) col.setRGB(0.6, 0.85, 0.45);
      else col.setRGB(1 + n * 0.1, 0.97 + n * 0.08, 0.92);
    } else if (id === 'neon') col.setRGB(0.22 + n * 0.05, 0.25 + n * 0.05, 0.38);
    else if (id === 'bay') {
      if (h < -0.8) col.setRGB(1.2, 1.08, 0.8);
      else col.setRGB(0.9 + n * 0.2, 0.95 + n * 0.08, 0.8);
    } else if (id === 'dune') col.setRGB(1.05 + n * 0.1, 0.95 + n * 0.08, 0.86);
    else col.setRGB(0.92 + n * 0.06, 0.96 + n * 0.04, 1.0);
  };
}

const MOUNTAINS = {
  city: { color: 0x6f95b8, r0: 1600, r1: 500, h0: 140, h1: 200 },
  aegean: { color: 0x9c9a74, r0: 1500, r1: 500, h0: 140, h1: 220 },
  egypt: { color: 0xd9ae72, r0: 1500, r1: 600, h0: 50, h1: 90, count: 40 },
  snow: { color: 0x6f8fb8, cap: 0xf2f7ff, r0: 1400, r1: 500, h0: 240, h1: 300 },
  neon: { color: 0x241f4a, r0: 1500, r1: 500, h0: 120, h1: 180 },
  bay: { color: 0x7d9a6a, r0: 1500, r1: 500, h0: 150, h1: 220 },
  dune: { color: 0xd99a62, r0: 1500, r1: 600, h0: 60, h1: 100 },
};

class Game {
  constructor() {
    this.settings = Object.assign({ map: 'city', mode: 'speed', skin: 0, laps: 2, diff: 1, quality: IS_TOUCH ? 'mid' : 'high', song: 0, steer: 'tilt' }, this.load());
    if (!LAPS.includes(this.settings.laps)) this.settings.laps = 3;
    if (!(this.settings.skin >= 0 && this.settings.skin < CARS.length)) this.settings.skin = 0;
    this.canvas = $('gl');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    setMaxAniso(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.3, 9000);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.28;

    this.audio = new GameAudio();
    this.input = new Input();
    this.hud = new HUD();
    this.fx = this.makeFx();
    this.scene.add(this.fx.smoke.points, this.fx.glow.points, this.fx.skids.mesh);
    this.state = 'menu';
    this.time = 0;
    this.camMode = 0;
    this.shake = 0;
    this.camPos = new THREE.Vector3(0, 50, 0);
    this.camLook = new THREE.Vector3();
    this.camYaw = 0;
    this.fovK = 68;
    this.acc = 0;
    this.racers = [];
    this.ejects = [];
    this.fireworks = [];
    this.input.onKey = (code) => this.onKey(code);
    if (IS_TOUCH) {
      document.body.classList.add('touch');
      this.input.bindTouch($('touch'));
    }
    this.league = new League();
    this.confetti = new Confetti($('confetti'));
    this.setupQuality();
    this.buildMenu();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    const unlock = () => {
      this.audio.init();
      if (!this.audio.playing) this.audio.startMusic();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    // Ctrl+W closes the tab in browsers: ask for confirmation mid-race so a double boost can't close it by accident
    window.addEventListener('beforeunload', (e) => {
      if (this.state === 'race' || this.state === 'countdown' || this.state === 'paused') {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    this.loadMap(this.settings.map).then(() => {
      this.startDemo();
      this.last = performance.now();
      requestAnimationFrame(() => this.loop());
    });
  }

  load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } }
  save() { try { localStorage.setItem(STORE, JSON.stringify(this.settings)); } catch { /* ignore */ } }

  setupQuality() {
    const q = this.settings.quality;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(q === 'high' ? Math.min(dpr, 2) : q === 'mid' ? Math.min(dpr, 1.5) : 1);
    this.renderer.shadowMap.enabled = q !== 'low';
    if (this.sun) {
      this.sun.castShadow = q !== 'low';
      const ms = q === 'high' ? 2048 : 1024;
      if (this.sun.shadow.mapSize.x !== ms) {
        this.sun.shadow.mapSize.set(ms, ms);
        if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      }
    }
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      this.composer = null;
      this.bloom = null;
    }
    if (q === 'low') return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q === 'high' ? 4 : 0 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.7, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    const ph = h * this.renderer.getPixelRatio();
    this.fx.smoke.setScale(ph);
    this.fx.glow.setScale(ph);
  }

  // ---------- Menu ----------
  buildMenu() {
    const S = this.settings;
    const mapsEl = $('maps');
    mapsEl.innerHTML = MAPS.map((m) => `<div class="map" data-id="${m.id}"><div class="nm">${m.name}</div><div class="tg">${m.tag}</div></div>`).join('');
    const opts = (el, list, key, label, sub) => {
      el.innerHTML = list.map((it, i) => `<div class="opt" data-i="${i}">${label(it)}${sub ? `<small>${sub(it)}</small>` : ''}</div>`).join('');
    };
    opts($('modes'), MODES, 'mode', (m) => m.name, (m) => m.desc);
    opts($('laps'), LAPS, 'laps', (l) => `${l} lap${l > 1 ? 's' : ''}`);
    opts($('diff'), DIFFS, 'diff', (d) => d.name);
    opts($('quality'), QUALITY, 'quality', (q) => q.name);
    opts($('steer'), STEER, 'steer', (x) => x.name);
    $('steerGroup').classList.toggle('hidden', !IS_TOUCH);
    let thumbs = [];
    try { thumbs = renderCarThumbs(); } catch { /* previews are optional */ }
    const specs = carSpecs();
    $('skins').innerHTML = CARS.map((c, i) => `<div class="carcard" data-i="${i}">${thumbs[i] ? `<img src="${thumbs[i]}" alt="${c.name}">` : `<div class="swatch" style="background:#${c.body.toString(16).padStart(6, '0')}"></div>`}<div class="cn">${c.name}</div><div class="cc">${c.cls}</div></div>`).join('');
    const SPEC_ROWS = [['speed', 'Top Speed'], ['accel', '0-100 km/h'], ['handling', 'Handling'], ['drift', 'Drift'], ['nitro', 'Nitro']];
    const refresh = () => {
      mapsEl.querySelectorAll('.map').forEach((e) => e.classList.toggle('sel', e.dataset.id === S.map));
      $('modes').querySelectorAll('.opt').forEach((e) => e.classList.toggle('sel', MODES[e.dataset.i].id === S.mode));
      $('laps').querySelectorAll('.opt').forEach((e) => e.classList.toggle('sel', LAPS[e.dataset.i] === S.laps));
      $('diff').querySelectorAll('.opt').forEach((e) => e.classList.toggle('sel', +e.dataset.i === S.diff));
      $('quality').querySelectorAll('.opt').forEach((e) => e.classList.toggle('sel', QUALITY[e.dataset.i].id === S.quality));
      $('steer').querySelectorAll('.opt').forEach((e) => e.classList.toggle('sel', STEER[e.dataset.i].id === S.steer));
      this.applySteer();
      $('skins').querySelectorAll('.carcard').forEach((e) => e.classList.toggle('sel', +e.dataset.i === S.skin));
      const car = CARS[S.skin], sp = specs[S.skin];
      $('carinfo').innerHTML = `<div class="cdesc"><b>${car.name}</b> · ${car.desc}</div>` + SPEC_ROWS.map(([k, label]) =>
        `<div class="spec"><span class="sk">${label}</span><span class="sb"><i style="width:${Math.round(sp.bar[k] * 100)}%"></i></span><span class="sv">${sp.label[k]}</span></div>`).join('');
      this.save();
    };
    mapsEl.addEventListener('click', (e) => {
      const m = e.target.closest('.map');
      if (!m || m.dataset.id === S.map || this.loading) return;
      S.map = m.dataset.id;
      refresh();
      this.audio.play('click');
      this.loadMap(S.map).then(() => this.startDemo());
    });
    const bind = (id, fn) => $(id).addEventListener('click', (e) => {
      const o = e.target.closest('.opt,.carcard');
      if (!o) return;
      fn(+o.dataset.i);
      refresh();
      this.audio.play('click');
    });
    bind('modes', (i) => (S.mode = MODES[i].id));
    bind('laps', (i) => (S.laps = LAPS[i]));
    bind('diff', (i) => (S.diff = i));
    bind('quality', (i) => { S.quality = QUALITY[i].id; this.setupQuality(); });
    bind('steer', (i) => {
      S.steer = STEER[i].id;
      if (S.steer === 'tilt') this.enableTilt();
    });
    bind('skins', (i) => { S.skin = i; if (this.state === 'menu') this.startDemo(); });
    $('start').addEventListener('click', () => this.startRace());
    $('resume').addEventListener('click', () => this.togglePause());
    $('restart').addEventListener('click', () => { $('pause').classList.add('hidden'); this.startRace(this.race); });
    $('quit').addEventListener('click', () => this.toMenu());
    $('again').addEventListener('click', () => this.startRace(this.race));
    $('nextRace').addEventListener('click', () => (this.race?.season ? this.startF1Race() : this.startCupRace()));
    $('celebs').addEventListener('click', (e) => { const b = e.target.closest('.celeb'); if (b) this.celebrate(b.dataset.id); });
    $('celebSkip').addEventListener('click', () => this.celebrate(null));
    $('cambtn').addEventListener('click', () => this.cycleCamera());
    $('pausebtn').addEventListener('click', () => { if (['race', 'countdown', 'paused'].includes(this.state)) this.togglePause(); });
    $('resetcar').addEventListener('click', () => {
      this.togglePause();
      if (this.state === 'race' && this.player && !this.player.finished) this.resetPlayer();
    });
    $('resBoard').addEventListener('click', () => this.showBoard('drivers'));

    // Driver name
    const pname = $('pname');
    pname.value = this.league.name;
    pname.addEventListener('change', () => { this.league.name = pname.value; pname.value = this.league.name; this.startDemo(); });
    pname.addEventListener('keydown', (e) => { if (e.key === 'Enter') pname.blur(); });
    $('pdice').addEventListener('click', () => { pname.value = this.league.randomizeName(); this.audio.play('click'); });

    // Tournament + leaderboard screens
    $('cupbtn').addEventListener('click', () => { this.audio.play('click'); this.showCups(); });
    $('f1btn').addEventListener('click', () => { this.audio.play('click'); this.showF1(); });
    $('f1s').addEventListener('click', (e) => {
      const F = this.settings.f1;
      const pick = (id, fn) => { const o = e.target.closest(`#${id} .opt, #${id} .carcard`); if (o) { fn(+o.dataset.i); this.save(); this.audio.play('click'); this.showF1(); return true; } };
      if (pick('f1Teams', (i) => (F.team = i)) || pick('f1Laps', (i) => (F.laps = [2, 3, 5][i])) || pick('f1Diff', (i) => (F.diff = i)) || pick('f1Len', (i) => (F.rounds = [6, 12, 24][i]))) return;
      if (e.target.closest('#f1Continue')) return this.startF1Race();
      if (e.target.closest('#f1Abandon')) {
        if (confirm('Abandon this championship? Your season standings will be lost.')) { this.league.f1Abandon(); this.showF1(); }
        return;
      }
      if (e.target.closest('#f1Season')) {
        if (this.league.f1 && !confirm('Start a new championship? The one in progress will be lost.')) return;
        this.league.f1Start(F.team, F.rounds, F.laps, F.diff);
        return this.startF1Race();
      }
      const gp = e.target.closest('.gp');
      if (gp) return this.startF1GP(gp.dataset.id);
      if (e.target.closest('#f1Back')) this.toMenu();
    });
    $('boardbtn').addEventListener('click', () => { this.audio.play('click'); this.showBoard(); });
    $('cups').addEventListener('click', (e) => {
      if (e.target.closest('#cupContinue')) return this.startCupRace();
      if (e.target.closest('#cupAbandon')) {
        if (confirm('Abandon this tournament? Points from races already run stay on the leaderboard.')) { this.league.abandonCup(); this.showCups(); }
        return;
      }
      const c = e.target.closest('.cupcard');
      if (!c || this.league.cup) return;
      this.audio.play('click');
      this.league.startCup(c.dataset.id, this.settings.skin, this.settings.mode);
      this.startCupRace();
    });
    $('cupsBack').addEventListener('click', () => this.toMenu());
    $('board').addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (t) this.showBoard(t.dataset.tab);
    });
    $('boardBack').addEventListener('click', () => this.toMenu());
    $('newBank').addEventListener('click', () => {
      if (!confirm('Generate a new bank of rival drivers? This resets the leaderboard, track records and any tournament in progress.')) return;
      this.league.newBank();
      this.showBoard();
      this.startDemo();
    });
    $('back').addEventListener('click', () => this.toMenu());
    refresh();
  }

  // Tilt needs a sensor, a secure page (https or localhost) and, on iOS, permission granted from a tap
  async enableTilt() {
    const ok = await this.input.enableTilt();
    $('steerNote').textContent = ok ? 'Hold the device comfortably when the countdown starts; that becomes center.'
      : 'Tilt is unavailable here (needs a motion sensor, https and permission). Using swipe instead.';
    if (!ok && this.settings.steer === 'tilt') {
      this.settings.steer = 'swipe';
      $('steer').querySelectorAll('.opt').forEach((e) => e.classList.toggle('sel', STEER[e.dataset.i].id === 'swipe'));
      this.applySteer();
      this.save();
    }
    return ok;
  }

  applySteer() {
    const m = IS_TOUCH ? this.settings.steer : 'buttons';
    this.input.steerMode = m;
    document.body.classList.toggle('steer-tilt', m === 'tilt');
    document.body.classList.toggle('steer-swipe', m === 'swipe');
  }

  toMenu() {
    ['pause', 'result', 'cups', 'board', 'f1s', 'celebrate'].forEach((i) => $(i).classList.add('hidden'));
    this.celeb = null;
    clearTimeout(this.celebT);
    this.sim = null;
    document.body.classList.remove('sim');
    this.hud.setSim(false);
    $('menu').classList.remove('hidden');
    $('touch').classList.add('hidden');
    this.hud.show(false);
    this.hud.countdown('');
    // a tournament may have left us on a different track than the one picked in the lobby
    if (this.map && this.map.id !== this.settings.map && !this.loading) this.loadMap(this.settings.map).then(() => this.startDemo());
    else this.startDemo();
  }

  onKey(code) {
    if (code === 'Escape' || code === 'KeyP') {
      if (this.state === 'race' || this.state === 'countdown' || this.state === 'paused') this.togglePause();
    } else if (code === 'KeyC') this.cycleCamera();
    else if (this.celeb?.phase === 'ask' && /^Digit[1-4]$/.test(code)) this.celebrate(this.celebOptions()[+code.slice(5) - 1]?.id);
    else if (this.celeb?.phase === 'ask' && code === 'Escape') this.celebrate(null);
    else if (code === 'KeyH') this.hud.toggleKeys();
    else if (code === 'KeyM') this.hud.song(this.audio.toggleMusic() ? 'Music: On' : 'Music: Off');
    else if (code === 'PageUp' || code === 'PageDown') {
      this.settings.song = (this.settings.song ?? 0) + (code === 'PageUp' ? -1 : 1);
      this.hud.song(this.audio.setSong(this.settings.song));
    } else if (code === 'Enter' && this.state === 'menu' && !$('menu').classList.contains('hidden') && document.activeElement?.tagName !== 'INPUT') this.startRace();
  }

  togglePause() {
    if (this.state === 'paused') {
      this.state = this.pausedFrom;
      $('pause').classList.add('hidden');
      this.last = performance.now();
    } else {
      this.pausedFrom = this.state;
      this.state = 'paused';
      $('pause').classList.remove('hidden');
      this.audio.silence();
    }
  }

  // ---------- Level ----------
  async loadMap(id) {
    this.loading = true;
    $('loading').classList.remove('hidden');
    $('loadtxt').textContent = `Generating track: ${mapById(id).name}…`;
    await new Promise((r) => setTimeout(r, 30));
    if (this.level) this.disposeLevel();
    const map = mapById(id);
    this.map = map;
    const root = new THREE.Group();
    const rnd = mulberry32(id.length * 997 + 13);
    const track = new Track(map.layoutData || LAYOUTS[map.layout], { isBridge: map.isBridge });
    const noise = makeNoise(id.charCodeAt(0) * 31 + 7);
    let oases = [];
    if (id === 'egypt') oases = [[-110, -60, 22], [200, -330, 24], [-120, 320, 20], [140, 200, 18], [-300, 60, 24]].filter(([x, z, r]) => isFree(track, x, z, r + 14));
    const flatR = track.halfW + (map.track.shoulder ? map.track.shoulder.width + 2.5 : 3.5);
    // a lake needs open infield: look for the biggest free circle near the middle
    let lake = null;
    if (map.f1?.lake) for (const r of [110, 90, 70]) {
      for (let k = 0; k < 80 && !lake; k++) {
        const x = track.bounds.cx + (rnd() - 0.5) * 500, z = track.bounds.cz + (rnd() - 0.5) * 500;
        if (isFree(track, x, z, r + 20)) lake = [x, z, r];
      }
      if (lake) break;
    }
    const base = map.f1 ? f1Base(map, noise, track, lake) : baseFor(id, noise, track, oases);
    const ground = buildGround(track, { base, flatR, texture: map.ground, colorAt: map.f1 ? f1Tint(map, noise) : tintFor(id, noise), repeat: id === 'snow' ? 30 : 22 });
    root.add(ground.mesh);
    // Grands Prix get a pit lane beside the start straight, with an opening in the wall on that side
    const pit = map.f1 ? pitLayout(track) : null;
    root.add(track.build(pit ? { ...map.track, wallGap: pit.wallGap } : map.track, ground.heightAt));

    // Sky, fog, lights
    const { sky, sunDir } = buildSky(map.sky);
    this.skyMesh = sky;
    root.add(sky);
    root.add(buildClouds(rnd, { x: track.bounds.cx, z: track.bounds.cz }, 30));
    this.scene.fog = new THREE.Fog(map.fog[0], map.fog[1], map.fog[2]);
    this.scene.background = new THREE.Color(map.sky.horizon);
    const hemi = new THREE.HemisphereLight(map.hemi[0], map.hemi[1], map.hemi[2] * 0.62);
    root.add(hemi);
    const sun = new THREE.DirectionalLight(map.sky.sunColor, map.sky.sunI * 0.82);
    sun.castShadow = this.settings.quality !== 'low';
    const ms = this.settings.quality === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(ms, ms);
    const sc = sun.shadow.camera;
    sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.near = 1; sc.far = 500;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    root.add(sun, sun.target);
    this.sun = sun;
    this.sunDir = sunDir;
    if (map.water) {
      const water = buildWater(map.water, sunDir, map.sky.horizon, { x: track.bounds.cx, z: track.bounds.cz }, map.water.local ? 60 : 7000);
      if (map.water.local) {
        this.waters = oases.map(([x, z, r]) => {
          const w = water.clone();
          w.material = water.material;
          w.scale.setScalar((r + 12) / 30);
          w.position.set(x, map.water.y, z);
          root.add(w);
          return w;
        });
      } else {
        root.add(water);
        this.waters = [water];
      }
    } else this.waters = [];
    root.add(buildMountains(rnd, { x: track.bounds.cx, z: track.bounds.cz }, map.mountains || MOUNTAINS[id]));

    const ctx = { track, batch: new Batch(), rnd, groundAt: ground.heightAt, parent: root, updaters: [], quality: this.settings.quality, oases, map, pit };
    this.gate = buildProps(id, ctx);
    this.pit = pit;
    this.pitCrew = pit ? buildPitLane(ctx, pit, TEAMS) : null;
    this.crowd = ctx.crowd;
    this.crowdSpots = ctx.crowdSpots || [];
    ctx.batch.build(root);
    this.updaters = ctx.updaters;
    this.scene.add(root);
    this.level = root;
    this.track = track;
    this.groundAt = ground.heightAt;
    this.hud.setupMinimap(track, pit);
    this.fx.skids.clear();
    this.audio.setSong(map.bgm);
    this.settings.song = map.bgm;
    try { this.renderer.compile(this.scene, this.camera); } catch { /* ignore */ }
    $('loading').classList.add('hidden');
    this.loading = false;
  }

  disposeLevel() {
    this.clearRacers();
    if (this.items) { this.items.dispose(); this.items = null; }
    this.level.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.scene.remove(this.level);
    this.level = null;
  }

  clearRacers() {
    for (const r of this.racers) {
      this.scene.remove(r.model);
      // three re-uploads a disposed geometry if it is used again, so shared (cached) geometry is safe to release here
      r.model.traverse((o) => {
        if (o.material && !o.isSprite) o.material.dispose();
        if (o.geometry) o.geometry.dispose();
      });
    }
    this.racers = [];
    this.player = null;
    this.ejects = [];
  }

  makeRacers(withPlayer) {
    this.clearRacers();
    const S = this.settings;
    const rnd = mulberry32((Date.now() & 0xffff) + 7);
    // the menu demo borrows random drivers from the bank; races use the rivals in this.race
    const race = withPlayer ? this.race : { skin: S.skin, diff: S.diff, rivals: this.league.pickRivals(6).map((r, i) => ({ ...r, car: (i + S.skin) % CARS.length })) };
    const diff = DIFFS[race.diff];
    const total = withPlayer ? race.rivals.length + 1 : 6;
    const playerSlot = withPlayer ? (race.f1 ? Math.floor(total / 2) : 3) : -1;
    let ai = 0;
    for (let k = 0; k < total; k++) {
      const d = -14 - Math.floor(k / 2) * 11;
      const lat = (k % 2 ? 1 : -1) * 5.5;
      let r;
      if (k === playerSlot) {
        const model = race.f1 ? buildF1Car(TEAMS[race.team], { isPlayer: true }) : buildCar(CARS[race.skin], { isPlayer: true });
        r = new PlayerCar(this.track, model, this.league.name, race.f1 ? teamTune(TEAMS[race.team]) : CARS[race.skin].tune);
        if (race.f1) r.cruise = 0.58; // cruises at ~58% of top speed without throttle
        r.id = 'me';
        r.team = race.team;
        r.reset(d, lat);
      } else {
        const rival = race.rivals[ai % race.rivals.length];
        const car = race.f1 ? TEAMS[rival.team] : CARS[rival.car];
        const model = race.f1 ? buildF1Car(car, { name: rival.name }) : buildCar(car, { name: rival.name });
        // talent decides where in the difficulty's skill range a rival sits, with a little race-day luck
        const skill = lerp(diff.skill[0], diff.skill[1], withPlayer ? clamp(rival.talent * 0.75 + rnd() * 0.25, 0, 1) : 0.8 + rnd() * 0.2);
        r = new AICar(this.track, model, rival.name, skill, rnd, race.f1 ? teamTune(car) : car.tune);
        r.id = rival.id;
        r.team = rival.team;
        r.reset(d, lat);
        ai++;
      }
      r.slot = k;
      r.lapTimes = [];
      r.items = [];
      r.itemTimer = 2 + rnd() * 2;
      r.finished = false;
      r.finishTime = 0;
      r.stats = { drift: 0, small: 0, perfect: 0, double: 0, nitro: 0, crash: 0, top: 0, land: 0, takedown: 0 };
      r.wreck = 0;
      r.ghost = 0;
      r.retired = false;
      if (r.isPlayer) {
        r.lapsDone = -1;
        r.owed = true;
        r.half = false;
        r.lastD = r.d;
        this.player = r;
      }
      this.scene.add(r.model);
      this.racers.push(r);
    }
    for (const r of this.racers) this.updateProgress(r, true);
    this.standings = [...this.racers];
  }

  startDemo() {
    if (!this.track) return;
    this.state = 'menu';
    this.makeRacers(false);
    this.raceTime = 0;
    this.demoTarget = 0;
    this.demoT = 0;
    if (this.items) { this.items.dispose(); this.items = null; }
  }

  quickRace() {
    const S = this.settings;
    const others = CARS.map((_, k) => k).filter((k) => k !== S.skin).sort(() => Math.random() - 0.5);
    return { laps: S.laps, mode: S.mode, skin: S.skin, diff: S.diff, cup: false, rivals: this.league.pickRivals(5).map((r, i) => ({ ...r, car: others[i % others.length] })) };
  }

  startRace(race = this.quickRace()) {
    if (this.loading) return;
    this.race = race;
    this.audio.init();
    ['menu', 'pause', 'result', 'cups', 'board', 'f1s'].forEach((i) => $(i).classList.add('hidden'));
    this.itemMode = race.mode === 'item';
    this.makeRacers(true);
    this.sim = race.f1 && this.pit ? new RaceSim(this, this.pit, this.pitCrew) : null;
    this.sim?.setup(this.racers);
    this.pitCrew?.crews.forEach((c) => { c.working = false; });
    document.body.classList.toggle('sim', !!this.sim);
    document.body.classList.toggle('f1', !!race.f1);
    this.thr = 0;
    this.hud.setSim(!!this.sim);
    this.crowdBoost = 0;
    this.lastRank = 99;
    this.ejects = [];
    this.fireworks = [];
    this.celeb = null;
    clearTimeout(this.celebT);
    $('celebrate').classList.add('hidden');
    if (this.camMode === 3 && !race.f1) this.camMode = 0;
    if (this.items) this.items.dispose();
    this.items = this.itemMode ? new ItemSystem(this.scene, this.track, this, mulberry32(Date.now() & 0xffff)) : null;
    this.hud.setItemMode(this.itemMode);
    this.hud.show(true);
    $('touch').classList.toggle('hidden', !IS_TOUCH);
    this.fx.skids.clear();
    this.state = 'countdown';
    document.body.classList.toggle('items', this.itemMode);
    this.applySteer();
    clearTimeout(this.centerT);
    if (IS_TOUCH && this.settings.steer === 'tilt') {
      this.input.enableTilt();
      // whatever angle the device is held at during the countdown becomes straight ahead;
      // no readings by then means no usable sensor, so swipe steering takes over for this race
      this.centerT = setTimeout(() => {
        if (this.input.tiltRaw != null) return this.input.centerTilt();
        this.input.steerMode = 'swipe';
        document.body.classList.remove('steer-tilt');
        document.body.classList.add('steer-swipe');
        this.hud.message('No tilt sensor: drag to steer', '#ffd23a', true);
      }, 1500);
    }
    this.cdT = 0;
    this.cdShown = -1;
    this.raceTime = 0;
    this.firstFinish = -1;
    this.startBoostReady = false;
    this.startTried = false;
    this.resultShown = false;
    this.camYaw = this.player.h;
    this.snapCamera();
    this.audio.setSong(this.settings.song ?? this.map.bgm);
    this.audio.startMusic();
    this.gate?.set(0);
    this.last = performance.now();
    $('keys').classList.remove('hidden');
    clearTimeout(this.keysT);
    this.keysT = setTimeout(() => $('keys').classList.add('hidden'), 18000);
  }

  // ---------- Main loop ----------
  loop() {
    requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    const inp = this.input.frame();
    if (this.state !== 'paused') this.step(dt, inp);
    this.render(dt);
  }

  step(dt, inp) {
    const st = this.state;
    const racing = st === 'race';
    if (st === 'countdown') {
      this.cdT += dt;
      const n = Math.floor(this.cdT);
      if (n !== this.cdShown && n <= 3) {
        this.cdShown = n;
        this.hud.countdown(n < 3 ? String(3 - n) : 'GO!');
        this.gate?.set(n < 3 ? n + 1 : 4);
        this.audio.play(n < 3 ? 'count' : 'go');
        if (n === 3) this.excite(0.9, this.race?.f1);
      }
      if (inp.upPressed && !this.startTried) {
        this.startTried = true;
        if (this.cdT > 2.72) this.startBoostReady = true;
      }
      if (this.cdT >= 3) {
        this.state = 'race';
        this.raceTime = 0;
        for (const r of this.racers) if (r.isPlayer) r.lapStart = 0; else r.lapStart = 0;
        if (this.startBoostReady) this.applyStartBoost();
        setTimeout(() => this.hud.countdown(''), 700);
      }
    }
    if (st === 'finish') this.raceTime += dt;
    if (st === 'race') {
      this.raceTime += dt;
      if (inp.upPressed && !this.startTried && this.raceTime < 0.28) { this.startTried = true; this.applyStartBoost(); }
      if (inp.upPressed) this.startTried = true;
    }
    if (st === 'menu') this.raceTime += dt;

    const P = this.player;
    // Player input: autopilot after finishing
    let pin = inp;
    if (P) {
      if (P.finished || this.resultShown) pin = this.autopilot(P);
      // touch auto-throttle, except in F1 where the car cruises and the GAS button adds speed
      else if (IS_TOUCH && racing && !this.race?.f1) { this.input.touch.up = true; }
      if (IS_TOUCH && !racing) this.input.touch.up = false;
      if (inp.resetPressed && racing && !P.finished) this.resetPlayer();
      if (this.itemMode && racing && !P.finished) {
        if (inp.nitroPressed) this.items.use(P);
        if (inp.swapPressed) this.items.swap(P);
      }
    }
    const active = st === 'race' || st === 'finish';
    const aiActive = st === 'race' || st === 'menu' || st === 'finish';
    // Fixed timestep
    this.acc += dt;
    let first = true;
    // F1 throttle: holding the pedal builds it up (about a second to flat out); letting go eases it off
    if (P && this.race?.f1) {
      this.thr = inp.up ? Math.min(1, (this.thr || 0) + dt * 0.9) : Math.max(0, (this.thr || 0) - dt * 1.6);
      if (!P.finished && !this.resultShown) pin = { ...pin, throttle: this.thr };
    }
    if (this.sim) {
      this.sim.pre();
      // damaged suspension pulls the car to one side
      if (P && P.steerPull && !P.finished) pin = { ...pin, steer: (pin.steer ?? (pin.left ? 1 : 0) - (pin.right ? 1 : 0)) + P.steerPull };
      if (inp.boxPressed && racing && P && !P.finished) this.sim.toggleBox(P);
    }
    const noEdge = { ...pin, upPressed: false, wPressed: false, nitroPressed: false };
    while (this.acc >= DT) {
      this.acc -= DT;
      if (P && !P.pit && !(this.celeb && this.celeb.phase !== 'ask')) P.update(DT, first ? pin : noEdge, active && !P.retired, this.itemMode);
      first = false;
      for (const r of this.racers) {
        if (r.isPlayer || r.pit) continue;
        r.update(DT, aiActive && !r.retired, this.raceTime, this.rubber(r));
        if (r.retired) r.lat = damp(r.lat, Math.sign(r.lat || 1) * (this.track.halfW - 2.5), 1.5, DT);
      }
      this.collide();
    }
    this.sim?.post(dt);
    this.updateWrecks(dt);
    this.updateEjects(dt);
    if (this.celeb && this.celeb.phase !== 'ask') this.updateCelebration(dt);
    this.updateFireworks(dt);
    this.updateCrowd(dt);
    // name tags: fade out next to the camera (where they would fill the screen) and past readable range
    const cam = this.camera.position;
    for (const r of this.racers) {
      const tag = r.model.userData.tag;
      if (!tag) continue;
      const d = Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z);
      tag.visible = d > 10 && d < 240;
      tag.material.opacity = clamp((d - 10) / 12, 0, 1);
    }
    for (const r of this.racers) {
      r.syncModel(dt);
      this.updateProgress(r);
    }
    this.standings = [...this.racers].sort((a, b) => {
      if (!!a.retired !== !!b.retired) return a.retired ? 1 : -1;
      if (a.retired && b.retired) return b.retiredAt - a.retiredAt;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    if (this.items && (racing || st === 'finish')) {
      this.items.update(dt, this.racers, this.standings);
      for (const r of this.racers) if (!r.isPlayer && !r.finished) this.items.aiThink(r, dt, this.standings);
    }
    if (P) this.handleEvents(P);
    this.emitEffects(dt);
    this.fx.smoke.update(dt);
    this.fx.glow.update(dt);
    this.fx.skids.update();
    for (const u of this.updaters) u(dt, this.time, this.camera.position);
    for (const w of this.waters) w.material.uniforms.uTime.value = this.time;
    if (this.track.boostPads) for (const bp of this.track.boostPads) bp.mat.map.offset.y = -this.time * 1.2;

    if (P && (racing || st === 'finish' || st === 'countdown')) this.updateRaceHUD(dt);
    if (st === 'race' || st === 'finish') this.checkRaceEnd(dt);

    // Sound
    if (P && this.celeb && (this.celeb.kind === 'burnout' || this.celeb.kind === 'donuts') && this.celeb.phase === 'go') {
      this.audio.setEngine(0.95, 1, false, true, true);
    } else if (P && st !== 'menu') {
      this.audio.setEngine(Math.min(1.2, Math.abs(P.s) / P.T.vmaxNitro), st === 'countdown' ? (this.input.has('ArrowUp') ? 1 : 0) : P.throttle, P.boosting, P.drifting && !P.airborne, true);
    } else this.audio.silence();
  }

  rubber(r) {
    if (!this.player || this.state === 'menu') return 1;
    const diff = DIFFS[this.race.diff];
    const gap = r.progress - this.player.progress;
    if (gap > 0) return Math.max(diff.rubber[0], 1 - gap * 0.00045);
    return Math.min(diff.rubber[1], 1 - gap * 0.0004);
  }

  applyStartBoost() {
    const P = this.player;
    P.startBoost = 1.4;
    P.s = Math.max(P.s, 16);
    this.hud.message('Rocket Start!', '#ffd23a');
    this.audio.play('small');
  }

  resetPlayer(quiet = false) {
    const P = this.player;
    const s = this.track.sample(P.d, {});
    const keepLap = { lapsDone: P.lapsDone, owed: P.owed, half: P.half, lastD: P.d, gauge: P.gauge, nitroCount: P.nitroCount };
    P.reset(P.d, clamp(P.lat, -4, 4));
    Object.assign(P, keepLap);
    P.h = P.m = s.hd;
    P.s = 12;
    if (!quiet) this.hud.message('Reset', '#ffffff', true);
  }

  autopilot(r) {
    const s = this.track.sample(r.d + 18, {});
    const want = Math.atan2(s.x - r.x, s.z - r.z);
    const e = wrapAngle(want - r.h);
    return { ...NO_INPUT, up: Math.abs(r.s) < 38, left: e > 0.04, right: e < -0.04 };
  }

  // ---------- Progress / laps ----------
  updateProgress(r, init = false) {
    const L = this.track.length;
    if (r.isPlayer) {
      const d = r.d;
      if (!init) {
        if (r.lastD > 0.75 * L && d < 0.25 * L) {
          if (r.owed) { r.lapsDone++; r.owed = false; }
          else if (r.half) { r.lapsDone++; r.half = false; this.onLap(r); }
        } else if (r.lastD < 0.25 * L && d > 0.75 * L) {
          r.lapsDone--;
          r.owed = true;
        }
        if (d > 0.4 * L && d < 0.6 * L) r.half = true;
      }
      r.lastD = d;
      r.progress = r.lapsDone * L + d;
    } else {
      const laps = Math.floor(r.dist / L);
      if (!init && r.lapsDone !== undefined && laps > r.lapsDone && laps >= 1) { r.lapsDone = laps; this.onLap(r); }
      r.lapsDone = laps;
      r.progress = r.dist;
    }
  }

  onLap(r) {
    if (this.state !== 'race' && this.state !== 'finish') return;
    const t = this.raceTime - (r.lapStart || 0);
    r.lapStart = this.raceTime;
    r.lapTimes.push(t);
    const laps = this.race.laps;
    if (r.lapsDone >= laps && !r.finished) {
      r.finished = true;
      r.finishTime = this.raceTime;
      if (this.firstFinish < 0) this.firstFinish = this.raceTime;
      if (r.isPlayer) {
        const place = this.racers.filter((x) => x.finished).length;
        if (place === 1) this.confetti.celebrate('win', this.teamColors());
        else if (place <= 3) this.confetti.celebrate('podium', this.teamColors());
        this.excite(place === 1 ? 1.3 : place <= 3 ? 0.9 : 0.5, true);
        if (place === 1 && this.race.f1) this.audio.airHorn();
        if (place === 1) setTimeout(() => this.askCelebration(), 1200);
        this.hud.message('Finished!', '#ffd23a');
        this.audio.play('finish');
        this.state = 'finish';
        this.finishT = 0;
      }
      return;
    }
    if (r.isPlayer) {
      const best = Math.min(...r.lapTimes);
      this.audio.play('lap');
      this.hud.message(`Lap ${r.lapsDone} ${formatTime(t)}${t <= best && r.lapTimes.length > 1 ? ' Best!' : ''}`, '#6dff9e', true);
      if (r.lapsDone === laps - 1) setTimeout(() => this.hud.message('Final Lap!', '#ff5fa8'), 900);
    }
  }

  checkRaceEnd(dt) {
    const P = this.player;
    if (this.resultShown || this.celeb) return;
    if (P.retired) {
      if (this.raceTime - P.retiredAt > 6) this.showResults();
      return;
    }
    if (this.state === 'finish') {
      this.finishT += dt;
      const allDone = this.racers.every((r) => r.finished || r.retired);
      if (this.finishT > 4 && (allDone || this.raceTime - this.firstFinish > 10 || this.finishT > 12)) this.showResults();
      return;
    }
    if (this.firstFinish >= 0 && !P.finished) {
      const left = 10 - (this.raceTime - this.firstFinish);
      this.hud.finalCount(`A racer has finished! ${Math.max(0, Math.ceil(left))}s left`);
      if (left <= 0) this.showResults();
    }
  }

  showResults() {
    this.resultShown = true;
    this.state = 'finish';
    this.hud.finalCount('');
    const L = this.track.length;
    const order = [...this.standings];
    const P = this.player;
    const place = order.indexOf(P) + 1;
    const entries = order.map((r) => ({ id: r.id, name: r.name, car: r.model.userData.skin.id, best: r.lapTimes.length ? Math.min(...r.lapTimes) : 0, finished: r.finished }));
    this.league.recordRace(this.map.id, entries, !this.race.f1);
    const def = this.race.cup && this.league.cupDef();
    const cup = def ? this.league.cupRaceDone(entries.map((e) => e.id)) : null;
    const season = this.race.season && this.league.f1 ? this.league.f1RaceDone(entries.map((e) => e.id)) : null;
    let title = P.retired ? 'Retired' : !P.finished ? 'Did Not Finish' : place === 1 ? 'You Win!' : `${ordinal(place)} Place`;
    let won = P.finished && place === 1;
    if (cup?.done) {
      const overall = cup.standings.findIndex((x) => x.id === 'me') + 1;
      won = overall === 1;
      title = won ? `${def.icon} ${def.name} Champion!` : `${def.name}: ${ordinal(overall)} Overall`;
    }
    if (season?.done) {
      const overall = season.standings.drivers.findIndex((x) => x.id === 'me') + 1;
      won = overall === 1;
      title = won ? '🏆 World Champion!' : `Championship: ${ordinal(overall)}`;
    }
    $('resTitle').textContent = title;
    $('resTitle').classList.toggle('win', won);
    this.renderCupBox(def, cup);
    if (season) this.renderSeasonBox(season);
    const next = cup || season;
    $('again').classList.toggle('hidden', !!next);
    $('nextRace').classList.toggle('hidden', !next || next.done);
    $('nextRace').textContent = season ? 'Next Grand Prix' : 'Next Race';
    const st = P.stats;
    $('resStats').innerHTML = [
      ['Drifts', st.drift], ['Mini Boosts', st.small], ['Perfect Boosts', st.perfect], ['Double Boosts', st.double], ['Nitros', st.nitro], ['Top Speed', Math.round(st.top) + ''], ['Takedowns', st.takedown || 0], ['Crashes', st.crash],
    ].map(([k, v]) => `<div class="stat"><b>${v}</b>${k}</div>`).join('');
    $('resBody').innerHTML = order.map((r, i) => {
      const best = r.lapTimes.length ? Math.min(...r.lapTimes) : 0;
      const total = r.finished ? formatTime(r.finishTime) : r.retired ? 'DNF (retired)' : `DNF (${Math.floor(Math.max(0, Math.min(99, (r.progress / L) * 100 / this.race.laps)))}%)`;
      return `<tr class="${r.isPlayer ? 'me' : ''}"><td class="pos">${i + 1}</td><td>${r.name}</td><td>${total}</td><td>${formatTime(best)}</td><td class="pts">+${(this.race.points || POINTS)[i] || 0}</td></tr>`;
    }).join('');
    setTimeout(() => {
      $('result').classList.remove('hidden');
      $('touch').classList.add('hidden');
      // winning a cup or the championship gets the big gold celebration; a plain race win gets one more burst
      if ((cup?.done || season?.done) && won) this.confetti.celebrate('champion');
      else if (won) this.confetti.celebrate('podium', this.teamColors());
    }, 400);
  }

  renderCupBox(def, cup) {
    const box = $('cupBox');
    if (!cup) { box.innerHTML = ''; return; }
    const n = cup.done ? def.races : this.league.cup.idx;
    const next = cup.done ? '' : ` · Next: ${mapById(this.league.cup.tracks[this.league.cup.idx]).name}`;
    box.innerHTML = `<h3>${def.icon} ${def.name} · ${cup.done ? 'Final Standings' : `After Race ${n} of ${def.races}`}${next}</h3>
      <table class="res"><thead><tr><th></th><th>Driver</th><th>Wins</th><th>Points</th></tr></thead><tbody>${cup.standings.map((x, i) =>
        `<tr class="${x.id === 'me' ? 'me' : ''}"><td class="pos">${i + 1}</td><td>${x.name}</td><td>${x.wins}</td><td><b>${x.pts}</b> <span class="gain">+${cup.gained[x.id] || 0}</span></td></tr>`).join('')}</tbody></table>`;
  }

  // F1 wins throw confetti in the team's livery
  teamColors() {
    if (!this.race?.f1) return undefined;
    const t = TEAMS[this.race.team];
    const hex = (c) => '#' + c.toString(16).padStart(6, '0');
    return [hex(t.body), hex(t.accent), hex(t.trim), '#ffd23a', '#ffffff'];
  }

  renderSeasonBox(r) {
    const hex = (c) => '#' + c.toString(16).padStart(6, '0');
    const meAt = r.standings.drivers.findIndex((x) => x.id === 'me');
    const rows = r.standings.drivers.filter((x, i) => i < 10 || i === meAt);
    const nextGp = r.done ? null : GPS.find((g) => g.id === r.next);
    $('cupBox').innerHTML = `<h3>🏁 ${r.done ? 'Final Championship Standings' : `After Round ${r.round} of ${r.rounds}`}${nextGp ? ` · Next: ${nextGp.flag} ${nextGp.name}` : ''}</h3>
      <div class="season"><table class="res"><thead><tr><th></th><th>Driver</th><th>Team</th><th>Pts</th></tr></thead><tbody>${rows.map((x) =>
        `<tr class="${x.id === 'me' ? 'me' : ''}"><td class="pos">${r.standings.drivers.indexOf(x) + 1}</td><td>${x.name}</td><td><i class="tdot" style="background:${hex(x.team.dot ?? x.team.body)}"></i>${x.team.name}</td><td><b>${x.pts}</b> <span class="gain">+${r.gained[x.id] || 0}</span></td></tr>`).join('')}</tbody></table>
      <table class="res"><thead><tr><th></th><th>Constructor</th><th>Pts</th></tr></thead><tbody>${r.standings.teams.map((t, i) =>
        `<tr><td class="pos">${i + 1}</td><td><i class="tdot" style="background:${hex(t.color)}"></i>${t.name}</td><td><b>${t.pts}</b></td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------- Formula 1 ----------
  showF1() {
    const S = this.settings;
    const F = (S.f1 ||= { team: 0, laps: 3, diff: 1, rounds: 6 });
    if (!this.teamThumbs) { try { this.teamThumbs = renderTeamThumbs(TEAMS); } catch { this.teamThumbs = []; } }
    const hex = (c) => '#' + c.toString(16).padStart(6, '0');
    $('f1Teams').innerHTML = TEAMS.map((t, i) => `<div class="carcard${i === F.team ? ' sel' : ''}" data-i="${i}">${this.teamThumbs[i] ? `<img src="${this.teamThumbs[i]}" alt="${t.name}">` : `<div class="swatch" style="background:${hex(t.body)}"></div>`}<div class="cn">${t.name}</div></div>`).join('');
    const opts = (el, list, cur, label) => { $(el).innerHTML = list.map((v, i) => `<div class="opt${v === cur ? ' sel' : ''}" data-i="${i}">${label(v)}</div>`).join(''); };
    opts('f1Laps', [2, 3, 5], F.laps, (v) => `${v} laps`);
    opts('f1Diff', [0, 1, 2], F.diff, (v) => DIFFS[v].name);
    opts('f1Len', [6, 12, 24], F.rounds, (v) => (v === 24 ? 'Full season (24)' : `${v} rounds`));
    $('f1Gps').innerHTML = GPS.map((g, i) => `<div class="gp" data-id="${g.id}"><span class="fl">${g.flag}</span><div><div class="gn">${i + 1}. ${g.name}</div><div class="gc">${g.circuit}</div></div></div>`).join('');
    const f = this.league.f1;
    $('f1Resume').innerHTML = f
      ? `<div class="resume"><div><b>Championship in progress</b> · ${TEAMS[f.team].name} · Round ${f.idx + 1} of ${f.calendar.length}: ${GPS.find((g) => g.id === f.calendar[f.idx]).flag} ${GPS.find((g) => g.id === f.calendar[f.idx]).name}</div>
         <div class="btns"><button class="go" id="f1Continue">Continue</button><button class="go sec" id="f1Abandon">Abandon</button></div></div>`
      : '';
    ['menu', 'board', 'result', 'cups'].forEach((i) => $(i).classList.add('hidden'));
    $('f1s').classList.remove('hidden');
  }

  async startF1Race() {
    const f = this.league.f1;
    if (!f || this.loading) return;
    ['menu', 'result', 'f1s', 'pause'].forEach((i) => $(i).classList.add('hidden'));
    const id = 'f1-' + f.calendar[f.idx];
    if (this.map.id !== id) await this.loadMap(id);
    this.startRace(this.league.f1RaceConfig());
  }

  async startF1GP(gpId) {
    if (this.loading) return;
    const F = this.settings.f1;
    ['menu', 'result', 'f1s', 'pause'].forEach((i) => $(i).classList.add('hidden'));
    const id = 'f1-' + gpId;
    if (this.map.id !== id) await this.loadMap(id);
    this.startRace(this.league.f1Single(F.team, F.laps, F.diff));
  }

  async startCupRace() {
    const cup = this.league.cup;
    if (!cup || this.loading) return;
    ['menu', 'result', 'cups', 'pause'].forEach((i) => $(i).classList.add('hidden'));
    const id = cup.tracks[cup.idx];
    if (this.map.id !== id) await this.loadMap(id);
    this.startRace(this.league.raceConfig());
  }

  showCups() {
    const L = this.league;
    const cup = L.cup;
    const def = L.cupDef();
    $('cupResume').innerHTML = cup
      ? `<div class="resume"><div><b>${def.icon} ${def.name}</b> in progress · Race ${cup.idx + 1} of ${def.races} · ${CARS[cup.car].name}</div>
         <div class="btns"><button class="go" id="cupContinue">Continue</button><button class="go sec" id="cupAbandon">Abandon</button></div></div>`
      : '';
    $('cupList').innerHTML = CUPS.map((c) => {
      const w = L.d.cupWins[c.id] || 0;
      return `<div class="cupcard${cup ? ' locked' : ''}" data-id="${c.id}"><div class="ci">${c.icon}</div><div class="cn">${c.name}</div>
        <div class="cd">${c.desc}</div><div class="cm">${c.races} races · ${c.laps} laps · ${DIFFS[c.diff].name} AI</div>
        <div class="cw">${w ? `Won ${w}×` : 'Not won yet'}</div></div>`;
    }).join('');
    $('cupCar').textContent = `You'll drive the ${CARS[this.settings.skin].name} in ${MODES.find((m) => m.id === this.settings.mode).name} mode. Change these in the lobby.`;
    ['menu', 'board', 'result'].forEach((i) => $(i).classList.add('hidden'));
    $('cups').classList.remove('hidden');
  }

  showBoard(tab = this.boardTab || 'drivers') {
    this.boardTab = tab;
    const L = this.league;
    document.querySelectorAll('#board .tab').forEach((t) => t.classList.toggle('sel', t.dataset.tab === tab));
    let html;
    if (tab === 'drivers') {
      const all = L.drivers();
      const me = all.findIndex((d) => d.me);
      html = `<div class="myrank">${L.name}: <b>${ordinal(me + 1)}</b> of ${all.length} drivers · ${all[me].career.pts} pts</div><table class="res board drivers"><thead><tr><th></th><th>Driver</th><th>Points</th><th>Races</th><th>Wins</th><th>Podiums</th><th>Cups</th></tr></thead><tbody>${all.map((d, i) =>
        `<tr class="${d.me ? 'me' : ''}"><td class="pos">${i + 1}</td><td>${d.name}${d.me ? ' <small>(you)</small>' : ''}</td><td><b>${d.career.pts}</b></td><td>${d.career.races}</td><td>${d.career.wins}</td><td>${d.career.podiums}</td><td>${d.career.cups ? '🏆 ' + d.career.cups : '-'}</td></tr>`).join('')}</tbody></table>`;
    } else {
      html = MAPS.map((m) => {
        const recs = L.records(m.id);
        return `<h3>${m.name}</h3>` + (recs.length
          ? `<table class="res board"><tbody>${recs.map((x, i) => `<tr class="${x.id === 'me' ? 'me' : ''}"><td class="pos">${i + 1}</td><td>${x.name}</td><td>${CARS.find((c) => c.id === x.car)?.name || ''}</td><td><b>${formatTime(x.time)}</b></td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">No laps recorded yet. Race here to set the first record.</div>');
      }).join('') + F1_MAPS.filter((m) => L.records(m.id).length).map((m) => `<h3>${m.f1.flag} ${m.name}</h3><table class="res board"><tbody>${L.records(m.id).map((x, i) =>
        `<tr class="${x.id === 'me' ? 'me' : ''}"><td class="pos">${i + 1}</td><td>${x.name}</td><td>${TEAMS.find((t) => t.id === x.car)?.name || ''}</td><td><b>${formatTime(x.time)}</b></td></tr>`).join('')}</tbody></table>`).join('');
    }
    const body = $('boardBody');
    body.innerHTML = html;
    const row = body.querySelector('tr.me');
    body.scrollTop = tab === 'drivers' && row ? row.offsetTop - body.clientHeight / 2 : 0;
    ['menu', 'result', 'cups', 'f1s'].forEach((i) => $(i).classList.add('hidden'));
    $('board').classList.remove('hidden');
  }

  racerAhead(r) {
    const i = this.standings.indexOf(r);
    return i > 0 ? this.standings[i - 1] : null;
  }

  // ---------- Collisions ----------
  collide() {
    const rs = this.racers;
    const R = 3.1;
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        if (a.ghost > 0 || b.ghost > 0 || a.pit || b.pit) continue; // wrecked, just respawned or in the pit lane: no contact
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R || Math.abs(a.y - b.y) > 2.5) continue;
        const d = Math.sqrt(d2) || 0.01;
        const nx = dx / d, nz = dz / d;
        const over = R - d;
        this.pushRacer(a, -nx * over * 0.5, -nz * over * 0.5);
        this.pushRacer(b, nx * over * 0.5, nz * over * 0.5);
        // Velocity exchange (simplified)
        const va = this.vel(a), vb = this.vel(b);
        const rel = (vb[0] - va[0]) * nx + (vb[1] - va[1]) * nz;
        if (rel < 0) {
          // a hard enough hit wrecks the car on the receiving end; rivals need a bigger hit to take out the player
          const pa = va[0] * nx + va[1] * nz, pb = -(vb[0] * nx + vb[1] * nz);
          const [att, vic] = pa >= pb ? [a, b] : [b, a];
          // no takedowns in the scramble off the grid
          if (this.state === 'race' && this.raceTime > 4 && -rel > (vic.isPlayer ? TAKEDOWN_SPEED * 1.4 : TAKEDOWN_SPEED)) { this.takedown(att, vic, -rel); continue; }
          const imp = -rel * 0.5;
          if (this.sim && imp > 1.5) { this.sim.damage(att, imp * 0.02, 'wing'); this.sim.damage(vic, imp * 0.012, 'susp'); }
          this.kick(a, -nx * imp, -nz * imp);
          this.kick(b, nx * imp, nz * imp);
          if ((a.isPlayer || b.isPlayer) && imp > 3) {
            this.audio.play('crash', imp);
            this.shake = Math.max(this.shake, 0.3);
            this.fx.sparks((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.6, (a.z + b.z) / 2, 10);
          }
        }
      }
  }

  takedown(att, vic, closing = 0) {
    if (vic.shield > 0) {
      vic.shield = 0;
      this.sfx('shield', vic);
      if (vic.isPlayer) this.hud.message('Angel Shield!', '#ffe28a', true);
      return;
    }
    // in a Grand Prix a big enough hit ends the victim's race
    if (this.sim && closing > (vic.isPlayer ? FATAL_SPEED * 1.4 : FATAL_SPEED)) {
      if (att.isPlayer) { att.stats.takedown = (att.stats.takedown || 0) + 1; this.hud.message('TAKEDOWN!', '#ff4b4b'); this.excite(0.8, true); }
      this.sim.damage(att, 0.2, 'wing');
      return this.retire(vic);
    }
    vic.wreck = 2.2;
    vic.ghost = 3.6;
    if (this.sim) {
      this.sim.damage(vic, 0.35, 'wing'); this.sim.damage(vic, 0.3, 'susp'); this.sim.damage(vic, 0.12, 'engine');
      this.sim.damage(att, 0.14, 'wing');
    }
    att.ghost = 0.5;
    vic.spin = 2.2;
    vic.s *= 0.15;
    vic.airborne = true;
    vic.vy = 9;
    if (vic.isPlayer) vic.endDrift(false);
    this.fx.explode(vic.x, vic.y + 0.8, vic.z);
    this.fx.sparks(vic.x, vic.y + 0.6, vic.z, 24);
    this.sfx('boom', vic);
    if (att.isPlayer) {
      this.excite(0.8, true);
      att.stats.takedown = (att.stats.takedown || 0) + 1;
      this.hud.message('TAKEDOWN!', '#ff4b4b');
      this.shake = Math.max(this.shake, 0.5);
    }
    if (vic.isPlayer) {
      this.hud.message('Taken Out!', '#ff4b4b');
      this.hud.flash();
      this.shake = 1;
    }
  }

  // ---------- Retirements ----------
  // the car is out: it coasts to a stop and burns, and the driver climbs out and gets clear
  retire(r) {
    if (r.retired || !this.sim) return;
    r.retired = true;
    r.retiredAt = this.raceTime;
    r.ghost = 1e9;
    r.spin = 1.4;
    r.s *= 0.45;
    r.box = false;
    r.nitroTime = 0;
    if (r.isPlayer) r.endDrift(false);
    this.fx.explode(r.x, r.y + 0.8, r.z);
    this.sfx('boom', r);
    this.excite(0.7);
    if (r.model.userData.driver) this.ejects.push({ r, t: -1.4, kind: 'crash', side: (r.lat || 0) > 0 ? -1 : 1 });
    if (r.isPlayer) {
      this.hud.message('RETIRED', '#ff4b4b');
      setTimeout(() => this.hud.message('Driver is out and safe', '#ffffff', true), 1600);
      this.hud.flash();
      this.shake = 1;
    }
  }

  // driver animations: 'crash' climbs out and jumps clear, 'party' stands on the car and celebrates first
  updateEjects(dt) {
    const ease = (k) => k * k * (3 - 2 * k);
    for (const e of this.ejects) {
      e.t += dt;
      if (e.t < 0) continue;
      const D = e.r.model.userData.driver;
      if (!D) continue;
      if (!e.out) { e.out = true; D.setSeated(false); }
      const d = D.drv;
      const party = e.kind === 'party';
      const tJump = party ? 4.6 : 0.6;
      if (e.t < 0.55) {
        d.position.set(0, lerp(0.32, 1.28, ease(e.t / 0.55)), 0.26);
      } else if (e.t < tJump) {
        // on top of the car: bounce with both arms up
        d.position.set(0, 1.28 + Math.abs(Math.sin(e.t * 7)) * 0.35, 0.26);
        D.freeArms.forEach((a, k) => { a.rotation.z = (k ? 1 : -1) * (2.7 + Math.sin(e.t * 12 + k) * 0.35); });
      } else {
        const k = clamp((e.t - tJump) / 0.6, 0, 1);
        const walk = clamp((e.t - tJump - 0.6) / 2.2, 0, 1);
        const x = e.side * (2.3 * ease(k) + 3.5 * walk);
        const y = k < 1 ? lerp(1.28, 0.745, k) + Math.sin(Math.PI * k) * 0.7 : 0.745 + (walk < 1 ? Math.abs(Math.sin(e.t * 9)) * 0.05 : 0);
        d.position.set(x, y, 0.26);
        d.rotation.set(0, walk > 0 && walk < 1 ? e.side * Math.PI / 2 : 0, 0);
        // wave: to the marshals after a crash, to the crowd after a win
        const wave = walk >= 1 || party;
        D.freeArms[0].rotation.z = wave && party ? -(2.7 + Math.sin(e.t * 10) * 0.4) : 0;
        D.freeArms[1].rotation.z = wave ? 2.6 + Math.sin(e.t * 10) * 0.45 : 0.1;
      }
    }
  }

  // ---------- Victory celebrations ----------
  celebOptions() {
    const o = [
      { id: 'burnout', icon: '🔥', name: 'Burnout' },
      { id: 'donuts', icon: '🌀', name: 'Donuts' },
      { id: 'fireworks', icon: '🎆', name: 'Fireworks' },
    ];
    if (this.player?.model.userData.driver) o.push({ id: 'driver', icon: '🙌', name: 'Climb Out & Cheer' });
    return o;
  }

  askCelebration() {
    if (this.resultShown || !this.player?.finished) return;
    this.celeb = { phase: 'ask' };
    $('celebs').innerHTML = this.celebOptions().map((o, i) => `<button class="celeb" data-id="${o.id}" type="button"><span class="ci">${o.icon}</span>${o.name}<small>${IS_TOUCH ? '' : i + 1}</small></button>`).join('');
    $('celebrate').classList.remove('hidden');
    clearTimeout(this.celebT);
    this.celebT = setTimeout(() => { if (this.celeb?.phase === 'ask') this.celebrate(null); }, 12000);
  }

  celebrate(kind) {
    clearTimeout(this.celebT);
    $('celebrate').classList.add('hidden');
    if (!kind) { this.celeb = null; return; } // skipped: results follow as usual
    const P = this.player;
    P.ghost = 1e9;
    this.celeb = { phase: 'stop', kind, t: 0 };
    this.audio.play('click');
  }

  updateCelebration(dt) {
    const c = this.celeb, P = this.player, fx = this.fx, R = Math.random;
    c.t += dt;
    const place = () => {
      const p = this.track.project(P.x, P.y, P.z, P.hint, P.proj);
      P.hint = p.i;
      P.d = p.d;
      P.y = p.y + p.lat * Math.sin(p.bank);
    };
    if (c.phase === 'stop') {
      P.s = Math.max(0, P.s - 40 * dt);
      P.x += Math.sin(P.h) * P.s * dt;
      P.z += Math.cos(P.h) * P.s * dt;
      place();
      if (P.s > 0.1) return;
      c.phase = 'go';
      c.t = 0;
      this.excite(1.2, true);
      this.confetti.celebrate('podium', this.teamColors());
      if (c.kind === 'donuts') {
        // circle to the car's left, starting in the direction it faces
        c.R = 3.2;
        c.cx = P.x + Math.cos(P.h) * c.R;
        c.cz = P.z - Math.sin(P.h) * c.R;
        c.a = P.h - Math.PI / 2;
      }
      if (c.kind === 'fireworks') c.next = 0;
      if (c.kind === 'driver') this.ejects.push({ r: P, t: 0, kind: 'party', side: 1 });
      c.dur = { burnout: 5, donuts: 6.5, fireworks: 6.5, driver: 7.5 }[c.kind];
      return;
    }
    const u = P.model.userData;
    const rear = u.wheels.filter((w) => !w.front);
    const smokeAtRear = (rate) => {
      const lx = Math.cos(P.h), lz = -Math.sin(P.h), fxv = Math.sin(P.h), fzv = Math.cos(P.h);
      rear.forEach((w, k) => {
        const sx = w.x, wx = P.x + lx * sx - fxv * u.rearZ, wz = P.z + lz * sx - fzv * u.rearZ;
        fx.skids.add('pc-' + k, wx, P.y, wz, lx, lz, 0.25, 1);
        for (let n = 0; n < rate * dt; n++) fx.smoke.emit(wx + (R() - 0.5) * 0.8, P.y + 0.3, wz + (R() - 0.5) * 0.8, (R() - 0.5) * 3 - fxv * 3, 1 + R() * 1.5, (R() - 0.5) * 3 - fzv * 3, 1.4 + R(), 1.6, 7 + R() * 3, 0.96, 0.96, 0.98, 0.5, -0.4, 1);
        w.spin.rotation.x += 70 * dt;
      });
    };
    if (c.kind === 'burnout') {
      smokeAtRear(70);
      u.root.rotation.x = -0.03 + Math.sin(c.t * 40) * 0.006;
      u.root.rotation.z = Math.sin(c.t * 33) * 0.008;
    } else if (c.kind === 'donuts') {
      c.a += 2.3 * dt;
      P.x = c.cx + Math.sin(c.a) * c.R;
      P.z = c.cz + Math.cos(c.a) * c.R;
      P.h = P.m = c.a + Math.PI / 2 + 0.85; // nose tucked into the circle
      place();
      smokeAtRear(55);
      for (const w of u.wheels) if (w.front) w.steer.rotation.y = -0.45;
    } else if (c.kind === 'fireworks') {
      c.next -= dt;
      if (c.next <= 0 && c.t < c.dur - 1.5) {
        c.next = 0.18 + R() * 0.22;
        for (let k = 0; k < 2; k++) {
          const a = R() * Math.PI * 2, r = 20 + R() * 40;
          // over-bright colors so the shells still glow against a daytime sky
          this.fireworks.push({ x: P.x + Math.sin(a) * r, y: P.y, z: P.z + Math.cos(a) * r, vy: 40 + R() * 12, top: P.y + 30 + R() * 24, col: new THREE.Color().setHSL(R(), 1, 0.6).multiplyScalar(2.4) });
        }
        this.audio.tone(900 + R() * 400, 0.5, 'sine', 0.04, 2.2);
      }
    }
    if (c.t >= c.dur) {
      for (let k = 0; k < 2; k++) fx.skids.cut('pc-' + k);
      this.celeb = null;
      this.showResults();
    }
  }

  // rockets climb, then burst into a shell of glowing sparks
  updateFireworks(dt) {
    const fx = this.fx, R = Math.random;
    this.fireworks = this.fireworks.filter((f) => {
      f.y += f.vy * dt;
      fx.glow.emit(f.x, f.y, f.z, (R() - 0.5), -2, (R() - 0.5), 0.4, 0.8, 0.1, 1, 0.8, 0.5, 1);
      if (f.y < f.top) return true;
      for (let i = 0; i < 130; i++) {
        const th = R() * Math.PI * 2, ph = Math.acos(2 * R() - 1), sp = 15 + R() * 6;
        fx.glow.emit(f.x, f.y, f.z, Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp, Math.sin(ph) * Math.sin(th) * sp, 1.4 + R() * 0.7, 2.8, 0.4, f.col.r, f.col.g, f.col.b, 1, 5, 1.4);
      }
      this.audio.play('boom');
      this.audio.clap?.(this.audio.ctx?.currentTime ?? 0, 0.05);
      return false;
    });
  }

  // fans get louder for big moments; the sound only plays if they are close or it's a Grand Prix
  excite(k, loud = false) {
    this.crowdBoost = Math.max(this.crowdBoost || 0, k);
    const near = this.nearestCrowd() < 160;
    if (loud || near || this.race?.f1) this.audio.cheer(Math.min(1.3, k));
  }

  nearestCrowd() {
    const c = this.camera.position;
    let best = 1e9;
    for (const [x, z] of this.crowdSpots || []) best = Math.min(best, Math.hypot(x - c.x, z - c.z));
    return best;
  }

  updateCrowd(dt) {
    this.crowdBoost = Math.max(0, (this.crowdBoost || 0) - dt * 0.35);
    const P = this.player;
    // passing a rival is worth a cheer
    if (P && this.state === 'race') {
      const rank = this.standings.indexOf(P) + 1;
      if (rank < this.lastRank && this.lastRank !== 99 && this.raceTime > 3) this.excite(0.5);
      this.lastRank = rank;
    }
    const f1 = !!this.race?.f1 && this.state !== 'menu';
    if (this.crowd) {
      this.crowd.uTime.value = this.time;
      this.crowd.uExcite.value = (f1 ? 0.22 : 0.12) + this.crowdBoost * 0.8;
      const focus = P && this.state !== 'menu' ? P : this.racers[this.demoTarget];
      if (focus) this.crowd.uCar.value.set(focus.x, focus.y, focus.z);
    }
    const near = 1 - smoothstep(30, 260, this.nearestCrowd());
    const base = this.state === 'menu' ? 0.015 : f1 ? 0.06 : 0.025;
    this.audio.setCrowd(base + near * (f1 ? 0.2 : 0.12) + this.crowdBoost * 0.05);
  }

  // wrecked cars smoke, then respawn on the racing line after a short delay
  updateWrecks(dt) {
    for (const r of this.racers) {
      if (r.ghost > 0) r.ghost -= dt;
      if (!(r.wreck > 0)) continue;
      r.wreck -= dt;
      if (Math.random() < dt * 30) this.fx.smoke.emit(r.x, r.y + 1, r.z, (Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2, 1.2, 1.6, 4, 0.18, 0.18, 0.2, 0.7);
      if (r.wreck > 0) continue;
      if (r.isPlayer) this.resetPlayer(true);
      else { r.spin = 0; r.lat *= 0.3; r.latV = 0; r.s = 10; }
    }
  }

  vel(r) {
    if (r.isPlayer) return [Math.sin(r.m) * r.s, Math.cos(r.m) * r.s];
    const s = this.track.sample(r.dist, {});
    return [s.tx * r.s + s.rx * r.latV, s.tz * r.s + s.rz * r.latV];
  }

  pushRacer(r, px, pz) {
    if (r.isPlayer) { r.x += px; r.z += pz; return; }
    const s = this.track.sample(r.dist, {});
    r.lat += px * s.rx + pz * s.rz;
    r.pushD += px * s.tx + pz * s.tz;
  }

  kick(r, vx, vz) {
    if (r.isPlayer) {
      const cx = Math.sin(r.m) * r.s + vx, cz = Math.cos(r.m) * r.s + vz;
      const ns = Math.hypot(cx, cz);
      if (r.s >= 0 && ns > 0.5) { r.s = ns; r.m = Math.atan2(cx, cz); }
      return;
    }
    const s = this.track.sample(r.dist, {});
    r.s = Math.max(0, r.s + vx * s.tx + vz * s.tz);
    r.latV += vx * s.rx + vz * s.rz;
  }

  hitRacer(r, kind) {
    if (r.shield > 0) {
      r.shield = 0;
      this.sfx('shield', r);
      if (r.isPlayer) this.hud.message('Angel Shield!', '#ffe28a', true);
      return;
    }
    r.spin = kind === 'missile' ? 1.3 : 1.0;
    r.s *= 0.35;
    if (kind === 'missile') { r.airborne = true; r.vy = 8; }
    if (r.isPlayer) {
      r.endDrift(false);
      this.hud.message(kind === 'missile' ? 'Hit by a Missile!' : 'Slipped on a Banana!', '#ff4b4b');
      this.hud.flash();
      this.shake = 0.8;
    }
    this.sfx(kind === 'missile' ? 'boom' : 'banana', r);
  }

  sfx(name, r) {
    const P = this.player;
    if (!P) return;
    const d = Math.hypot(r.x - P.x, r.z - P.z);
    if (d < 120) this.audio.play(name);
  }

  onItemGet(it) {
    this.audio.play('item');
  }

  onMissileLock() {
    this.missileWarn = 1.6;
    this.audio.play('wrong');
  }

  // ---------- Player events → messages / sounds / effects ----------
  handleEvents(P) {
    const st = P.stats;
    st.top = Math.max(st.top, P.speedKmh);
    for (const e of P.events) {
      switch (e.type) {
        case 'driftStart': st.drift++; break;
        case 'smallBoost':
          st.small++;
          if (e.data.perfect) st.perfect++;
          this.hud.message(e.data.perfect ? 'Perfect Boost!' : 'Mini Boost!', '#ff9a1f');
          this.audio.play('small');
          this.fx.boostBurst(P, 0xffa040);
          break;
        case 'landBoost':
          st.small++;
          this.hud.message('Landing Boost!', '#ff9a1f');
          this.audio.play('small');
          this.fx.boostBurst(P, 0xffa040);
          break;
        case 'double':
          st.double++;
          setTimeout(() => this.hud.message('Double Boost!!', '#ff5fa8'), 120);
          this.audio.play('double');
          break;
        case 'nitro':
          st.nitro++;
          this.hud.message('Nitro!', '#27c7ff');
          this.audio.play('nitro');
          this.fx.boostBurst(P, 0x39a8ff);
          this.shake = Math.max(this.shake, 0.25);
          break;
        case 'gaugeFull':
          this.hud.message('Charged +1 N₂O', '#7af0ff', true);
          this.audio.play('gauge');
          break;
        case 'crash':
          st.crash++;
          if (this.sim && e.data.power > FATAL_WALL) this.retire(P);
          if (this.sim) {
            const pw = e.data.power;
            this.sim.damage(P, pw * 0.012, 'wing');
            if (pw > 14) this.sim.damage(P, pw * 0.008, 'susp');
            if (pw > 24) this.sim.damage(P, pw * 0.005, 'engine');
          }
          this.audio.play('crash', e.data.power);
          this.shake = Math.max(this.shake, Math.min(0.9, e.data.power * 0.05));
          this.fx.sparks(e.data.x, P.y + 0.6, e.data.z, 18);
          break;
        case 'scrape':
          this.sim?.damage(P, 0.003, 'wing');
          if (Math.random() < 0.3) this.fx.sparks(e.data.x, P.y + 0.5, e.data.z, 2);
          if (Math.random() < 0.08) this.audio.play('scrape');
          break;
        case 'land':
          if (e.data.air > 0.25) {
            this.audio.play('land');
            this.shake = Math.max(this.shake, 0.3);
            this.fx.dust(P.x, P.y, P.z);
          }
          break;
        case 'pad':
          this.hud.message('Boost Pad!', '#27c7ff', true);
          this.audio.play('pad');
          break;
      }
    }
    P.events.length = 0;
  }

  updateRaceHUD(dt) {
    const P = this.player;
    const laps = this.race.laps;
    const standings = this.standings.map((r) => ({
      name: r.name,
      me: r.isPlayer,
      fin: r.finished,
      tag: r.retired ? 'DNF' : r.pit ? 'PIT' : r.car && r.car.fuel <= 0 ? 'OUT' : r.car && Math.max(r.car.wing, r.car.engine, r.car.susp) > 0.5 ? 'DMG' : '',
      color: '#' + (r.model.userData.skin.dot ?? r.model.userData.skin.body).toString(16).padStart(6, '0'),
    }));
    const lapNow = clamp(P.lapsDone + 1, 1, laps);
    this.hud.update({
      lap: `${lapNow}/${laps}`,
      time: P.finished ? P.finishTime : this.state === 'countdown' ? 0 : this.raceTime,
      best: P.lapTimes.length ? Math.min(...P.lapTimes) : 0,
      kmh: P.speedKmh,
      rank: this.standings.indexOf(P) + 1,
      total: this.racers.length,
      gauge: P.gauge,
      nitro: P.nitroCount,
      standings,
      items: this.itemMode ? P.items : null,
      nitroOn: P.nitroTime > 0,
      smallOn: P.smallBoost > 0 || P.startBoost > 0 || P.padTime > 0,
      braking: P.braking,
      throttle: this.race.f1 ? (P.braking ? 0 : this.thr) : null,
    });
    if (this.sim) {
      this.hud.carStatus(P.car, P.box, P.pit, P.box && !P.pit ? (this.track.length - this.pit.u(P.d)) % this.track.length : null);
      // lead the way into the pits: light it up and point at the entry when a stop is called or needed
      const need = !P.box && !P.pit && !P.finished && !P.retired && this.sim.needsPit(P);
      const level = P.pit || P.finished || P.retired ? 0 : P.box ? 1 : need ? 0.6 : 0;
      this.pitCrew.setGuide(level, P.team);
      if (level > 0) {
        const q = this.track.sample(this.pit.d(4), {});
        const tx = q.x + q.rx * (this.track.halfW - 1), tz = q.z + q.rz * (this.track.halfW - 1);
        const angle = wrapAngle(Math.atan2(tx - P.x, tz - P.z) - P.h);
        this.hud.pitGuide({ level, angle, dist: (this.track.length - this.pit.u(P.d) + 4) % this.track.length });
      } else this.hud.pitGuide(null);
    }
    this.hud.drawSpeedo(P.speedKmh, P.nitroTime > 0);
    this.hud.drawMinimap(this.racers, P);
    let warn = null;
    if (P.wrongWay > 1.2 && this.state === 'race') warn = '⚠ WRONG WAY!';
    if (this.missileWarn > 0) { this.missileWarn -= dt; warn = '⚠ MISSILE LOCK!'; }
    this.hud.warn(warn);
  }

  // ---------- Effects ----------
  makeFx() {
    const smoke = new Particles(IS_TOUCH ? 900 : 1800, false);
    const glow = new Particles(IS_TOUCH ? 900 : 1800, true);
    const skids = new SkidMarks(2600);
    const R = Math.random;
    return {
      smoke, glow, skids,
      sparks(x, y, z, n) {
        for (let i = 0; i < n; i++) glow.emit(x, y, z, (R() - 0.5) * 16, R() * 7, (R() - 0.5) * 16, 0.4 + R() * 0.4, 0.5, 0.1, 1, 0.75 + R() * 0.25, 0.3, 1, 18, 1);
      },
      dust(x, y, z) {
        for (let i = 0; i < 24; i++) smoke.emit(x + (R() - 0.5) * 3, y + 0.3, z + (R() - 0.5) * 3, (R() - 0.5) * 8, R() * 2, (R() - 0.5) * 8, 1 + R(), 2, 6, 0.85, 0.8, 0.72, 0.5, -0.5, 1.5);
      },
      burst(x, y, z, color) {
        const c = new THREE.Color(color);
        for (let i = 0; i < 26; i++) glow.emit(x, y, z, (R() - 0.5) * 14, (R() - 0.2) * 10, (R() - 0.5) * 14, 0.5 + R() * 0.3, 1.2, 0.2, c.r, c.g, c.b, 1, 6, 2);
      },
      explode(x, y, z) {
        for (let i = 0; i < 40; i++) glow.emit(x, y, z, (R() - 0.5) * 22, R() * 14, (R() - 0.5) * 22, 0.5 + R() * 0.5, 3, 0.5, 1, 0.5 + R() * 0.4, 0.15, 1, 10, 2);
        for (let i = 0; i < 20; i++) smoke.emit(x, y, z, (R() - 0.5) * 8, R() * 6, (R() - 0.5) * 8, 1.2 + R(), 3, 9, 0.3, 0.3, 0.32, 0.6, -1, 1.5);
      },
      trail(x, y, z) {
        glow.emit(x, y, z, (R() - 0.5), (R() - 0.5), (R() - 0.5), 0.25, 1.2, 0.2, 1, 0.6, 0.2, 1);
        smoke.emit(x, y, z, (R() - 0.5), R(), (R() - 0.5), 0.8, 0.8, 3, 0.85, 0.85, 0.88, 0.4);
      },
      boostBurst(r, color) {
        const c = new THREE.Color(color);
        const bx = r.x - Math.sin(r.h) * 2.5, bz = r.z - Math.cos(r.h) * 2.5;
        for (let i = 0; i < 30; i++) glow.emit(bx, r.y + 0.6, bz, (R() - 0.5) * 10 - Math.sin(r.h) * 10, R() * 4, (R() - 0.5) * 10 - Math.cos(r.h) * 10, 0.35 + R() * 0.3, 1.6, 0.2, c.r, c.g, c.b, 1, 0, 3);
      },
    };
  }

  emitEffects(dt) {
    const fx = this.fx;
    const R = Math.random;
    const cam = this.camera.position;
    for (const r of this.racers) {
      const far = (r.x - cam.x) ** 2 + (r.z - cam.z) ** 2 > 250 * 250;
      const h = r.h;
      const fxv = Math.sin(h), fzv = Math.cos(h);
      const lx = Math.cos(h), lz = -Math.sin(h);
      const sp = Math.abs(r.s);
      const drifting = r.drifting && !r.airborne && sp > 10;
      const cu = r.model.userData;
      for (let w = 0; w < 2; w++) {
        const sx = w ? cu.track : -cu.track;
        const wx = r.x + lx * sx - fxv * cu.rearZ, wz = r.z + lz * sx - fzv * cu.rearZ;
        const key = (r.isPlayer ? 'p' : r.slot) + '-' + w;
        if (drifting) {
          fx.skids.add(key, wx, r.y, wz, lx, lz, 0.2, r.isPlayer ? 1 : 0.7);
          if (!far) {
            const rate = (r.isPlayer ? 55 : 22) * dt;
            for (let k = 0; k < rate + (R() < rate % 1 ? 1 : 0); k++)
              fx.smoke.emit(wx + (R() - 0.5) * 0.6, r.y + 0.25, wz + (R() - 0.5) * 0.6, (R() - 0.5) * 2 - fxv * sp * 0.08, 0.8 + R() * 1.2, (R() - 0.5) * 2 - fzv * sp * 0.08, 0.8 + R() * 0.7, 1.3, 5 + R() * 2, 0.95, 0.95, 0.97, r.isPlayer ? 0.42 : 0.3, -0.6, 1.2);
            if (r.isPlayer && R() < 0.5) {
              const c = r.gauge >= 1 || r.nitroCount >= 2 ? [1, 0.85, 0.3] : [0.5, 0.85, 1];
              fx.glow.emit(wx, r.y + 0.2, wz, (R() - 0.5) * 3, R() * 3, (R() - 0.5) * 3, 0.25, 0.5, 0.1, c[0], c[1], c[2], 1, 8, 1);
            }
          }
        } else fx.skids.cut(key);
      }
      const nitro = r.nitroTime > 0;
      const small = r.isPlayer && (r.smallBoost > 0 || r.padTime > 0 || r.startBoost > 0);
      if ((nitro || small) && !far) {
        for (const sx of [-0.42, 0.42]) {
          const ex = r.x + lx * sx - fxv * 2.6, ez = r.z + lz * sx - fzv * 2.6;
          const n = nitro ? 2 : 1;
          for (let k = 0; k < n; k++) {
            const c = nitro ? (R() < 0.5 ? [0.3, 0.7, 1] : [0.85, 0.95, 1]) : [1, 0.6, 0.2];
            fx.glow.emit(ex, r.y + 0.45, ez, -fxv * 6 + (R() - 0.5) * 2, R() * 1.5, -fzv * 6 + (R() - 0.5) * 2, 0.18 + R() * 0.1, nitro ? 1.3 : 0.9, 0.2, c[0], c[1], c[2], 1);
          }
        }
      }
      if (r.isPlayer && r.magnet > 0 && r.magnetTarget && !far) {
        const t = r.magnetTarget;
        for (let k = 0; k < 3; k++) {
          const f = R();
          fx.glow.emit(lerp(r.x, t.x, f), lerp(r.y, t.y, f) + 1, lerp(r.z, t.z, f), 0, 0, 0, 0.12, 0.8, 0.3, 0.8, 0.4, 1, 1);
        }
      }
    }
  }

  // ---------- Camera ----------
  // Grands Prix add an onboard camera from the driver's eyes
  cycleCamera() {
    this.camMode = (this.camMode + 1) % (this.race?.f1 ? 4 : 3);
    const d = this.player?.model.userData.driver;
    if (d) d.helmet.visible = d.visor.visible = this.camMode !== 3;
  }

  snapCamera() {
    const P = this.player;
    this.camYaw = P.h;
    this.camPos.set(P.x - Math.sin(P.h) * 9, P.y + 3.4, P.z - Math.cos(P.h) * 9);
    this.camLook.set(P.x, P.y + 1, P.z);
  }

  updateCamera(dt) {
    const cam = this.camera;
    if (cam.userData.fixed) return;
    const st = this.state;
    let target = this.player;
    if (st === 'menu') {
      this.demoT += dt;
      if (this.demoT > 9) { this.demoT = 0; this.demoTarget = (this.demoTarget + 1) % this.racers.length; this.demoCut = true; }
      target = this.racers[this.demoTarget];
    }
    if (!target) return;
    const tx = target.x, ty = target.y, tz = target.z;
    const orbit = target.retired || (this.celeb && this.celeb.phase !== 'ask');
    if (st === 'menu' || (st === 'finish' && this.resultShown) || orbit) {
      const a = this.time * 0.25 + this.demoTarget;
      // fireworks: pull back and look up into the sky where the shells burst
      const sky = this.celeb?.kind === 'fireworks' && this.celeb.phase === 'go';
      const R = sky ? 30 : 11;
      const want = new THREE.Vector3(tx + Math.sin(a) * R, ty + (sky ? 5 : 3.2 + Math.sin(this.time * 0.4) * 1.2), tz + Math.cos(a) * R);
      if (this.demoCut) { this.camPos.copy(want); this.demoCut = false; }
      this.camPos.lerp(want, 1 - Math.exp(-3 * dt));
      this.camLook.lerp(new THREE.Vector3(tx, ty + (sky ? 16 : 1), tz), sky ? 1 - Math.exp(-2 * dt) : 1);
      cam.position.copy(this.camPos);
      cam.lookAt(this.camLook);
      cam.fov = damp(cam.fov, 55, 3, dt);
      cam.updateProjectionMatrix();
      return;
    }
    const P = target;
    if (this.camMode === 3 && P.model.userData.driver) {
      // eye level in the cockpit: halo, wheel and hands in view
      const root = P.model.userData.root;
      P.model.updateMatrixWorld();
      // just above the halo, pitched down so the wheel and hands sit at the bottom of the frame
      cam.position.set(0, 1.13, 0.22).applyMatrix4(root.matrixWorld); // just ahead of the airbox
      this.camLook.set(0, 0.0, 10).applyMatrix4(root.matrixWorld);
      cam.lookAt(this.camLook);
      this.camPos.copy(cam.position);
      cam.near = 0.05;
      cam.fov = damp(cam.fov, 74 + Math.abs(P.s) * 0.08, 4, dt);
      cam.updateProjectionMatrix();
      return;
    }
    if (cam.near !== 0.3) { cam.near = 0.3; cam.updateProjectionMatrix(); }
    if (this.camMode === 3) this.camMode = 0;
    const modes = [
      { dist: 8.2, h: 3.0, look: 5, lookH: 1.3 },
      { dist: 12.5, h: 4.6, look: 6, lookH: 1.5 },
      { dist: 5.2, h: 1.9, look: 8, lookH: 1.1 },
    ];
    const m = modes[this.camMode];
    // While drifting the camera follows the velocity direction so you can see the car slide
    const yawT = P.s >= 0 ? P.m + wrapAngle(P.h - P.m) * 0.35 : P.h;
    this.camYaw = dampAngle(this.camYaw, yawT, P.drifting ? 4.5 : 7, dt);
    const boostPull = P.nitroTime > 0 ? 1.6 : P.smallBoost > 0 ? 0.8 : 0;
    const dist = m.dist + Math.abs(P.s) * 0.018 + boostPull;
    const want = new THREE.Vector3(P.x - Math.sin(this.camYaw) * dist, P.y + m.h, P.z - Math.cos(this.camYaw) * dist);
    // Keep the camera above the ground
    const gy = this.groundAt(want.x, want.z) + 1.0;
    if (want.y < gy) want.y = gy;
    if (P.airborne) want.y = Math.max(want.y, P.y + m.h);
    this.camPos.lerp(want, 1 - Math.exp(-14 * dt));
    this.camPos.y = damp(this.camPos.y, want.y, 8, dt);
    const look = new THREE.Vector3(P.x + Math.sin(this.camYaw) * m.look, P.y + m.lookH, P.z + Math.cos(this.camYaw) * m.look);
    this.camLook.lerp(look, 1 - Math.exp(-18 * dt));
    cam.position.copy(this.camPos);
    if (this.shake > 0) {
      const k = this.shake * this.shake;
      cam.position.x += (Math.random() - 0.5) * k * 1.2;
      cam.position.y += (Math.random() - 0.5) * k * 1.0;
      cam.position.z += (Math.random() - 0.5) * k * 1.2;
      this.shake = Math.max(0, this.shake - dt * 1.8);
    }
    if (P.nitroTime > 0) {
      cam.position.x += (Math.random() - 0.5) * 0.06;
      cam.position.y += (Math.random() - 0.5) * 0.06;
    }
    cam.lookAt(this.camLook);
    const fovT = 66 + Math.abs(P.s) * 0.12 + (P.nitroTime > 0 ? 9 : 0) + (P.smallBoost > 0 ? 4 : 0);
    cam.fov = damp(cam.fov, fovT, 4, dt);
    cam.updateProjectionMatrix();
  }

  render(dt) {
    if (!this.track) return;
    this.updateCamera(dt);
    const cp = this.camera.position;
    if (this.skyMesh) this.skyMesh.position.copy(cp);
    if (this.sun) {
      const f = this.player && this.state !== 'menu' ? this.player : this.racers[this.demoTarget] || { x: cp.x, y: cp.y, z: cp.z };
      // Shadow camera follows the player, snapped to texels to reduce shimmering
      const snap = 150 / this.sun.shadow.mapSize.x;
      const fx = Math.round(f.x / snap) * snap, fz = Math.round(f.z / snap) * snap;
      this.sun.target.position.set(fx, f.y, fz);
      this.sun.position.set(fx + this.sunDir.x * 220, f.y + this.sunDir.y * 220, fz + this.sunDir.z * 220);
    }
    const P = this.player;
    if (P && (this.state === 'race' || this.state === 'finish')) {
      const k = clamp((Math.abs(P.s) - 42) / 30, 0, 1) * 0.6 + (P.nitroTime > 0 ? 0.6 : 0) + (P.smallBoost > 0 ? 0.25 : 0);
      this.hud.speedLines(dt, k, P.nitroTime > 0 ? '#bfe9ff' : '#ffffff');
    } else if (this.hud.lines.length) this.hud.clearFx();
    if (this.bloom) this.bloom.strength = (this.settings.quality === 'high' ? 0.75 : 0.6) + (P && P.nitroTime > 0 ? 0.3 : 0);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}

// ---------- Installable, offline-capable app (PWA) ----------
function toast(msg, label, onClick) {
  $('toastmsg').textContent = msg;
  $('toastbtn').textContent = label;
  $('toastbtn').onclick = () => { $('toast').classList.add('hidden'); onClick(); };
  $('toast').classList.remove('hidden');
}

function setupPWA() {
  const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
  // Chrome, Edge and Android offer a real install prompt; iOS needs the Share menu
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    $('installbtn').classList.remove('hidden');
  });
  $('installbtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    $('installbtn').classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => $('installbtn').classList.add('hidden'));
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) $('iosinstall').classList.remove('hidden');

  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  let accepted = false;
  const hook = (reg) => {
    if (!reg) return;
    // a newer version finished downloading in the background: let the player pick the moment to switch
    const offer = (w) => toast('A new version is ready.', 'Reload', () => { accepted = true; w.postMessage('skipWaiting'); });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // opened offline: look for a new version as soon as the connection is back
    window.addEventListener('online', () => reg.update().catch(() => {}));
  };
  // registering needs the network; offline, fall back to the registration we already have
  navigator.serviceWorker.register('sw.js').then(hook)
    .catch(() => navigator.serviceWorker.getRegistration().then(hook))
    .catch(() => { /* offline support is optional */ });
  // only reload for an update the player accepted (the first install also changes controller)
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (accepted) location.reload(); });
}

window.addEventListener('DOMContentLoaded', () => {
  setupPWA();
  try {
    window.game = new Game();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;color:#fff;font-family:sans-serif">Failed to initialize WebGL: ${e.message}</div>`;
    throw e;
  }
});
