// The Garage (design/GarageShop): unlock cars and parts with tokens and fit parts to each car (paint, skin, wheels,
// tyres, body kit, exhaust, underglow, logo, plate, steering wheel, engine), shown on the lobby's live demo car behind
// the screen. What's for sale is catalog.js; what the player has is wallet.js plus what cups and daily challenges earn
// (Game.has). Picking an owned car makes it the player's car. Cars cost more the stronger they are (carRating). Parts
// are looks, except engines, which add power in races against the computer only.
// Some parts take something the player makes: a colour (Custom Colour), a plate number, a logo picture. Those are
// drafts here until they're saved with the part (the main button says Save).
import { CARS, resolveLook, carRating, engineGains } from './carModel.js';
import { CATEGORIES, FACTORY, carItemId, item, partsIn } from './catalog.js';
import { LOOK_DATA, PLATE_MAX, DEFAULT_PLATE, cleanPlate } from './netproto.js';
import { liverySwatch, plateSwatch } from './decals.js';
import { steeringThumbs } from './cockpit.js';
import * as logos from './logos.js';
import * as wallet from './wallet.js';
import * as card from './checkout.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const TOKEN = '<svg class="tok" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8.66 5v10L12 22l-8.66-5V7z"/><path d="M12 6.5l4.76 2.75v5.5L12 17.5l-4.76-2.75v-5.5z"/></svg>';
// what a part is, on the unlock card: "Paint for the Ferrari"
const PART_WORD = {
  paint: 'Paint', livery: 'A skin', wheels: 'Rims', tyres: 'Tyres', bodykit: 'A body kit', exhaust: 'An exhaust', glow: 'Underglow',
  logo: 'Logo placement', plate: 'A number plate', steering: 'A steering wheel', engine: 'An engine',
};
// the main button when a fitted part has unsaved changes
const SAVE = { paint: 'Save colour', plate: 'Save plate', logo: 'Use this logo' };
// a Factory part's swatch is the car's own colour
const FACTORY_COLOR = { paint: (c) => c.body, wheels: (c) => c.rim, glow: (c) => c.glow };
const isLight = (c) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255) > 153;
// cars weakest first, so prices climb down the list
const BY_RATING = CARS.map((c, i) => ({ i, r: carRating(c) })).sort((a, b) => a.r - b.r);

export class Garage {
  constructor(game) {
    this.game = game;
    this.car = 0; // the car on show (CARS index)
    this.tab = CATEGORIES[0].id;
    this.sel = FACTORY[this.tab]; // the part picked in the tab, shown on the car
    this.draft = { paintHex: 0, plateText: '', logoKey: '' }; // what the player is making for the car on show
    this.shown = false;
    this.busy = false; // waiting on the wallet
    this.dirty = false; // the player's car or a look changed since the garage opened
    this.extraKey = ''; // which tab extras are drawn (so typing in the plate box isn't redrawn away)
    this.swatchUrls = new Map();
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
    // the tab extras (colour, plate number, logo) are drawn into gExtra; their events land here
    const x = $('gExtra');
    x.addEventListener('input', (e) => {
      if (e.target.id === 'gColor') { this.draft.paintHex = parseInt(e.target.value.slice(1), 16); this.later(); }
      if (e.target.id === 'gPlate') { this.draft.plateText = e.target.value; this.later(); }
    });
    x.addEventListener('click', (e) => { if (e.target.closest('#gLogoBtn')) this.pickLogo(); });
    x.addEventListener('change', (e) => { if (e.target.id === 'gLogoFile') this.loadLogo(e.target); });
    x.addEventListener('keydown', (e) => { if (e.target.id === 'gPlate' && e.key === 'Enter') { e.preventDefault(); this.act(); } });
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

  // back arrow / Escape. Equip and Unlock take effect at once; unsaved drafts (colour, plate, logo) are dropped.
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
    cancelAnimationFrame(this.raf);
    if (this.dirty) this.game.onLooksChanged(toLobby);
    else if (toLobby) { const skin = this.game.settings.skin; this.game.dressDemoCar(CARS[skin], this.game.lookFor(skin)); }
    this.dirty = false;
  }

  // ---------- Picking ----------
  show(i) {
    this.car = i;
    this.sel = this.fitted(this.tab);
    const eq = wallet.equipped(this.carId);
    this.draft = { paintHex: eq.paintHex ?? CARS[i].body, plateText: eq.plateText || '', logoKey: eq.logoKey || this.lastLogo() };
    this.extraKey = '';
    this.preview();
    // on phones the cars are a sideways strip: bring this one into view
    const list = $('gCars'), b = list.querySelector('.sel');
    if (b && list.scrollWidth > list.clientWidth) list.scrollLeft = b.offsetLeft - list.offsetLeft - (list.clientWidth - b.offsetWidth) / 2;
  }

  // the logo the player made last (on any car), offered for the next one
  lastLogo() {
    for (const c of CARS) { const k = wallet.equipped(c.id).logoKey; if (k) return k; }
    return wallet.logos()[0] || logos.latestLocal() || '';
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

  // the look on show: what's fitted, the part picked in this tab, and what the player is making for it
  look(id = this.sel) {
    const l = { ...wallet.equipped(this.carId), [this.tab]: id };
    for (const k of LOOK_DATA) delete l[k];
    if (item(l.paint)?.custom) l.paintHex = this.draft.paintHex;
    if (l.plate) l.plateText = cleanPlate(this.draft.plateText);
    if (l.logo && this.draft.logoKey) l.logoKey = this.draft.logoKey;
    return l;
  }

  // the car on show with its fitted parts and the one picked in this tab
  preview() {
    this.game.dressDemoCar(CARS[this.car], this.look(), false);
    this.render();
  }

  // a colour or plate being typed: the car follows once per frame at most
  later() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.preview());
  }

  // does the fitted part in this tab have changes that aren't saved (a new colour, plate number or logo)?
  pendingData() {
    const eq = wallet.equipped(this.carId), id = this.sel;
    if (this.fitted(this.tab) !== id) return false;
    if (this.tab === 'paint' && item(id)?.custom) return this.draft.paintHex !== (eq.paintHex ?? CARS[this.car].body);
    if (this.tab === 'plate' && id !== FACTORY.plate) return cleanPlate(this.draft.plateText) !== (eq.plateText || '');
    if (this.tab === 'logo' && id !== FACTORY.logo) return !!this.draft.logoKey && this.draft.logoKey !== eq.logoKey;
    return false;
  }

  // ---------- The main button ----------
  // what it does now: { kind: 'equip' | 'on' | 'buy' | 'short' | 'upload', label, name, note, it }
  state() {
    const car = CARS[this.car], carIt = item(carItemId(car.id));
    if (!this.game.has(carIt.id)) return { ...this.buyState(carIt, 'Unlock car'), name: car.name };
    const it = item(this.sel);
    if (!this.game.has(it.id)) return { ...this.buyState(it, 'Unlock'), name: it.name };
    if (this.tab === 'logo' && it.id !== FACTORY.logo && !this.draft.logoKey) return { kind: 'upload', label: 'Upload your logo', name: it.name, note: 'Owned', it };
    if (this.tab === 'plate' && this.draft.plateText.trim() && !cleanPlate(this.draft.plateText)) return { kind: 'on', label: 'Pick another number', name: it.name, note: 'Not allowed', it };
    if (this.pendingData()) return { kind: 'equip', label: SAVE[this.tab], name: it.name, note: 'Not saved yet', it };
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
    if (s.kind === 'upload') return this.pickLogo();
    if (s.kind === 'equip') {
      this.game.audio.play('click');
      return this.equip(s.it.id, s.label === SAVE[this.tab]);
    }
    this.confirmBuy(s);
  }

  // Unlock asks first, on the checkout card
  confirmBuy(s) {
    this.game.audio.play('click');
    const it = s.it, bal = wallet.getBalance(), car = CARS[this.car];
    const what = it.category === 'car' ? `A ${car.cls.toLowerCase()} for your garage, rating ${carRating(car)}. Yours to keep.`
      : it.category === 'engine' ? `${PART_WORD.engine} for the ${car.name}. Yours to keep, for every car. It adds power in races against the computer.`
        : `${PART_WORD[it.category]} for the ${car.name}. Yours to keep, for every car.`;
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
    } else if (s.it.category === 'logo' && !this.draft.logoKey) {
      this.say(`${s.name} unlocked. Now upload your logo.`);
      this.render();
    } else {
      this.say(`${s.name} unlocked and equipped.`);
      await this.equip(s.it.id);
    }
  }

  // saving: the player pressed Save (a colour, plate or logo), so say it was saved
  async equip(id, saving = false) {
    const look = this.look(id);
    // a logo goes up to the account first, so other players can load it
    if (look.logoKey) {
      this.busy = true;
      this.render();
      const up = await wallet.uploadLogo(look.logoKey, logos.localData(look.logoKey));
      this.busy = false;
      if (!up.ok && up.error !== 'session') {
        this.render();
        return this.say(up.error === 'unreachable' ? 'Can\'t reach the server, so the logo wasn\'t saved. Try again when you\'re online.'
          : up.error === 'missing' ? 'That logo isn\'t on this device any more. Upload it again.' : 'The logo couldn\'t be saved. Try another picture.');
      }
    }
    const r = await wallet.equip(this.carId, look);
    if (!r.ok && r.error !== 'session') {
      this.say(r.error === 'unreachable' ? 'Can\'t reach the server, so the look wasn\'t saved. Try again when you\'re online.'
        : r.error === 'bad_plate' ? 'That plate number isn\'t allowed. Try another.' : 'The look couldn\'t be saved. Try again.');
    } else if (r.ok && saving) this.say(this.tab === 'plate' ? 'Plate saved.' : this.tab === 'logo' ? 'Logo saved.' : 'Colour saved.');
    this.dirty = true;
    this.game.online.sendLook();
    this.preview();
  }

  // ---------- Logos ----------
  pickLogo() {
    if (this.busy) return;
    this.game.audio.play('click');
    $('gLogoFile')?.click();
  }

  async loadLogo(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.say('Preparing your logo…');
    try {
      const l = await logos.prepareLogo(file);
      logos.keepLocal(l.key, l.url);
      this.draft.logoKey = l.key;
      this.extraKey = '';
      this.say(this.fitted('logo') === this.sel && this.sel !== FACTORY.logo ? 'Looks good? Press "Use this logo" to save it.' : '');
      this.preview();
    } catch (e) {
      this.game.audio.play('wrong');
      this.say(e?.message === 'size' ? 'That picture is too big. Try a smaller one.' : 'That file isn\'t a picture we can use. Try a PNG, JPG or WebP.');
    }
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
  // the preview square for a part
  swatch(p, car) {
    const L = resolveLook(car, this.look());
    const cached = (key, make) => {
      let u = this.swatchUrls.get(key);
      if (!u) { if (this.swatchUrls.size > 60) this.swatchUrls.clear(); this.swatchUrls.set(key, (u = make())); }
      return u;
    };
    if (p.category === 'livery' && p.livery) return { css: `url(${liverySwatch(p.livery, L.paint, isLight(L.paint))}) center/cover no-repeat` };
    if (p.category === 'plate' && p.plate) {
      const t = cleanPlate(this.draft.plateText) || DEFAULT_PLATE;
      return { css: `url(${cached(`plate:${p.plate}:${t}`, () => plateSwatch(p.plate, t))}) center/88% auto no-repeat, #2a2d38` };
    }
    if (p.category === 'steering') {
      let t = null;
      try { t = steeringThumbs(partsIn('steering').map((s) => s.wheel)); } catch { /* previews are optional */ }
      return { css: t?.[p.wheel] ? `url(${t[p.wheel]}) center/contain no-repeat, #15161b` : '#15161b' };
    }
    if (p.category === 'logo' && p.decal) {
      const u = logos.logoUrl(this.draft.logoKey);
      return { css: u ? `url(${u}) center/contain no-repeat, #2a2d38` : '#2a2d38', label: p.decal.map((d) => (d === 'hood' ? 'Hood' : 'Doors')).join(' + ') };
    }
    if (p.category === 'engine' && p.engine) {
      const g = engineGains(car, { ...this.look(), engine: p.id });
      return { css: 'linear-gradient(135deg,#2a2d38,#15161b)', label: `+${g.rating[1] - g.rating[0]} rating` };
    }
    if (p.custom) return { css: `${p.swatch}`, label: this.sel === p.id || this.fitted('paint') === p.id ? '' : 'Any colour' };
    const color = p.color ?? FACTORY_COLOR[this.tab]?.(car);
    return { css: p.swatch || (color != null ? hex(color) : '#2a2d38') };
  }

  render() {
    const g = this.game, bal = wallet.getBalance(), car = CARS[this.car];
    // the lists are redrawn: keep keyboard focus on the same button
    const f = document.activeElement, list = ['gCars', 'gTabs', 'gItems'].includes(f?.parentElement?.id) ? f.parentElement.id : null;
    const key = list && Object.entries(f.dataset)[0];
    $('gBal').textContent = fmt(bal);

    // cars, weakest first: a dot in each car's paint, its rating, then In use / Owned / its price
    const owned = CARS.filter((_, i) => g.hasCar(i)).length;
    $('gCarsHead').textContent = `Cars · ${owned} / ${CARS.length} owned`;
    $('gCars').innerHTML = BY_RATING.map(({ i, r }) => {
      const c = CARS[i], has = g.hasCar(i), use = i === g.settings.skin;
      const tag = !has ? `<small class="price">${TOKEN}${fmt(item(carItemId(c.id)).price)}</small>` : use ? '<small class="use">In use</small>' : '<small>Owned</small>';
      return `<button type="button" class="gcar${i === this.car ? ' sel' : ''}${has ? '' : ' locked'}" data-i="${i}" aria-pressed="${i === this.car}"><i style="background:${hex(resolveLook(c, wallet.equipped(c.id)).paint)}"></i><span>${c.name}</span><em class="grate" title="Rating">${r}</em>${tag}</button>`;
    }).join('');

    const look = this.look(), rating = carRating(car), withEngine = carRating(car, look);
    $('gCls').textContent = `${car.cls} · Rating ${withEngine}${withEngine !== rating ? ` (${rating} stock)` : ''}`;
    $('gCar').textContent = car.name;
    const carIt = item(carItemId(car.id)), carLocked = !g.has(carIt.id);
    $('gLock').classList.toggle('hidden', !carLocked);
    if (carLocked) $('gLockText').innerHTML = carIt.earn ? `Unlock with tokens, or <b>${carIt.earn.text}</b> to get it free` : 'Unlock it with tokens';

    $('gTabs').innerHTML = CATEGORIES.map((t) => `<button type="button" class="opt${t.id === this.tab ? ' sel' : ''}" data-tab="${t.id}" aria-pressed="${t.id === this.tab}">${t.name}</button>`).join('');
    const on = this.fitted(this.tab);
    $('gItems').innerHTML = partsIn(this.tab).map((p) => {
      const has = g.has(p.id);
      const price = !has ? `<small class="${p.price > bal ? 'short' : ''}">${TOKEN}${fmt(p.price)}</small>` : p.id === on ? '<small class="on">Equipped</small>' : '<small class="own">Owned</small>';
      const sw = this.swatch(p, car);
      const cls = p.rainbow ? ' rainbow' : ['glow.off', 'livery.none', 'logo.none', 'plate.none'].includes(p.id) ? ' off' : '';
      return `<button type="button" class="gitem${p.id === this.sel ? ' sel' : ''}" data-id="${p.id}" aria-pressed="${p.id === this.sel}"><i class="gsw${cls}" style="--c:${sw.css}">${sw.label ? `<em>${sw.label}</em>` : ''}</i><b>${p.name}</b>${price}</button>`;
    }).join('');
    this.renderExtra(car, look);

    const s = this.state(), part = item(this.sel);
    $('gHint').innerHTML = !carLocked && !g.has(part.id) && part.earn ? `Or <b>${part.earn.text}</b> to get it free.` : '';
    $('gSelName').textContent = s.name;
    $('gSelNote').textContent = s.note;
    const cta = $('gCta');
    cta.textContent = this.busy ? 'Saving…' : s.label;
    cta.className = 'gcta ' + (s.kind === 'upload' ? 'equip' : s.kind);
    cta.disabled = s.kind === 'on' || this.busy;
    if (key) $(list).querySelector(`[data-${key[0]}="${key[1]}"]`)?.focus();
  }

  // under the parts: what the picked part needs from the player, or what it does
  renderExtra(car, look) {
    const x = $('gExtra'), p = item(this.sel), has = this.game.has(p.id);
    const k = `${this.car}|${this.tab}|${p.id}|${has}|${this.draft.logoKey}`;
    if (k !== this.extraKey) {
      this.extraKey = k;
      x.innerHTML = this.extraHtml(car, p, has);
    }
    // the parts of the extras that change while the player types
    if (this.tab === 'plate') {
      const bad = this.draft.plateText.trim() && !cleanPlate(this.draft.plateText);
      const n = $('gPlateNote');
      if (n) { n.textContent = bad ? 'That number isn\'t allowed. Try another.' : `Up to ${PLATE_MAX} letters, numbers and spaces.`; n.classList.toggle('bad', !!bad); }
    }
    if (this.tab === 'engine' && p.engine) {
      const gn = engineGains(car, look);
      $('gEngine').innerHTML = [['Top speed', gn.top, ' km/h'], ['With nitro', gn.nitro, ' km/h'], ['0-100 km/h', gn.launch.map((t) => t.toFixed(1)), 's'], ['Rating', gn.rating, '']]
        .map(([n, [a, b], u]) => `<div><span>${n}</span><b>${a}${u} → <ins>${b}${u}</ins></b></div>`).join('');
    }
    $('gFair').classList.toggle('hidden', this.tab === 'engine');
  }

  extraHtml(car, p, has) {
    if (this.tab === 'paint' && p.custom) {
      return `<label class="gfield"><span>Your colour</span><input id="gColor" type="color" value="${hex(this.draft.paintHex)}"></label>`;
    }
    if (this.tab === 'plate' && p.plate) {
      return `<label class="gfield"><span>Plate number</span><input id="gPlate" type="text" maxlength="${PLATE_MAX}" autocomplete="off" spellcheck="false" placeholder="${DEFAULT_PLATE}" value="${esc(this.draft.plateText)}"></label><p class="gnote" id="gPlateNote"></p>`;
    }
    if (this.tab === 'logo' && p.decal) {
      const u = logos.logoUrl(this.draft.logoKey);
      const who = wallet.isAccount() ? 'Other players see it in online races.' : 'Log in so other players see it too: a guest\'s logo shows only on this device.';
      return `<div class="glogo">${u ? `<img src="${esc(u)}" alt="Your logo">` : '<i aria-hidden="true">?</i>'}<div><button type="button" class="gsmall" id="gLogoBtn">${u ? 'Change logo' : 'Upload logo'}</button>
        <p class="gnote">PNG, JPG or WebP, shrunk to a ${logos.LOGO_SIZE}px square. ${who} Only upload pictures you have the right to use.</p></div>
        <input id="gLogoFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></div>`;
    }
    if (this.tab === 'engine') {
      return p.engine ? `<div class="gengine" id="gEngine"></div><p class="gnote">Counts in solo races, Tournament and daily challenges. Online races, leagues and cash races run every car on its stock engine.</p>`
        : '<p class="gnote">Engines add power in races against the computer. Online races, leagues and cash races run every car on its stock engine.</p>';
    }
    if (this.tab === 'steering') return `<p class="gnote">You see your steering wheel in the cockpit camera (press C in a race, or tap the camera button).</p>`;
    if (this.tab === 'tyres' && p.tyre?.smoke) return '<p class="gnote">Coloured drift smoke: everyone in the race sees it.</p>';
    if (this.tab === 'exhaust' && p.exhaust) return '<p class="gnote">Your nitro burns in this exhaust\'s colour.</p>';
    return '';
  }

  // where the demo car should sit on screen: the middle of the space between the panels (or under the car list)
  carFrame() {
    const r = $('gSpace').getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: innerWidth / 2 - (r.left + r.width / 2), y: innerHeight / 2 - (r.top + r.height / 2) };
  }
}
