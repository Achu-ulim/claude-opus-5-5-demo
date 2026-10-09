// The garage: paint, rims, underglow, a racing stripe and a race number for each car (finish, accent, rim style,
// tyres and calipers under "More options"), shown on the lobby's live demo car behind the screen.
// Looks are saved per car (settings.looks[car id]) and never change how a car drives.
import { CARS, defaultLook, resolveLook, GLOW_OFF, NEON_RIM } from './carModel.js';
import { RIMS } from './carGeometry.js';
import { cleanLook } from './netproto.js';
import { LOCKED_FINISHES } from './league.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const SLASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19L19 5"/></svg>';
const NOTE = '<b>Locked finishes</b> unlock from daily challenges and cup wins. Your look shows in online races too.';

// swatch rows: [look fields, name, unlock id]; each row starts with the car's own colour (see rows())
const PAINTS = [
  [{ paint: 0xff3b3b }, 'Rosso'], [{ paint: 0xffd23a }, 'Bolt Yellow'], [{ paint: 0xd7dae5 }, 'Ice'], [{ paint: 0x2b3a8c }, 'Midnight'],
  [{ paint: 0xb6ff3b }, 'Lime'], [{ paint: 0xb48cff }, 'Violet'], [{ paint: 0xc0c6d6, finish: 'chrome' }, 'Chrome', 'chrome'], [{ paint: 0xe0b23a, finish: 'metallic' }, 'Gold', 'gold'],
];
const RIM_COLORS = [[{ rimColor: 0x3a3d52 }, 'Gunmetal'], [{ rimColor: 0xc9cbdb }, 'Silver'], [{ rimColor: 0x15161f }, 'Black'], [{ rimColor: 0xb07a3a }, 'Bronze'], [{ rimColor: NEON_RIM }, 'Neon', 'neon']];
const GLOWS = [[{ glow: GLOW_OFF }, 'Off'], [{ glow: 0x36e2ff }, 'Cyan'], [{ glow: 0xff3da6 }, 'Pink'], [{ glow: 0xffd23a }, 'Yellow'], [{ glow: 0x7cff6b }, 'Green', 'green']];
const ACCENTS = [0x151515, 0xeceff2, 0xd40000, 0xffd000, 0xff6a00, 0x1e88e5, 0x00c853, 0xc0c4ca].map((c) => [{ accent: c }, hex(c)]);
const CALIPERS = [0xe53935, 0xffcc00, 0x1e88e5, 0x43a047, 0xff6a00, 0x1b1b1b, 0xc0c4ca, 0x8e24aa].map((c) => [{ caliper: c }, hex(c)]);
const FINISHES = [['gloss', 'Gloss'], ['metallic', 'Metallic'], ['matte', 'Matte'], ['pearl', 'Pearl'], ['chrome', 'Chrome', 'chrome']];
const TYRES = [['street', 'Street'], ['redline', 'Red Line'], ['whitewall', 'White Wall'], ['letters', 'Lettered']];
// the swatch rows on the panel: element id, rows, the label that names the current choice, and a colour picker
const SWATCHES = [['gPaint', 'paint', 'gPaintName', true], ['gRimColor', 'rimColor', 'gRimName'], ['gGlow', 'glow', 'gGlowName'], ['gAccent', 'accent', null, true], ['gCaliper', 'caliper']];

export class Garage {
  constructor(game) {
    this.game = game;
    this.car = null;
    this.editing = false;
    this.bind();
  }

  get looks() { return (this.game.settings.looks ||= {}); }
  get isOpen() { return !$('garage').classList.contains('hidden'); }
  unlocked(id) { return !id || this.game.league.unlocked(id); }

  // each row with the car's factory colour first
  rows(field) {
    const def = defaultLook(this.car);
    const list = { paint: PAINTS, rimColor: RIM_COLORS, glow: GLOWS, accent: ACCENTS, caliper: CALIPERS }[field];
    return list.some(([f]) => f[field] === def[field] && Object.keys(f).length === 1) ? list : [[{ [field]: def[field] }, 'Factory'], ...list];
  }

  bind() {
    for (const [id, field] of SWATCHES) {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('.gsw[data-i]');
        if (b) this.pick(this.rows(field)[+b.dataset.i]);
      });
      // the rainbow swatch opens the system colour picker
      $(id).addEventListener('input', (e) => { if (e.target.type === 'color') this.set({ [field]: parseInt(e.target.value.slice(1), 16) }, true); });
    }
    const opts = (id, field, list) => $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) this.pick([{ [field]: b.dataset.v }, b.textContent, list().find(([v]) => v === b.dataset.v)?.[2]]);
    });
    opts('gFinish', 'finish', () => FINISHES);
    opts('gRim', 'rim', () => RIMS.map((r) => [r.id, r.name]));
    opts('gTyre', 'tyre', () => TYRES);
    $('gStripes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (b) this.set({ stripes: b.dataset.v === 'center' });
    });
    $('gNum').addEventListener('input', (e) => {
      const v = e.target.value.replace(/\D/g, '').slice(0, 2);
      e.target.value = v;
      this.set({ number: v === '' ? null : +v }, true);
    });
    $('gDone').addEventListener('click', () => this.save());
    $('gBack').addEventListener('click', () => this.back());
    $('gRandom').addEventListener('click', () => this.randomize());
    $('gReset').addEventListener('click', () => {
      this.game.audio.play('click');
      delete this.looks[this.car.id];
      this.changed();
    });
  }

  // open on a car; back to `from` ('menu' or 'online') when done
  open(carIndex, from = 'menu') {
    this.game.audio.play('click');
    this.car = CARS[carIndex] || CARS[0];
    this.from = from;
    this.saved = this.looks[this.car.id];
    this.editing = true;
    $(from).classList.add('hidden');
    $('garage').classList.remove('hidden');
    $('gCls').textContent = this.car.cls;
    $('gCar').textContent = this.car.name;
    $('gNote').innerHTML = NOTE;
    this.game.focusDemoCar();
    this.changed();
  }

  // Save look: keep it, tell the lobby, the car pictures and the online room
  save() {
    if (!this.editing) return;
    this.editing = false;
    this.game.save();
    this.leave();
    this.game.onLooksChanged();
  }

  // back arrow / Escape: drop what changed since the garage opened
  back() {
    if (!this.editing) return;
    this.cancel();
    this.leave();
    const skin = this.game.settings.skin;
    this.game.dressDemoCar(CARS[skin], this.game.lookFor(skin));
  }

  // the game is moving on (a race starts, the lobby reloads): forget unsaved changes, no screen change
  cancel() {
    if (!this.editing) return;
    this.editing = false;
    if (this.saved) this.looks[this.car.id] = this.saved; else delete this.looks[this.car.id];
  }

  leave() {
    this.game.audio.play('click');
    $('garage').classList.add('hidden');
    $(this.from).classList.remove('hidden');
  }

  // a swatch or option: [fields, name, unlock id]
  pick([fields, name, lock]) {
    if (!this.unlocked(lock)) {
      this.game.audio.play('click');
      $('gNote').innerHTML = `<b>${name}</b> is locked. ${LOCKED_FINISHES[lock]}.`;
      return;
    }
    const f = { ...fields };
    // Chrome is a paint and a finish together: another paint goes back to gloss
    if ('paint' in f && !f.finish && resolveLook(this.car, this.looks[this.car.id]).finish === 'chrome') f.finish = 'gloss';
    this.set(f);
  }

  set(fields, quiet = false) {
    if (!quiet) this.game.audio.play('click');
    const next = { ...cleanLook(this.looks[this.car.id]), ...fields };
    // only what differs from the factory look is stored
    const def = defaultLook(this.car);
    for (const k of Object.keys(next)) if (next[k] === def[k] || next[k] == null) delete next[k];
    if (Object.keys(next).length) this.looks[this.car.id] = next; else delete this.looks[this.car.id];
    this.changed();
  }

  // random unlocked paint, rims, underglow and stripe
  randomize() {
    const any = (rows) => {
      const ok = rows.filter(([, , lock]) => this.unlocked(lock));
      return ok[Math.floor(Math.random() * ok.length)][0];
    };
    const paint = any(this.rows('paint'));
    this.set({ finish: 'gloss', ...paint, ...any(this.rows('rimColor')), ...any(this.rows('glow')), stripes: Math.random() < 0.5 });
  }

  changed() {
    const L = resolveLook(this.car, this.looks[this.car.id]);
    this.render(L);
    this.game.dressDemoCar(this.car, cleanLook(this.looks[this.car.id]));
  }

  render(L) {
    for (const [id, field, nameId, picker] of SWATCHES) {
      const rows = this.rows(field);
      // a swatch is chosen when all its fields match (Chrome needs the chrome finish too)
      const sel = rows.findIndex(([f]) => Object.entries(f).every(([k, v]) => L[k] === v));
      $(id).innerHTML = rows.map(([f, name, lock], i) => {
        const locked = !this.unlocked(lock), off = field === 'glow' && f.glow === GLOW_OFF;
        return `<button type="button" class="gsw${i === sel ? ' sel' : ''}${locked ? ' locked' : ''}${off ? ' off' : ''}" data-i="${i}" style="--c:${hex(f[field])}"
          aria-pressed="${i === sel}" aria-label="${name}${locked ? ' (locked)' : ''}" title="${locked ? `${name}: ${LOCKED_FINISHES[lock]}` : name}">${locked ? LOCK : off ? SLASH : ''}</button>`;
      }).join('') + (picker ? `<label class="gsw pick${sel < 0 ? ' sel' : ''}" title="Any colour"><input type="color" value="${hex(L[field])}" aria-label="Pick any colour"></label>` : '');
      if (nameId) $(nameId).textContent = sel >= 0 ? rows[sel][1] : 'Custom';
    }
    const opts = (id, list, cur) => {
      $(id).innerHTML = list.map(([v, name, lock]) => {
        const locked = !this.unlocked(lock);
        return `<button type="button" class="${v === cur ? 'sel' : ''}${locked ? ' locked' : ''}" data-v="${v}" aria-pressed="${v === cur}"${locked ? ` title="${LOCKED_FINISHES[lock]}"` : ''}>${name}</button>`;
      }).join('');
    };
    opts('gFinish', FINISHES, L.finish);
    opts('gRim', RIMS.map((r) => [r.id, r.name]), L.rim);
    opts('gTyre', TYRES, L.tyre);
    $('gStripes').innerHTML = [['none', 'None'], ['center', 'Center']].map(([v, name]) =>
      `<button type="button" class="opt${(v === 'center') === L.stripes ? ' sel' : ''}" data-v="${v}" aria-pressed="${(v === 'center') === L.stripes}">${name}</button>`).join('');
    if (document.activeElement !== $('gNum')) $('gNum').value = L.number ?? '';
  }

  // where the demo car should sit on screen: the middle of the empty space beside (or above) the panel
  carFrame() {
    const r = $('gSpace').getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: innerWidth / 2 - (r.left + r.width / 2), y: innerHeight / 2 - (r.top + r.height / 2) };
  }
}
