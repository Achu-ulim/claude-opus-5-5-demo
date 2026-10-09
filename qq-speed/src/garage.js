// The garage: paint, finish, accent, stripes, rims, tyres, calipers and underglow for each car, on a turntable
// preview. Looks are saved per car (settings.looks[car id]) and never change how a car drives.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CARS, buildCar, defaultLook, resolveLook } from './carModel.js';
import { RIMS } from './carGeometry.js';
import { cleanLook } from './netproto.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const PAINTS = [0xd40000, 0xff6a00, 0xffc21a, 0x8fd14f, 0x00897b, 0x1e88e5, 0x2c3e9e, 0x6a1b9a, 0xe91e63, 0xeceff2, 0x9aa1aa, 0x26282c, 0x0a0a0c, 0x6d4c41];
const ACCENTS = [0x151515, 0xeceff2, 0xd40000, 0xffd000, 0xff6a00, 0x1e88e5, 0x00c853, 0xc0c4ca];
const RIM_COLORS = [0xcfd6de, 0x2b2b2b, 0x4a4f57, 0xd4af37, 0xb87333, 0xf2f2f2, 0xc62828, 0x1e88e5];
const CALIPERS = [0xe53935, 0xffcc00, 0x1e88e5, 0x43a047, 0xff6a00, 0x1b1b1b, 0xc0c4ca, 0x8e24aa];
const GLOWS = [0x6fb6ff, 0x3dffd0, 0xb6ff5a, 0xffe066, 0xff9a3a, 0xff3a5a, 0xd06bff, 0xffffff];
const FINISHES = [['gloss', 'Gloss'], ['metallic', 'Metallic'], ['matte', 'Matte'], ['pearl', 'Pearl'], ['chrome', 'Chrome']];
const TYRES = [['street', 'Street'], ['redline', 'Red Line'], ['whitewall', 'White Wall'], ['letters', 'Lettered']];

export class Garage {
  constructor(game) {
    this.game = game;
    this.car = null;
    this.yaw = 0.7;
    this.bind();
  }

  get looks() { return (this.game.settings.looks ||= {}); }
  lookOf(car) { return cleanLook(this.looks[car.id]); }

  bind() {
    const pick = (id, field, parse = (v) => +v) => $(id).addEventListener('click', (e) => {
      const o = e.target.closest('[data-v]');
      if (o) this.set(field, parse(o.dataset.v));
    });
    pick('gPaint', 'paint');
    pick('gAccent', 'accent');
    pick('gRimColor', 'rimColor');
    pick('gCaliper', 'caliper');
    pick('gGlow', 'glow');
    pick('gFinish', 'finish', String);
    pick('gRim', 'rim', String);
    pick('gTyre', 'tyre', String);
    pick('gStripes', 'stripes', (v) => v === 'on');
    // the rainbow swatches open the system color picker
    for (const [id, field] of [['gPaint', 'paint'], ['gAccent', 'accent']]) {
      $(id).addEventListener('input', (e) => { if (e.target.type === 'color') this.set(field, parseInt(e.target.value.slice(1), 16), true); });
    }
    $('gReset').addEventListener('click', () => {
      this.game.audio.play('click');
      delete this.looks[this.car.id];
      this.game.save();
      this.changed();
    });
    $('gDone').addEventListener('click', () => this.close());
    // drag the preview round
    const view = $('gViewBox');
    view.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, yaw: this.yaw }; view.setPointerCapture(e.pointerId); view.style.cursor = 'grabbing'; });
    view.addEventListener('pointermove', (e) => { if (this.drag) this.yaw = this.drag.yaw + (e.clientX - this.drag.x) * 0.012; });
    const up = () => { if (this.drag) { this.drag = null; this.idle = 0; view.style.cursor = ''; } };
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
  }

  // open on a car; back to `from` ('menu' or 'online') when done
  open(carIndex, from = 'menu') {
    this.game.audio.play('click');
    this.car = CARS[carIndex] || CARS[0];
    this.from = from;
    $(from).classList.add('hidden');
    $('garage').classList.remove('hidden');
    $('gCar').textContent = `${this.car.name} · ${this.car.cls}`;
    this.startPreview();
    this.changed();
  }

  get isOpen() { return !$('garage').classList.contains('hidden'); }

  close() {
    if (!this.isOpen) return;
    this.game.audio.play('click');
    $('garage').classList.add('hidden');
    $(this.from).classList.remove('hidden');
    this.stopPreview();
    this.game.onLooksChanged();
  }

  set(field, value, quiet = false) {
    if (!quiet) this.game.audio.play('click');
    const id = this.car.id;
    const next = { ...this.lookOf(this.car), [field]: value };
    // only what differs from the factory look is stored
    const def = defaultLook(this.car);
    for (const k of Object.keys(next)) if (next[k] === def[k]) delete next[k];
    if (Object.keys(next).length) this.looks[id] = next; else delete this.looks[id];
    this.game.save();
    this.changed();
  }

  changed() {
    const L = resolveLook(this.car, this.lookOf(this.car));
    this.renderOptions(L);
    this.showCar(L);
  }

  renderOptions(L) {
    const sw = (list, cur, picker = false) => list.map((c) => `<div class="sw${c === cur ? ' sel' : ''}" data-v="${c}" style="background:${hex(c)}" title="${hex(c)}"></div>`).join('')
      + (picker ? `<label class="sw pick${list.includes(cur) ? '' : ' sel'}" title="Any color"><input type="color" value="${hex(cur)}" aria-label="Pick any color"></label>` : '');
    const opts = (list, cur) => list.map(([v, name]) => `<div class="opt${v === cur ? ' sel' : ''}" data-v="${v}">${name}</div>`).join('');
    const withDefault = (list, c) => (list.includes(c) ? list : [c, ...list]);
    const def = defaultLook(this.car);
    $('gPaint').innerHTML = sw(withDefault(PAINTS, def.paint), L.paint, true);
    $('gAccent').innerHTML = sw(withDefault(ACCENTS, def.accent), L.accent, true);
    $('gRimColor').innerHTML = sw(withDefault(RIM_COLORS, def.rimColor), L.rimColor);
    $('gCaliper').innerHTML = sw(withDefault(CALIPERS, def.caliper), L.caliper);
    $('gGlow').innerHTML = sw(withDefault(GLOWS, def.glow), L.glow);
    $('gFinish').innerHTML = opts(FINISHES, L.finish);
    $('gRim').innerHTML = opts(RIMS.map((r) => [r.id, r.name]), L.rim);
    $('gTyre').innerHTML = opts(TYRES, L.tyre);
    $('gStripes').innerHTML = opts([['on', 'On'], ['off', 'Off']], L.stripes ? 'on' : 'off');
  }

  // ---------- Turntable preview (its own small renderer, only while the garage is open) ----------
  startPreview() {
    if (this.r) return;
    // a fresh canvas each time: the last one's WebGL context was released when the garage closed
    const canvas = document.createElement('canvas');
    canvas.id = 'gView';
    $('gView').replaceWith(canvas);
    const r = (this.r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 0.95;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = (this.scene = new THREE.Scene());
    const pmrem = new THREE.PMREMGenerator(r);
    this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = this.env;
    scene.environmentIntensity = 0.55;
    scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x2a3040, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.2);
    rim.position.set(-5, 3, -6);
    scene.add(rim);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(5.5, 48), new THREE.MeshStandardMaterial({ color: 0x1a2232, roughness: 0.6, metalness: 0.2 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.cam = new THREE.PerspectiveCamera(30, 1.6, 0.1, 100);
    this.idle = 0;
    this.last = performance.now();
    const loop = () => {
      if (!this.r) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      // turns slowly by itself, a moment after the player lets go
      if (!this.drag && (this.idle += dt) > 1.2) this.yaw += dt * 0.35;
      this.render();
    };
    loop();
  }

  render() {
    const r = this.r, c = r.domElement;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * r.getPixelRatio()) || c.height !== Math.round(h * r.getPixelRatio())) r.setSize(w, h, false);
    this.cam.aspect = w / h;
    // frame the whole car whatever the panel's shape
    const dist = Math.max(8.2, 6.4 / Math.min(1, this.cam.aspect / 1.4));
    this.cam.position.set(Math.sin(0.35) * dist, 2.3, Math.cos(0.35) * dist);
    this.cam.lookAt(0, 0.55, 0);
    this.cam.updateProjectionMatrix();
    if (this.model) this.model.rotation.y = this.yaw;
    r.render(this.scene, this.cam);
  }

  showCar(L) {
    if (!this.r) return;
    if (this.model) { this.scene.remove(this.model); dispose(this.model); }
    const m = (this.model = buildCar(this.car, { look: L }));
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    m.userData.under.position.y = 0.02;
    this.scene.add(m);
  }

  stopPreview() {
    if (!this.r) return;
    cancelAnimationFrame(this.raf);
    if (this.model) { dispose(this.model); this.model = null; }
    this.env?.dispose();
    this.r?.dispose();
    this.r?.forceContextLoss();
    this.r = null;
  }
}

// free the GPU copies (three uploads cached geometry again if it's used later, as Game.clearRacers relies on too)
function dispose(model) {
  model.traverse((o) => {
    o.geometry?.dispose();
    if (o.material && !o.isSprite) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
  });
}
