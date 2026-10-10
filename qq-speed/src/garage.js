// The Garage (design/GarageShop): unlock cars and parts with tokens and fit parts to each car (paint, wheels, body
// kit, underglow), shown on the lobby's live demo car behind the screen. What's for sale is catalog.js; what the
// player has is wallet.js plus what cups and daily challenges earn (Game.has). Picking an owned car makes it the
// player's car. Looks are cosmetic: they never change how a car drives.
import { CARS, resolveLook } from './carModel.js';
import { CATEGORIES, FACTORY, carItemId, item, partsIn } from './catalog.js';
import * as wallet from './wallet.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const fmt = (n) => n.toLocaleString('en-US');
export const TOKEN = '<svg class="tok" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8.66 5v10L12 22l-8.66-5V7z"/><path d="M12 6.5l4.76 2.75v5.5L12 17.5l-4.76-2.75v-5.5z"/></svg>';
const CONFIRM_MS = 5000; // how long Unlock waits for the confirming tap before it lets go
// a Factory part's swatch is the car's own colour
const FACTORY_COLOR = { paint: (c) => c.body, wheels: (c) => c.rim, glow: (c) => c.glow };

export class Garage {
  constructor(game) {
    this.game = game;
    this.car = 0; // the car on show (CARS index)
    this.tab = CATEGORIES[0].id;
    this.sel = FACTORY[this.tab]; // the part picked in the tab, shown on the car
    this.armed = null; // the car or part waiting for a confirming tap before tokens are spent
    this.shown = false;
    this.busy = false; // waiting on the wallet
    this.dirty = false; // the player's car or a look changed since the garage opened
    this.bind();
    wallet.onChange(() => { if (this.shown) this.render(); });
  }

  get isOpen() { return !$('garage').classList.contains('hidden'); }
  get carId() { return CARS[this.car].id; }
  // the part fitted to the car on show in a slot
  fitted(slot) { return wallet.equipped(this.carId)[slot] || FACTORY[slot]; }

  bind() {
    $('gCars').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) this.pickCar(+b.dataset.i); });
    $('gTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) this.pickTab(b.dataset.tab); });
    $('gItems').addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) this.pickPart(b.dataset.id); });
    $('gCta').addEventListener('click', () => this.act());
    $('gTokens').addEventListener('click', () => this.getTokens());
    $('gBack').addEventListener('click', () => this.back());
  }

  // open on a car; back to `from` ('menu' or 'online') when done
  open(carIndex, from = 'menu') {
    this.game.audio.play('click');
    this.from = from;
    this.shown = true;
    this.dirty = false;
    $(from).classList.add('hidden');
    $('garage').classList.remove('hidden');
    this.game.focusDemoCar();
    this.show(CARS[carIndex] ? carIndex : 0);
  }

  // back arrow / Escape. Equip and Unlock take effect at once, so there's nothing to save or undo.
  back() {
    if (!this.shown) return;
    this.game.audio.play('click');
    $('garage').classList.add('hidden');
    $(this.from).classList.remove('hidden');
    this.close(true);
  }

  // the game is moving on (a race starts, the lobby reloads) and has hidden the screen itself
  cancel() { if (this.shown) this.close(false); }

  close(toLobby) {
    this.shown = false;
    this.armed = null;
    this.say('');
    if (this.dirty) this.game.onLooksChanged(toLobby);
    else if (toLobby) { const skin = this.game.settings.skin; this.game.dressDemoCar(CARS[skin], this.game.lookFor(skin)); }
    this.dirty = false;
  }

  // ---------- Picking ----------
  show(i) {
    this.car = i;
    this.sel = this.fitted(this.tab);
    this.armed = null;
    this.preview();
    // on phones the cars are a sideways strip: bring this one into view
    const list = $('gCars'), b = list.querySelector('.sel');
    if (b && list.scrollWidth > list.clientWidth) list.scrollLeft = b.offsetLeft - list.offsetLeft - (list.clientWidth - b.offsetWidth) / 2;
  }

  // an owned car becomes the player's car; a locked one is only shown
  pickCar(i) {
    if (i === this.car) return;
    this.game.audio.play('click');
    this.say('');
    if (this.game.hasCar(i)) this.useCar(i);
    this.show(i);
  }

  useCar(i) {
    if (this.game.settings.skin === i) return;
    this.game.settings.skin = i;
    this.game.save();
    this.dirty = true;
    this.game.online.sendLook();
  }

  pickTab(tab) {
    if (tab === this.tab) return;
    this.game.audio.play('click');
    this.tab = tab;
    this.sel = this.fitted(tab);
    this.armed = null;
    this.say('');
    this.preview();
  }

  pickPart(id) {
    if (id === this.sel) return;
    this.game.audio.play('click');
    this.sel = id;
    this.armed = null;
    this.say('');
    this.preview();
  }

  // the car on show with its fitted parts and the one picked in this tab
  preview() {
    this.game.dressDemoCar(CARS[this.car], { ...wallet.equipped(this.carId), [this.tab]: this.sel }, false);
    this.render();
  }

  // ---------- The main button ----------
  // what it does now: { kind: 'equip' | 'on' | 'buy' | 'confirm' | 'short', label, name, note, it }
  state() {
    const car = CARS[this.car], carIt = item(carItemId(car.id));
    if (!this.game.has(carIt.id)) return { ...this.buyState(carIt, 'Unlock car'), name: car.name };
    const it = item(this.sel);
    if (!this.game.has(it.id)) return { ...this.buyState(it, 'Unlock'), name: it.name };
    return this.fitted(this.tab) === it.id
      ? { kind: 'on', label: 'Equipped', name: it.name, note: 'On your car', it }
      : { kind: 'equip', label: 'Equip', name: it.name, note: 'Owned', it };
  }

  buyState(it, verb) {
    const bal = wallet.getBalance(), need = it.price - bal;
    if (need > 0) return { kind: 'short', label: `Get ${fmt(need)} more tokens`, note: it.category === 'car' ? `Need ${fmt(need)} more` : `Costs ${fmt(it.price)}`, it };
    const note = `Balance after: ${fmt(bal - it.price)}`;
    return this.armed === it.id ? { kind: 'confirm', label: `Spend ${fmt(it.price)} tokens?`, note, it } : { kind: 'buy', label: `${verb} · ${fmt(it.price)}`, note, it };
  }

  async act() {
    if (this.busy) return;
    const s = this.state();
    if (s.kind === 'on') return;
    if (s.kind === 'short') return this.getTokens();
    if (s.kind === 'equip') {
      this.game.audio.play('click');
      return this.equip(s.it.id);
    }
    // Unlock asks for a second tap before spending tokens
    if (s.kind === 'buy') {
      this.game.audio.play('click');
      this.armed = s.it.id;
      clearTimeout(this.armTimer);
      this.armTimer = setTimeout(() => { if (this.armed === s.it.id) { this.armed = null; this.render(); } }, CONFIRM_MS);
      return this.render();
    }
    this.busy = true;
    this.armed = null;
    this.render();
    const r = await wallet.spend(s.it.id);
    this.busy = false;
    if (!r.ok) {
      this.game.audio.play('wrong');
      this.say(r.error === 'short' ? `You need ${fmt(r.need)} more tokens for that.` : 'That could not be unlocked. Try again.');
      return this.render();
    }
    this.game.audio.play('gauge');
    if (s.it.category === 'car') {
      this.useCar(this.car);
      this.say(`${s.name} unlocked. It's your car now.`);
      this.render();
    } else {
      this.say(`${s.name} unlocked and equipped.`);
      await this.equip(s.it.id);
    }
  }

  async equip(id) {
    await wallet.equip(this.carId, { ...wallet.equipped(this.carId), [this.tab]: id });
    this.dirty = true;
    this.game.online.sendLook();
    this.preview();
  }

  // no token shop yet: say so (step 2 opens it here)
  getTokens() {
    this.game.audio.play('click');
    this.say('The token shop opens soon. Until then, spend the tokens you have.');
  }

  say(text) { $('gMsg').textContent = text; }

  // ---------- Drawing ----------
  render() {
    const g = this.game, bal = wallet.getBalance(), car = CARS[this.car];
    // the lists are redrawn: keep keyboard focus on the same button
    const f = document.activeElement, list = ['gCars', 'gTabs', 'gItems'].includes(f?.parentElement?.id) ? f.parentElement.id : null;
    const key = list && Object.entries(f.dataset)[0];
    $('gBal').textContent = fmt(bal);

    // cars: a dot in each car's paint, then In use / Owned / its price
    const owned = CARS.filter((_, i) => g.hasCar(i)).length;
    $('gCarsHead').textContent = `Cars · ${owned} / ${CARS.length} owned`;
    $('gCars').innerHTML = CARS.map((c, i) => {
      const has = g.hasCar(i), use = i === g.settings.skin;
      const tag = !has ? `<small class="price">${TOKEN}${fmt(item(carItemId(c.id)).price)}</small>` : use ? '<small class="use">In use</small>' : '<small>Owned</small>';
      return `<button type="button" class="gcar${i === this.car ? ' sel' : ''}${has ? '' : ' locked'}" data-i="${i}" aria-pressed="${i === this.car}"><i style="background:${hex(resolveLook(c, wallet.equipped(c.id)).paint)}"></i><span>${c.name}</span>${tag}</button>`;
    }).join('');

    $('gCls').textContent = car.cls;
    $('gCar').textContent = car.name;
    const carIt = item(carItemId(car.id)), carLocked = !g.has(carIt.id);
    $('gLock').classList.toggle('hidden', !carLocked);
    if (carLocked) $('gLockText').innerHTML = carIt.earn ? `Unlock with tokens, or <b>${carIt.earn.text}</b> to get it free` : 'Unlock it with tokens';

    $('gTabs').innerHTML = CATEGORIES.map((t) => `<button type="button" class="opt${t.id === this.tab ? ' sel' : ''}" data-tab="${t.id}" aria-pressed="${t.id === this.tab}">${t.name}</button>`).join('');
    const on = this.fitted(this.tab);
    $('gItems').innerHTML = partsIn(this.tab).map((p) => {
      const has = g.has(p.id);
      const price = !has ? `<small class="${p.price > bal ? 'short' : ''}">${TOKEN}${fmt(p.price)}</small>` : p.id === on ? '<small class="on">Equipped</small>' : '<small class="own">Owned</small>';
      const color = p.color ?? FACTORY_COLOR[this.tab]?.(car);
      const sw = p.swatch || (color != null ? hex(color) : '#2a2d38');
      const cls = p.rainbow ? ' rainbow' : p.id === 'glow.off' ? ' off' : '';
      return `<button type="button" class="gitem${p.id === this.sel ? ' sel' : ''}" data-id="${p.id}" aria-pressed="${p.id === this.sel}"><i class="gsw${cls}" style="--c:${sw}"></i><b>${p.name}</b>${price}</button>`;
    }).join('');

    const s = this.state(), part = item(this.sel);
    $('gHint').innerHTML = !carLocked && !g.has(part.id) && part.earn ? `Or <b>${part.earn.text}</b> to get it free.` : '';
    $('gSelName').textContent = s.name;
    $('gSelNote').textContent = s.note;
    const cta = $('gCta');
    cta.textContent = this.busy ? 'Unlocking…' : s.label;
    cta.className = 'gcta ' + s.kind;
    cta.disabled = s.kind === 'on' || this.busy;
    if (key) $(list).querySelector(`[data-${key[0]}="${key[1]}"]`)?.focus();
  }

  // where the demo car should sit on screen: the middle of the space between the panels (or under the car list)
  carFrame() {
    const r = $('gSpace').getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: innerWidth / 2 - (r.left + r.width / 2), y: innerHeight / 2 - (r.top + r.height / 2) };
  }
}
