// First-person cockpit for the arcade cars: a few light meshes parented to the camera (dashboard with a live
// speed / gear / rev display, steering wheel in the style the Garage fitted, thin A-pillars and roof rail) plus a
// hood in the car's paint. The player's own car model is hidden while this view is on: seen from inside, its lamps, tyres and
// roof panel would poke into the view. One instance is reused for every car and race, so switching views
// allocates nothing.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const DASH_W = 256, DASH_H = 128;

// ---------- Steering wheels (catalog.js steering parts) ----------
// Each is drawn facing +z, centred on the hub, about 0.42 across; it turns about z.
const std = (color, roughness = 0.6, metalness = 0, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
// a rim along a closed outline of [x, y] points (a flat-bottomed D, a yoke's frame)
function rimAlong(pts, r) {
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)), true, 'centripetal');
  return new THREE.TubeGeometry(curve, 64, r, 8, true);
}
function spokes(g, mat, angles, len = 0.2, w = 0.03) {
  for (const a of angles) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, w, 0.02), mat);
    m.position.set(Math.cos(a) * len / 2, Math.sin(a) * len / 2, 0);
    m.rotation.z = a;
    g.add(m);
  }
}
const hub = (g, mat, r = 0.055) => g.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.04, 20).rotateX(Math.PI / 2), mat));
const marker = (g, color, y = 0.21) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.016, 0.03), std(color, 0.5)); m.position.set(0, y, 0.012); g.add(m); };
const SPOKES3 = [Math.PI / 2, -Math.PI / 6, (7 * Math.PI) / 6];
const WHEELS = {
  factory(g) {
    const soft = std(0x0d0e12, 0.9);
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.028, 10, 40), std(0x2c303b)));
    marker(g, 0xffd23a);
    spokes(g, soft, SPOKES3);
    hub(g, soft);
  },
  // suede rim with a flat bottom, red top marker, brushed spokes
  sport(g) {
    const pts = [];
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; pts.push([Math.cos(a) * 0.21, Math.max(-0.165, Math.sin(a) * 0.21)]); }
    g.add(new THREE.Mesh(rimAlong(pts, 0.03), std(0x1c1d22, 0.95)));
    marker(g, 0xe53935);
    const alu = std(0x9aa3b5, 0.35, 0.8);
    spokes(g, alu, [0, Math.PI], 0.2, 0.034);
    spokes(g, alu, [-Math.PI / 2], 0.16, 0.05);
    hub(g, std(0x15161b, 0.5, 0.3));
  },
  // polished wood rim on four thin chrome spokes
  wood(g) {
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.024, 10, 48), std(0x7a4422, 0.38, 0.05)));
    const chrome = std(0xe8ecf2, 0.15, 1);
    spokes(g, chrome, [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4], 0.2, 0.018);
    hub(g, chrome, 0.05);
  },
  // an open race yoke: two grips and a bar under a carbon plate with coloured buttons
  yoke(g) {
    const carbon = std(0x17181c, 0.35, 0.4), grip = std(0x101115, 0.95);
    const pts = [[-0.2, 0.1], [-0.21, -0.06], [-0.15, -0.13], [0, -0.14], [0.15, -0.13], [0.21, -0.06], [0.2, 0.1], [0.15, 0.13], [0.12, 0.06], [0, 0.05], [-0.12, 0.06], [-0.15, 0.13]];
    g.add(new THREE.Mesh(rimAlong(pts, 0.026), grip));
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.13, 0.025), carbon);
    plate.position.y = -0.02;
    g.add(plate);
    [0xe53935, 0xffd23a, 0x36e2ff, 0x7cff6b].forEach((c, i) => {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 12).rotateX(Math.PI / 2), std(c, 0.4, 0, { emissive: c, emissiveIntensity: 0.6 }));
      b.position.set(i < 2 ? -0.075 : 0.075, i % 2 ? -0.06 : 0.0, 0.016);
      g.add(b);
    });
    marker(g, 0xffd23a, 0.13);
  },
  // dark rim with a glowing cyan ring inside it
  neon(g) {
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.028, 10, 40), std(0x15161b, 0.5)));
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.183, 0.006, 6, 48), std(0x36e2ff, 0.4, 0, { emissive: 0x36e2ff, emissiveIntensity: 2 })));
    marker(g, 0x36e2ff);
    spokes(g, std(0x0d0e12, 0.8), SPOKES3);
    hub(g, std(0x0d0e12, 0.8));
  },
  // a gold-spoked rally wheel, dished
  gold(g) {
    g.add(new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.027, 10, 40), std(0x1b1c21, 0.8)));
    const gold = std(0xe0b23a, 0.22, 1);
    for (const a of SPOKES3) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.034, 0.02), gold);
      m.position.set(Math.cos(a) * 0.1, Math.sin(a) * 0.1, -0.03);
      m.rotation.set(0, Math.sin(a) * 0.3, a);
      g.add(m);
    }
    hub(g, gold, 0.05);
    marker(g, 0xff3b3b);
  },
};
export function buildSteeringWheel(style) {
  const g = new THREE.Group();
  (WHEELS[style] || WHEELS.factory)(g);
  g.traverse((o) => { if (o.isMesh) { o.renderOrder = 10; o.castShadow = o.receiveShadow = false; } });
  return g;
}

// pictures of steering wheels for the Garage: { style: data URL }, made once
let thumbs = null;
export function steeringThumbs(styles, w = 240, h = 160) {
  if (thumbs) return thumbs;
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(w, h, false);
  r.toneMapping = THREE.NeutralToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(r);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x404a60, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(1, 2, 3);
  scene.add(sun);
  const cam = new THREE.PerspectiveCamera(30, w / h, 0.05, 10);
  cam.position.set(0, -0.12, 0.95);
  cam.lookAt(0, 0, 0);
  thumbs = {};
  for (const s of styles) {
    const g = buildSteeringWheel(s);
    g.rotation.x = -0.25;
    scene.add(g);
    r.render(scene, cam);
    thumbs[s] = canvas.toDataURL('image/png');
    scene.remove(g);
    disposeTree(g);
  }
  env.dispose();
  pmrem.dispose();
  r.dispose();
  r.forceContextLoss();
  return thumbs;
}
function disposeTree(g) { g.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); }

export class Cockpit {
  constructor(camera) {
    const g = (this.group = new THREE.Group());
    g.visible = false;
    camera.add(g);
    const trimM = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.75 });
    const softM = new THREE.MeshStandardMaterial({ color: 0x0d0e12, roughness: 0.9 });
    const add = (geo, mat, x, y, z, parent = g) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.renderOrder = 10;
      parent.add(m);
      return m;
    };
    // everything is in camera space: -z is straight ahead, the frame's half-height at z = -0.75 is about 0.5
    this.body = new THREE.Group();
    g.add(this.body);
    // hood: slopes away below the windshield in the car's paint
    this.paint = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.55, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08 });
    const hood = new THREE.BoxGeometry(1, 1, 1);
    const hp = hood.attributes.position;
    for (let i = 0; i < hp.count; i++) {
      const near = hp.getZ(i) > 0;
      hp.setXYZ(i, hp.getX(i) * (near ? 1.9 : 1.15), hp.getY(i) * 0.06 + (near ? -0.5 : -0.72), near ? -0.9 : -2.7);
    }
    hood.computeVertexNormals();
    add(hood, this.paint, 0, 0, 0, this.body);
    // dashboard: a low, wide shelf with a soft top so the road stays in view
    add(new THREE.BoxGeometry(2.0, 0.14, 0.42), trimM, 0, -0.5, -0.82, this.body).rotation.x = 0.12;
    add(new THREE.BoxGeometry(2.0, 0.04, 0.12), softM, 0, -0.43, -0.98, this.body);
    // instrument binnacle with a live display
    const canvas = document.createElement('canvas');
    canvas.width = DASH_W;
    canvas.height = DASH_H;
    this.ctx = canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    add(new THREE.BoxGeometry(0.42, 0.13, 0.12), trimM, 0, -0.31, -0.8, this.body).rotation.x = -0.25;
    const screen = add(new THREE.PlaneGeometry(0.36, 0.18), new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }), 0, -0.29, -0.735, this.body);
    screen.rotation.x = -0.25;
    // steering wheel: rim, three spokes, hub and a yellow top marker so its turn reads at a glance
    const wheel = (this.wheel = new THREE.Group());
    wheel.position.set(0, -0.55, -0.55); // only the top arc shows, just under the display
    wheel.rotation.x = -0.32;
    this.body.add(wheel);
    const spin = (this.wheelSpin = new THREE.Group());
    wheel.add(spin);
    this.style = '';
    this.setWheel('factory');
    // A-pillars and roof rail: thin and kept to the edges of the frame
    this.pillars = [-1, 1].map((s) => {
      const p = add(new THREE.BoxGeometry(0.07, 1.3, 0.07), trimM, s * 1.0, 0.05, -0.82);
      p.rotation.z = s * 0.42;
      return p;
    });
    add(new THREE.BoxGeometry(2.6, 0.09, 0.2), trimM, 0, 0.57, -0.85);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    this.shown = '';
  }

  setCar(model) {
    this.paint.color.set(model.userData.look?.paint ?? model.userData.skin?.body ?? 0xffffff);
    this.setWheel(model.userData.look?.steering || 'factory');
  }

  // the steering wheel the car has fitted (built when it changes, so a race allocates nothing)
  setWheel(style) {
    if (style === this.style) return;
    this.style = style;
    for (const o of [...this.wheelSpin.children]) { this.wheelSpin.remove(o); disposeTree(o); }
    this.wheelSpin.add(buildSteeringWheel(style));
  }

  // narrow (portrait) screens see less sideways: pull the cabin in and shrink the wheel so the road stays clear
  fit(aspect) {
    const k = Math.min(1, aspect / 1.5);
    this.body.scale.setScalar(0.75 + 0.25 * k);
    this.body.position.y = (1 - k) * -0.22;
    for (const p of this.pillars) p.visible = aspect > 1.1;
  }

  update(P, steer) {
    this.wheelSpin.rotation.z = -steer * 1.7;
    const kmh = Math.round(P.speedKmh || 0);
    const fwd = P.s > 0.5;
    const gear = P.s < -0.5 ? 'R' : fwd ? String((P.gear ?? 0) + 1) : 'N';
    const g = Math.max(0, P.s) / (P.T?.vmaxNitro || 76) * 6;
    const rpm = fwd ? Math.min(1, 0.3 + (g - Math.min(5, Math.floor(g))) * 0.7) : 0.12;
    const key = `${kmh}|${gear}|${Math.round(rpm * 16)}|${P.nitroTime > 0}`;
    if (key !== this.shown) { this.shown = key; this.draw(kmh, gear, rpm, P.nitroTime > 0); }
  }

  draw(kmh, gear, rpm, nitro) {
    const c = this.ctx;
    c.fillStyle = '#07080f';
    c.fillRect(0, 0, DASH_W, DASH_H);
    // rev bar: 16 segments, cyan -> yellow -> red
    for (let i = 0; i < 16; i++) {
      const on = i < Math.round(rpm * 16);
      c.fillStyle = on ? (i >= 13 ? '#ff4545' : i >= 9 ? '#ffd23a' : '#36e2ff') : '#1c1f2b';
      c.fillRect(12 + i * 14.5, 10, 11, 12);
    }
    c.textBaseline = 'alphabetic';
    c.fillStyle = nitro ? '#bfe9ff' : '#f4f1e8';
    c.font = 'italic 900 64px "Bungee","Arial Black",Arial,sans-serif';
    c.textAlign = 'right';
    c.fillText(String(kmh), 176, 96);
    c.fillStyle = '#a3a6bf';
    c.font = '700 15px "Chakra Petch",Arial,sans-serif';
    c.fillText('KM/H', 176, 116);
    // gear box
    c.fillStyle = '#ffd23a';
    c.fillRect(190, 44, 54, 64);
    c.fillStyle = '#07080f';
    c.textAlign = 'center';
    c.font = '900 46px "Bungee","Arial Black",Arial,sans-serif';
    c.fillText(gear, 217, 94);
    this.tex.needsUpdate = true;
  }
}
