// First-person cockpit for the arcade cars: a few light meshes parented to the camera (dashboard with a live
// speed / gear / rev display, steering wheel, thin A-pillars and roof rail) plus a hood in the car's
// paint. The player's own car model is hidden while this view is on: seen from inside, its lamps, tyres and
// roof panel would poke into the view. One instance is reused for every car and race, so switching views
// allocates nothing.
import * as THREE from 'three';

const DASH_W = 256, DASH_H = 128;

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
    add(new THREE.TorusGeometry(0.21, 0.028, 10, 40), new THREE.MeshStandardMaterial({ color: 0x2c303b, roughness: 0.6 }), 0, 0, 0, spin);
    add(new THREE.BoxGeometry(0.05, 0.016, 0.03), new THREE.MeshStandardMaterial({ color: 0xffd23a, roughness: 0.5 }), 0, 0.21, 0.012, spin);
    for (const a of [Math.PI / 2, -Math.PI / 6, (7 * Math.PI) / 6]) {
      const s = add(new THREE.BoxGeometry(0.2, 0.03, 0.02), softM, Math.cos(a) * 0.1, Math.sin(a) * 0.1, 0, spin);
      s.rotation.z = a;
    }
    add(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 20).rotateX(Math.PI / 2), softM, 0, 0, 0, spin);
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
    this.paint.color.set(model.userData.skin?.body ?? 0xffffff);
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
