// The Garage (design/GarageShop): unlock cars and parts with tokens and fit parts to each car (paint, wheels, body
// kit, underglow), shown on the lobby's live demo car behind the screen. What's for sale is catalog.js; what the
// player has is wallet.js plus what cups and daily challenges earn (Game.has). Picking an owned car makes it the
// player's car. Looks are cosmetic: they never change how a car drives.
import { CARS, resolveLook } from './carModel.js';
import { CATEGORIES, FACTORY, carItemId, item, partsIn } from './catalog.js';
import * as wallet from './wallet.js';
import * as card from './checkout.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const fmt = (n) => n.toLocaleString('en-US');
export const TOKEN = '<svg class="tok" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8.66 5v10L12 22l-8.66-5V7z"/><path d="M12 6.5l4.76 2.75v5.5L12 17.5l-4.76-2.75v-5.5z"/></svg>';
// what a part is, on the unlock card: "Paint for the Ferrari"
const PART_WORD = { paint: 'Paint', wheels: 'Rims', bodykit: 'A body kit', glow: 'Underglow' };
// a Factory part's swatch is the car's own colour
const FACTORY_COLOR = { paint: (c) => c.body, wheels: (c) => c.rim, glow: (c) => c.glow };

export class Garage {
  constructor(game) {
    this.game = game;
    this.car = 0; // the car on show (CARS index)
    this.tab = CATEGORIES[0].id;
    this.sel = FACTORY[this.tab]; // the part picked in the tab, shown on the car
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
    this.say('');
    if (this.dirty) this.game.onLooksChanged(toLobby);
    else if (toLobby) { const skin = this.game.settings.skin; this.game.dressDemoCar(CARS[skin], this.game.lookFor(skin)); }
    this.dirty = false;
  }

  // ---------- Picking ----------
  show(i) {
    this.car = i;
    this.sel = this.fitted(this.tab);
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
    this.say('');
    this.preview();
  }

  pickPart(id) {
    if (id === this.sel) return;
    this.game.audio.play('click');
    this.sel = id;
    this.say('');
    this.preview();
  }

  // the car on show with its fitted parts and the one picked in this tab
  preview() {
    this.game.dressDemoCar(CARS[this.car], { ...wallet.equipped(this.carId), [this.tab]: this.sel }, false);
    this.render();
  }

  // ---------- The main button ----------
  // what it does now: { kind: 'equip' | 'on' | 'buy' | 'short', label, name, note, it }
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
    return { kind: 'buy', label: `${verb} · ${fmt(it.price)}`, note: `Balance after: ${fmt(bal - it.price)}`, it };
  }

  act() {
    if (this.busy) return;
    const s = this.state();
    if (s.kind === 'on') return;
    if (s.kind === 'short') return this.getTokens(s.it);
    if (s.kind === 'equip') {
      this.game.audio.play('click');
      return this.equip(s.it.id);
    }
    this.confirmBuy(s);
  }

  // Unlock asks first, on the checkout card
  confirmBuy(s) {
    this.game.audio.play('click');
    const it = s.it, bal = wallet.getBalance(), car = CARS[this.car];
    const what = it.category === 'car' ? `A ${car.cls.toLowerCase()} for your garage. Yours to keep.` : `${PART_WORD[it.category]} for the ${car.name}. Yours to keep, for every car.`;
    card.show({
      icon: 'spend', tone: 'y', title: `Unlock ${s.name}?`, body: `${fmt(it.price)} tokens · balance ${fmt(bal)} → ${fmt(bal - it.price)}\n${what}`,
      primary: `Unlock · ${fmt(it.price)}`, secondary: 'Cancel', onPrimary: () => this.buy(s),
    });
  }

  async buy(s) {
    card.hide();
    this.busy = true;
    this.render();
    const r = await wallet.spend(s.it.id);
    this.busy = false;
    if (!r.ok) {
      if (r.error === 'session') return this.render(); // logged out elsewhere: the Log In screen takes over
      this.game.audio.play('wrong');
      this.render();
      if (r.error === 'short') return this.getTokens(s.it);
      return this.say(r.error === 'unreachable' ? 'Can\'t reach the server, so nothing was spent. Check your connection and try again.' : 'That couldn\'t be unlocked. Try again.');
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
    const r = await wallet.equip(this.carId, { ...wallet.equipped(this.carId), [this.tab]: id });
    if (!r.ok && r.error !== 'session') {
      this.say(r.error === 'unreachable' ? 'Can\'t reach the server, so the look wasn\'t saved. Try again when you\'re online.' : 'The look couldn\'t be saved. Try again.');
    }
    this.dirty = true;
    this.game.online.sendLook();
    this.preview();
  }

  // the Token Shop, remembering what the player was short for so it can come back to it
  getTokens(it = null) {
    this.game.shop.open({ from: 'garage', want: it && { id: it.id, need: it.price - wallet.getBalance(), car: this.car } });
  }

  // back from the Token Shop: the car and part the player wanted, with its unlock card up when it's now affordable
  reopen(want) {
    if (!this.shown) return this.open(want?.car ?? this.game.settings.skin, 'menu');
    $('garage').classList.remove('hidden');
    const it = want && item(want.id);
    if (it) {
      if (want.car !== this.car && CARS[want.car]) this.show(want.car);
      if (it.category !== 'car') { this.tab = it.category; this.sel = it.id; }
      this.preview();
      const s = this.state();
      if (s.kind === 'buy' && s.it.id === it.id) this.confirmBuy(s);
    } else this.render();
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
