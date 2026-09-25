import * as THREE from 'three';
import { textTexture } from './textures.js';

// Pit lane beside the start/finish straight (right-hand side). Positions along it are measured as `u`,
// meters from the pit entry: taper in over 0-70, working lane 70-340 (crossing the finish line at u = 300), taper out 340-410.
export const PIT = { taperIn: 70, laneOut: 340, exit: 410, limit: 22 }; // limit: 22 m/s = 79 km/h

export function pitLayout(track) {
  const L = track.length, hw = track.halfW;
  const entry = L - 300;
  return {
    side: 1,
    lat: hw + 5.5, // lane center
    entry,
    u: (d) => (((d - entry) % L) + L) % L,
    d: (u) => (entry + u) % L,
    // team k's garage box, as u; boxes run back from just before the finish line
    boxU: (k) => 300 - 34 - k * 12.5,
    // the track wall on this side is left open from just after the entry to the end of the exit taper
    wallGap: { side: 1, from: (entry + 20) % L, to: PIT.exit - 300 },
  };
}

// lateral offset of the pit lane centerline at u (smooth tapers in and out)
export function pitLat(pit, hw, u, lat0 = hw - 3) {
  const sm = (t) => t * t * (3 - 2 * t);
  if (u < PIT.taperIn) return lat0 + (pit.lat - lat0) * sm(Math.max(0, u) / PIT.taperIn);
  if (u > PIT.laneOut) return pit.lat + (hw - 3 - pit.lat) * sm(Math.min(1, (u - PIT.laneOut) / (PIT.exit - PIT.laneOut)));
  return pit.lat;
}

function ribbon(track, pit, u0, u1, latFn, width, y, mat) {
  const pos = [], idx = [];
  const s = {};
  for (let u = u0, k = 0; u <= u1 + 0.01; u += 2, k++) {
    track.sample(pit.d(u), s);
    const lc = latFn(u);
    for (const o of [-width / 2, width / 2]) {
      const lat = lc + o;
      pos.push(s.x + s.rx * lat, s.y + track.halfW * Math.sin(s.bank) + y, s.z + s.rz * lat);
    }
    if (k > 0) { const a = (k - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}

function person(bodyColor, helmetColor) {
  const g = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.7 });
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.8, 0.24), new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.8 }));
  legs.position.y = 0.4;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.62, 0.28), suit);
  torso.position.y = 1.1;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), new THREE.MeshStandardMaterial({ color: helmetColor, roughness: 0.35, metalness: 0.2 }));
  head.position.y = 1.58;
  g.add(legs, torso, head);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// Builds the lane, pit wall, garage fronts and a crew per team. Returns an object the race sim drives.
export function buildPitLane(ctx, pit, teams) {
  const { track, parent } = ctx;
  const hw = track.halfW;
  const lane = pitLat.bind(null, pit, hw);
  // the working lane and tapers, with white edge lines
  parent.add(ribbon(track, pit, 0, PIT.exit, lane, 8, 0.05, new THREE.MeshStandardMaterial({ color: 0x2c2e33, roughness: 0.85, side: THREE.DoubleSide })));
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6, side: THREE.DoubleSide });
  for (const o of [-3.8, 3.8]) parent.add(ribbon(track, pit, 0, PIT.exit, (u) => lane(u) + o, 0.25, 0.07, white));
  // speed limit lines across the lane where the limiter starts and ends
  for (const u of [PIT.taperIn, PIT.laneOut]) parent.add(ribbon(track, pit, u - 1, u + 1, lane, 8, 0.075, white));

  // ---- signs: countdown boards before the entry, gantries over the entry and exit, painted lane markings
  const sign = (text, sub, bg, w = 4, h = 2) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, map: textTexture(text + (sub ? '  ' + sub : ''), { w: 512, h: Math.round(512 * h / w), bg, fg: '#ffffff', font: `italic 900 ${Math.round(260 * h / w)}px "Arial Black", Arial` }) }));
  const onTrack = (u, lat, y, road = false) => {
    const q = track.sample(pit.d(u), {});
    return { p: new THREE.Vector3(q.x + q.rx * lat, q.y + (road ? lat : hw) * Math.sin(q.bank) + y, q.z + q.rz * lat), hd: q.hd };
  };
  const postM = new THREE.MeshStandardMaterial({ color: 0x8a93a3, metalness: 0.5, roughness: 0.4 });
  for (const [u, txt] of [[-150, 'PIT 150'], [-100, 'PIT 100'], [-50, 'PIT 50']]) {
    const { p, hd } = onTrack(u, hw + 2.2, 2.4);
    const b = sign(txt, '', '#15151e', 2.4, 1.2);
    b.position.copy(p);
    b.rotation.y = hd + Math.PI; // faces oncoming cars
    parent.add(b);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.12), postM);
    post.position.set(p.x, p.y - 1.2, p.z);
    parent.add(post);
  }
  const gantry = (u, text, bg) => {
    const { p, hd } = onTrack(u, lane(u), 0);
    const q = track.sample(pit.d(u), {});
    for (const o of [-4.6, 4.6]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6.2, 0.3), postM);
      const lat = lane(u) + o;
      post.position.set(q.x + q.rx * lat, p.y + 3.1, q.z + q.rz * lat);
      parent.add(post);
    }
    const b = sign(text, '', bg, 9.6, 1.6);
    b.position.set(p.x, p.y + 5.6, p.z);
    b.rotation.y = hd + Math.PI;
    parent.add(b);
  };
  gantry(12, 'PIT ENTRY ▶', '#e10600');
  gantry(PIT.exit - 25, 'PIT EXIT', '#15151e');
  // banners along the top of the pit wall, facing the track, so drivers see where the service area is
  for (const u of [PIT.taperIn + 40, PIT.taperIn + 160]) {
    const { p, hd } = onTrack(u, hw + 1.2, 1.9);
    const b = sign('SERVICE AREA', 'FUEL · TYRES · REPAIR', '#15151e', 14, 1.4);
    b.position.copy(p);
    b.rotation.y = hd + Math.PI / 2;
    parent.add(b);
  }
  // paint on the lane
  const paint = (u, text, w, h, color = '#ffffff') => {
    const { p, hd } = onTrack(u, lane(u), 0.085);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, map: textTexture(text, { w: 512, h: Math.round(512 * h / w), fg: color, font: `900 ${Math.round(300 * h / w)}px "Arial Black", Arial` }) }));
    m.rotation.set(-Math.PI / 2, 0, hd + Math.PI);
    m.position.copy(p);
    parent.add(m);
  };
  paint(PIT.taperIn + 20, 'PIT LANE 80', 6.5, 2.2, '#ffd23a');
  paint(PIT.laneOut - 20, 'PIT LANE 80', 6.5, 2.2, '#ffd23a');

  // ---- make it shine: neon lane edges, light beams you can see across the circuit, glowing arrows into the entry
  const neon = (k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.62, 0.15).multiplyScalar(k), side: THREE.DoubleSide, toneMapped: false });
  const edgeM = neon(2);
  for (const o of [-4.15, 4.15]) parent.add(ribbon(track, pit, 0, PIT.exit, (u) => lane(u) + o, 0.22, 0.1, edgeM));
  const beamTex = (() => {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.7, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 128);
    return new THREE.CanvasTexture(c);
  })();
  const beam = (color) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 2.2, 110, 24, 1, true).translate(0, 55, 0), new THREE.MeshBasicMaterial({ map: beamTex, color, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false }));
    m.renderOrder = 5;
    parent.add(m);
    return m;
  };
  const entryBeam = beam(0xffa030);
  entryBeam.position.copy(onTrack(6, lane(6), 0).p);
  const boxBeam = beam(0x27c7ff);
  boxBeam.visible = false;
  // chevrons painted on the track, leading from the racing line into the entry
  const arrowTex = (() => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    for (const y of [10, 58]) {
      g.beginPath();
      g.moveTo(64, y); g.lineTo(118, y + 44); g.lineTo(96, y + 58); g.lineTo(64, y + 28); g.lineTo(32, y + 58); g.lineTo(10, y + 44);
      g.closePath();
      g.fill();
    }
    return new THREE.CanvasTexture(c);
  })();
  const arrowM = new THREE.MeshBasicMaterial({ map: arrowTex, color: new THREE.Color(1, 0.62, 0.15).multiplyScalar(2.2), transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  const arrowLat = (u) => hw - 6.5 + 4.5 * Math.min(1, Math.max(0, (u + 170) / 170));
  for (let u = -168; u <= 4; u += 14) {
    const a = onTrack(u, arrowLat(u), 0.07, true), b = onTrack(u + 2, arrowLat(u + 2), 0.07, true);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), arrowM);
    m.position.copy(a.p);
    m.rotation.set(-Math.PI / 2, Math.atan2(b.p.x - a.p.x, b.p.z - a.p.z) + Math.PI, 0, 'YXZ');
    m.renderOrder = 4;
    parent.add(m);
  }

  // low concrete pit wall between the track and the lane
  const wallM = new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.8 });
  const s = {};
  for (let u = PIT.taperIn + 6; u < PIT.laneOut - 6; u += 6) {
    track.sample(pit.d(u + 3), s);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.1, 6.05), wallM);
    const lat = hw + 1.2;
    seg.position.set(s.x + s.rx * lat, s.y + hw * Math.sin(s.bank) + 0.55, s.z + s.rz * lat);
    seg.rotation.y = s.hd;
    seg.castShadow = true;
    parent.add(seg);
  }

  // garage fronts: dark opening, team stripe and name board; painted box on the lane
  const crews = [];
  const boxMats = [], boxSpots = [];
  teams.forEach((team, k) => {
    const u = pit.boxU(k);
    track.sample(pit.d(u), s);
    const face = hw + 9.05;
    const grp = new THREE.Group();
    grp.position.set(s.x + s.rx * face, s.y, s.z + s.rz * face);
    grp.rotation.y = s.hd + Math.PI / 2; // local +z faces the lane (toward the track)
    const door = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 5), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 1 }));
    door.position.set(0, 2.5, 0.02);
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 0.5), new THREE.MeshStandardMaterial({ color: team.body, emissive: team.body, emissiveIntensity: 0.25 }));
    stripe.position.set(0, 5.25, 0.03);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.3), new THREE.MeshBasicMaterial({ map: textTexture(team.name.toUpperCase(), { w: 512, h: 72, bg: '#' + team.accent.toString(16).padStart(6, '0'), fg: '#ffffff', font: 'italic 900 44px "Arial Black", Arial' }) }));
    board.position.set(0, 6.4, 0.04);
    const service = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.8), new THREE.MeshBasicMaterial({ map: textTexture('SERVICE · FUEL · TYRES · REPAIR', { w: 512, h: 46, bg: '#15151e', fg: '#ffd23a', font: '800 26px Arial' }) }));
    service.position.set(0, 7.5, 0.04);
    grp.add(door, stripe, board, service);
    parent.add(grp);
    // painted box on the lane, labelled with the team
    const hex = '#' + team.body.toString(16).padStart(6, '0');
    const boxTex = textTexture(team.name.toUpperCase(), { w: 256, h: 456, bg: hex, fg: '#ffffff', font: '900 34px Arial', stroke: 'rgba(0,0,0,0.5)' });
    const box = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 7.5), new THREE.MeshStandardMaterial({ roughness: 0.8, transparent: true, opacity: 0.8, map: boxTex, emissiveMap: boxTex, emissive: 0x000000 }));
    boxMats.push(box.material);
    boxSpots.push(box.position);
    box.rotation.set(-Math.PI / 2, 0, -s.hd);
    box.position.set(s.x + s.rx * pit.lat, s.y + hw * Math.sin(s.bank) + 0.08, s.z + s.rz * pit.lat);
    parent.add(box);

    // crew: wheel gunners, jacks, refueller and the lollipop, waiting in front of the garage
    const roles = [[-0.95, 1.75], [0.95, 1.75], [-0.95, -1.55], [0.95, -1.55], [0, 3.4], [0, -3.2], [1.4, 0.2], [-1.6, 3.8]];
    const people = roles.map(([lat, along], j) => {
      const p = person(team.body, team.trim);
      const home = spot(track, pit, u + (j - 3.5) * 1.2, hw + 8.2);
      const work = spot(track, pit, u + along, pit.lat + lat);
      p.position.copy(home);
      p.rotation.y = s.hd + Math.PI / 2;
      parent.add(p);
      return { p, home, work, face: Math.atan2(work.x - home.x, work.z - home.z) };
    });
    crews.push({ people, working: false, t: 0 });
  });

  let guideLevel = 0, guideTeam = -1;
  return {
    crews,
    setWorking(k, on) { if (crews[k]) crews[k].working = on; },
    // 0 = normal glow, 1 = the player has called (or needs) a stop: brighter, arrows on, their box lights up
    setGuide(level, team) {
      guideLevel = level;
      if (team !== guideTeam) {
        guideTeam = team;
        if (boxSpots[team]) boxBeam.position.copy(boxSpots[team]);
      }
    },
    update(dt, time) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 5);
      const L = guideLevel;
      edgeM.color.setRGB(1, 0.62, 0.15).multiplyScalar(1.4 + L * (1.2 + pulse * 1.4));
      entryBeam.material.opacity = 0.22 + L * (0.25 + pulse * 0.2);
      boxBeam.visible = L > 0 && guideTeam >= 0;
      boxBeam.material.opacity = 0.3 + pulse * 0.25;
      arrowM.opacity = L > 0 ? 0.55 + pulse * 0.45 : 0.18;
      boxMats.forEach((m, k) => { m.emissive.setScalar(k === guideTeam && L > 0 ? 0.35 + pulse * 0.65 : 0); });
      for (const c of crews) {
        c.t = Math.max(0, Math.min(1, c.t + (c.working ? dt * 3 : -dt * 2)));
        const e = c.t * c.t * (3 - 2 * c.t);
        c.people.forEach((m, j) => {
          m.p.position.lerpVectors(m.home, m.work, e);
          m.p.position.y += c.working && c.t > 0.95 ? Math.abs(Math.sin(time * 14 + j)) * 0.08 : 0;
          m.p.rotation.y = m.face + (c.t > 0.5 ? Math.PI : 0) * 0; // walk toward the car, keep facing it
        });
      }
    },
  };
}

function spot(track, pit, u, lat) {
  const s = track.sample(pit.d(u), {});
  return new THREE.Vector3(s.x + s.rx * lat, s.y + track.halfW * Math.sin(s.bank) + 0.06, s.z + s.rz * lat);
}
