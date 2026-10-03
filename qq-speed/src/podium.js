import * as THREE from 'three';
import { textTexture, podiumBackdropTexture } from './textures.js';
import { clamp, lerp } from './util.js';

// Formula 1 podium ceremony, staged on the start/finish straight after every Grand Prix: the top three cars in
// parc fermé, the drivers on the steps, the winner's anthem, trophies (third, second, then the winner lifting the big
// one overhead) and champagne. It drives the camera while it runs, then idles behind the results until disposed.

// podium-local: +z faces the audience (back down the straight); P2 stands on the winner's right, camera-left
const STEPS = [{ x: 0, h: 0.9 }, { x: -2.4, h: 0.62 }, { x: 2.4, h: 0.4 }];
const BASE = 0.25; // plinth height
const HIP = 0.84; // driver origin above the soles
const AT = 70; // meters past the line
const BACKDROP_BRANDS = ['pirelli', 'rolex', 'dhl', 'chowdeck', 'manlago', 'shell', 'petronas', 'motul'];
const T = { anthem: 0.4, trophy: [8.8, 7.4, 6.0], lift: 0.7, bottles: 11, spray: 11.4, sprayEnd: 16.6, end: 17.6 };

// camera path, podium-local: [time, position, look-at]
// (the parked cars sit beyond z = 11.5, so after the opening shot over them the camera stays in front of them)
const CAM = [
  [0, [0, 4.4, 25], [0, 1.9, 0]],
  [5.8, [0, 2.9, 10.5], [0, 1.9, 0]],
  [8.6, [1.6, 2.6, 8], [0, 2.0, 0]],
  [10.4, [0, 2.9, 5.4], [0, 2.75, 0]],
  [12.2, [0, 2.8, 9.5], [0, 1.9, 0]],
  [T.end, [-2.2, 3.0, 10.5], [0, 1.8, 0]],
];

const smooth = (k) => k * k * (3 - 2 * k);

function trophy(scale) {
  const g = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 1, roughness: 0.22, emissive: 0x3a2600, emissiveIntensity: 0.5, side: THREE.DoubleSide });
  const black = new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.4 });
  const profile = [[0, 0.08], [0.06, 0.08], [0.06, 0.1], [0.03, 0.13], [0.028, 0.24], [0.06, 0.28], [0.12, 0.36], [0.14, 0.48], [0.13, 0.52]];
  const cup = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 24), gold);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.08, 16), black);
  base.position.y = 0.04;
  g.add(cup, base);
  for (const s of [-1, 1]) {
    const h = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 14, Math.PI), gold);
    h.position.set(s * 0.13, 0.42, 0);
    h.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(h);
  }
  g.scale.setScalar(scale);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// champagne bottle, built neck-down so it points along a hanging arm
function bottle() {
  const g = new THREE.Group();
  const glass = new THREE.MeshStandardMaterial({ color: 0x1f4a2a, roughness: 0.15, metalness: 0.3 });
  const foil = new THREE.MeshStandardMaterial({ color: 0xe8c45a, metalness: 0.9, roughness: 0.3 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.2, 12), glass);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.04, 0.1, 12), glass);
  neck.position.y = 0.15;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.04, 10), foil);
  top.position.y = 0.21;
  g.add(body, neck, top);
  g.rotation.x = Math.PI;
  return g;
}

export class Podium {
  // top: the first three in the standings; onDone runs once when the ceremony ends or is skipped
  constructor(game, top, title, onDone) {
    this.g = game;
    this.top = top;
    this.onDone = onDone;
    this.t = 0;
    this.finished = false;
    const tr = game.track;
    const s = tr.sample(AT, {});
    const grp = (this.group = new THREE.Group());
    grp.position.set(s.x, s.y + 0.02, s.z);
    grp.rotation.y = s.hd + Math.PI;
    grp.updateMatrixWorld();
    game.scene.add(grp);
    this.focus = grp.position;

    // plinth, steps with their numbers, backdrop with the sponsor wall
    const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...o });
    const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true; grp.add(mesh); return mesh; };
    add(new THREE.Mesh(new THREE.BoxGeometry(8.6, BASE, 3.2), std(0x15151e)), 0, BASE / 2, 0.2);
    STEPS.forEach((st, i) => {
      add(new THREE.Mesh(new THREE.BoxGeometry(2.2, st.h, 1.8), std(0xe9eaee)), st.x, BASE + st.h / 2, 0.4);
      add(new THREE.Mesh(new THREE.BoxGeometry(2.22, 0.08, 1.82), std(i ? 0xb9bcc4 : 0xd9a93a, { metalness: i ? 0.3 : 0.7, roughness: 0.4 })), st.x, BASE + st.h - 0.04, 0.4);
      const num = textTexture(String(i + 1), { w: 256, h: 256, bg: '#e10600', fg: '#ffffff', font: '900 190px "Arial Black", Arial' });
      add(new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), new THREE.MeshStandardMaterial({ map: num, emissiveMap: num, emissive: 0xffffff, emissiveIntensity: 0.12 })), st.x, BASE + st.h / 2, 1.31);
    });
    const bd = podiumBackdropTexture(title, BACKDROP_BRANDS);
    add(new THREE.Mesh(new THREE.BoxGeometry(10.4, 4.8, 0.25), std(0x0d0d12)), 0, 2.4 + BASE, -1.3);
    add(new THREE.Mesh(new THREE.PlaneGeometry(10, 4.375), new THREE.MeshStandardMaterial({ map: bd, emissiveMap: bd, emissive: 0xffffff, emissiveIntensity: 0.22, roughness: 0.8 })), 0, 2.4 + BASE, -1.16);
    const lamp = new THREE.PointLight(0xfff4e0, 14, 20);
    lamp.position.set(0, 5.5, 5);
    grp.add(lamp);

    // parc fermé: the top three cars nose-in to the podium, a numbered board in front of each
    const v = new THREE.Vector3();
    top.forEach((r, i) => {
      const x = STEPS[i].x * 2.4;
      grp.localToWorld(v.set(x, 0, 14.8));
      const m = r.model;
      m.position.set(v.x, s.y, v.z);
      m.rotation.set(0, s.hd, 0);
      const u = m.userData;
      if (u.tag) u.tag.visible = false;
      if (u.flames) for (const f of u.flames) f.visible = false;
      const plate = textTexture(String(i + 1), { w: 128, h: 128, bg: '#15151e', fg: '#ffd23a', font: '900 96px "Arial Black", Arial' });
      add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 0.08), std(0x444a55)), x + 1.9, 0.55, 11.6);
      add(new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshStandardMaterial({ map: plate })), x + 1.9, 1.35, 11.65);
    });
    // the rest of the field has gone to the garages
    for (const r of game.racers) if (!top.includes(r)) r.model.visible = false;

    // drivers out of their cars and onto the steps
    this.drivers = top.map((r, i) => {
      const D = r.model.userData.driver;
      if (!D) return null;
      grp.add(D.drv);
      D.drv.position.set(STEPS[i].x, BASE + STEPS[i].h + HIP, 0.4);
      D.drv.rotation.set(0, i === 1 ? 0.35 : i === 2 ? -0.35 : 0, 0);
      D.setSeated(false);
      D.helmet.visible = D.visor.visible = true;
      return { D, i, trophy: null, bottle: null, phase: 'wave', seed: i * 1.7 };
    });

    // caption with the result, and a way to skip ahead
    const team = (r) => r.model.userData.skin?.name || '';
    document.getElementById('podiumTitle').textContent = `🏆 ${title}`;
    document.getElementById('podiumRows').innerHTML = top.map((r, i) => `<div class="${r.isPlayer ? 'me' : ''}"><b>${['🥇', '🥈', '🥉'][i]}</b> ${r.name} <span>${team(r)}</span></div>`).join('');
    this.ui = document.getElementById('podiumUi');
    this.ui.classList.remove('hidden');
    this.skipBtn = document.getElementById('podiumSkip');
    this.skipBtn.classList.remove('hidden');
    this.onSkip = () => this.finish();
    this.onKey = (e) => { if (['Enter', 'Space', 'Escape'].includes(e.code)) this.finish(); };
    this.skipBtn.addEventListener('click', this.onSkip);
    window.addEventListener('keydown', this.onKey);

    game.camera.userData.fixed = true;
    game.audio.setCrowd(0.26);
    this.events = [
      { at: T.anthem, fn: () => { this.drivers.forEach((d) => d && (d.phase = 'stand')); game.audio.anthem(); } },
      ...[2, 1, 0].flatMap((i) => [
        { at: T.trophy[i], fn: () => this.giveTrophy(i) },
        { at: T.trophy[i] + T.lift, fn: () => this.lift(i) },
      ]),
      { at: T.bottles, fn: () => this.bottles() },
      { at: T.spray, fn: () => { game.audio.champagne(T.sprayEnd - T.spray); game.confetti.celebrate('podium', ['#ffffff', '#ffd23a', '#e10600']); } },
      { at: T.end, fn: () => this.finish() },
    ];
  }

  giveTrophy(i) {
    const d = this.drivers[i];
    if (!d) return;
    d.trophy = trophy(i === 0 ? 1.35 : 1);
    d.D.drv.add(d.trophy);
    d.phase = 'hold';
    this.g.audio.cheer(i === 0 ? 0.8 : 0.4);
  }

  lift(i) {
    const d = this.drivers[i];
    if (!d) return;
    d.phase = 'lift';
    if (i === 0) {
      this.g.confetti.celebrate('champion');
      this.g.audio.cheer(1.2);
      this.g.excite?.(1.2, true);
    }
  }

  // trophies down at their feet, bottles up
  bottles() {
    this.drivers.forEach((d) => {
      if (!d) return;
      if (d.trophy) {
        this.group.attach(d.trophy);
        d.trophy.position.set(STEPS[d.i].x + 0.5, BASE + STEPS[d.i].h, 1.05);
        d.trophy.rotation.set(0, 0, 0);
      }
      d.D.drv.position.y = BASE + STEPS[d.i].h + HIP;
      d.bottle = bottle();
      d.bottle.position.set(0, -0.6, 0);
      d.D.freeArms[1].add(d.bottle);
      d.phase = 'spray';
    });
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.ui.classList.add('hidden');
    this.skipBtn.removeEventListener('click', this.onSkip);
    window.removeEventListener('keydown', this.onKey);
    // skipped: straight to the end state, quietly (trophies at their feet, bottles in hand)
    if (this.t < T.end) {
      for (const e of this.events) e.done = true;
      this.drivers.forEach((d) => { if (d && !d.trophy) { d.trophy = trophy(d.i === 0 ? 1.35 : 1); d.D.drv.add(d.trophy); } });
      if (!this.drivers.some((d) => d?.bottle)) this.bottles();
      this.t = T.end;
    }
    this.drivers.forEach((d) => d && (d.phase = 'wave'));
    this.onDone();
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    for (const e of this.events) if (!e.done && t >= e.at) { e.done = true; e.fn(); }
    const spraying = t > T.spray && t < T.sprayEnd;
    const fx = this.g.fx, R = Math.random;
    const tip = new THREE.Vector3(), sh = new THREE.Vector3();
    for (const d of this.drivers) {
      if (!d) continue;
      const [L, Rt] = d.D.freeArms;
      const w = t * 9 + d.seed;
      L.rotation.set(0, 0, -0.12);
      Rt.rotation.set(0, 0, 0.12);
      if (d.phase === 'wave') {
        Rt.rotation.z = 2.5 + Math.sin(w) * 0.4;
        if (d.trophy && d.trophy.parent !== this.group) L.rotation.z = -2.5 - Math.sin(w) * 0.3;
      } else if (d.phase === 'hold') {
        L.rotation.set(-1.15, 0, 0.3);
        Rt.rotation.set(-1.15, 0, -0.3);
        d.trophy.position.set(0, 0.2, 0.42);
      } else if (d.phase === 'lift') {
        const bob = Math.abs(Math.sin(t * 4 + d.seed)) * 0.08;
        L.rotation.z = -2.8;
        Rt.rotation.z = 2.8;
        d.trophy.position.set(0, 0.9 + bob, 0.04);
        d.D.drv.position.y = BASE + STEPS[d.i].h + HIP + bob * 0.6;
      } else if (d.phase === 'spray') {
        // bottle out in front and up, shaking; the spray follows the arm
        L.rotation.z = -0.5 - Math.sin(w) * 0.2;
        Rt.rotation.set(-2.0 + Math.sin(t * 13 + d.seed) * 0.12, 0, -0.15 + Math.sin(t * 5 + d.seed) * 0.15);
        if (spraying && d.bottle) {
          d.bottle.localToWorld(tip.set(0, 0.24, 0));
          Rt.getWorldPosition(sh);
          const dx = tip.x - sh.x, dy = tip.y - sh.y, dz = tip.z - sh.z, n = Math.hypot(dx, dy, dz) || 1;
          // sparkling droplets in the jet, a little foam mist around it
          for (let k = 0; k < 7; k++) {
            const sp = 7 + R() * 5;
            fx.glow.emit(tip.x, tip.y, tip.z, (dx / n) * sp + (R() - 0.5) * 1.4, (dy / n) * sp + 1.2 + R() * 1.4, (dz / n) * sp + (R() - 0.5) * 1.4, 0.5 + R() * 0.4, 0.07, 0.03, 1, 0.92, 0.62, 0.55, 9, 0.8);
          }
          if (R() < 0.5) fx.smoke.emit(tip.x, tip.y, tip.z, (dx / n) * 4, (dy / n) * 4 + 1, (dz / n) * 4, 0.9, 0.08, 0.5, 1, 1, 0.97, 0.45, 3, 1.6);
        }
      }
    }
    this.camera(t);
  }

  camera(t) {
    const cam = this.g.camera, grp = this.group;
    let pos, look;
    if (t >= T.end) {
      // behind the results: a slow drift back and forth across the podium
      const a = Math.sin((t - T.end) * 0.15) * 0.4 - 0.18;
      pos = [Math.sin(a) * 12, 3.0, Math.cos(a) * 12];
      look = [0, 1.8, 0];
    } else {
      let k = 0;
      while (k < CAM.length - 2 && t > CAM[k + 1][0]) k++;
      const [t0, p0, l0] = CAM[k], [t1, p1, l1] = CAM[k + 1];
      const f = smooth(clamp((t - t0) / (t1 - t0), 0, 1));
      pos = p0.map((v, j) => lerp(v, p1[j], f));
      look = l0.map((v, j) => lerp(v, l1[j], f));
    }
    cam.position.set(...pos);
    grp.localToWorld(cam.position);
    const l = grp.localToWorld(new THREE.Vector3(...look));
    cam.lookAt(l);
  }

  dispose() {
    if (!this.finished) {
      this.finished = true;
      this.skipBtn.removeEventListener('click', this.onSkip);
      window.removeEventListener('keydown', this.onKey);
    }
    this.ui.classList.add('hidden');
    this.group.removeFromParent();
    this.g.camera.userData.fixed = false;
  }
}
