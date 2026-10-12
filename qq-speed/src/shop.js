// The Token Shop (design/TokenShop): token packs bought with Paystack, the one-time Starter Pack and an order summary.
// The server prices every pack (catalog.js) and adds tokens only once Paystack itself confirms a payment (its webhook,
// or a status check); this screen opens Paystack's popup with the server's access code and then waits to hear back.
// The popup's own "success" is never taken as payment.
// In Lagos Life's frame (vatar.js) packs are paid on the world's own pay sheet instead, and Paystack never loads: each
// pack is a Vatar product with the same id and price, and the server checks the purchase with Vatar before adding tokens.
import { PACKS, STARTER_PACK, REWARDS, packById, naira, item } from './catalog.js';
import * as wallet from './wallet.js';
import * as card from './checkout.js';
import * as vatar from './vatar.js';
import { TOKEN } from './garage.js';
import { loadPaystack } from './paystack.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONFIRM_EVERY = 2000, CONFIRM_FOR = 60_000; // after Paystack's popup says done: ask the server this often, this long
export const SUPPORT = 'support@driftbolt.online';
const priced = (p) => Number.isInteger(p?.price_kobo) && p.price_kobo > 0;
const INIT_ERRORS = {
  payments_off: 'Buying tokens isn\'t open yet. Earn them free in the meantime.',
  not_for_sale: 'That pack isn\'t on sale yet.',
  starter_used: 'The Starter Pack is only for a first purchase.',
  paystack: 'Paystack didn\'t answer. Try again in a moment.',
  slow_down: 'Too many tries. Wait a few minutes, then try again.',
  unreachable: 'Can\'t reach the server. Check your connection and try again.',
};
// what Lagos Life's pay sheet can answer instead of a purchase (cancelled just closes the card)
const VATAR_ERRORS = {
  payment_failed: 'The payment didn\'t go through. Try again, or pick another way to pay.',
  not_for_sale: 'That pack isn\'t on sale in Lagos Life yet.',
  owned: 'You already have the Starter Pack: it\'s one per player.',
  busy: 'A pay sheet is already open. Finish or close it first.',
  rate_limited: 'Too many tries. Wait a few seconds, then try again.',
  off: 'Buying is switched off in Lagos Life right now.',
  signed_out: 'Sign in to Lagos Life to buy tokens.',
  timeout: 'Lagos Life didn\'t answer. Try again in a moment.',
  error: 'Something went wrong on Lagos Life\'s side. Try again in a moment.',
};

export class Shop {
  constructor(game) {
    this.game = game;
    this.pack = PACKS[1].id;
    this.shown = false;
    this.busy = false;
    $('shopBack').addEventListener('click', () => this.close());
    $('shopPacks').addEventListener('click', (e) => { const b = e.target.closest('[data-pack]'); if (b) this.pick(b.dataset.pack); });
    $('shopStarter').addEventListener('click', () => this.pick(STARTER_PACK.id));
    $('shopPay').addEventListener('click', () => this.pay());
    wallet.onChange(() => { if (this.shown) this.render(); });
  }

  get isOpen() { return !$('shop').classList.contains('hidden'); }

  // from: the screen to go back to; want: { id, need, car, tab } the item the player was short for, to return to after
  open({ from = 'menu', want = null } = {}) {
    this.game.audio.play('click');
    this.from = from;
    this.want = want;
    this.shown = true;
    for (const id of ['menu', 'garage', 'wallet', 'online']) $(id).classList.add('hidden');
    $('shop').classList.remove('hidden');
    if (this.starterLeft() && this.pack !== STARTER_PACK.id && !want) this.pack = PACKS[1].id;
    if (!vatar.active()) loadPaystack().catch(() => { /* tried again on Pay */ });
    wallet.refresh();
    this.render();
    if (!wallet.isAccount()) this.guestCard();
  }

  close(to = this.from) {
    if (!this.shown) return;
    this.game.audio.play('click');
    this.shown = false;
    card.hide();
    $('shop').classList.add('hidden');
    if (to === 'garage') this.game.garage.reopen(this.want);
    else if (to === 'wallet') this.game.walletScreen.open('menu');
    else $(to).classList.remove('hidden');
  }

  // the game moved on (a race started) and hid the screen
  cancel() { this.shown = false; card.hide(); }

  pick(id) {
    if (id === this.pack || !packById(id)) return;
    this.game.audio.play('click');
    this.pack = id;
    this.render();
  }

  starterLeft() { return !wallet.info()?.starterUsed; }

  render() {
    const bal = wallet.getBalance(), pack = packById(this.pack), w = this.want && item(this.want.id);
    $('shopBal').textContent = fmt(bal);
    $('shopNeed').textContent = w ? `You need ${fmt(Math.max(0, w.price - bal))} more for ${w.name}` : 'Tokens unlock cars and looks in the Garage';
    $('shopStarterBox').classList.toggle('hidden', !this.starterLeft());
    $('shopStarterBox').classList.toggle('sel', this.pack === STARTER_PACK.id);
    $('shopStarterTxt').textContent = `${fmt(STARTER_PACK.tokens)} tokens + ${STARTER_PACK.grants.map((g) => item(g).name).join(', ')} paint. Only for your first purchase.`;
    $('shopStarter').textContent = priced(STARTER_PACK) ? naira(STARTER_PACK.price_kobo) : 'Price soon';
    $('shopPacks').innerHTML = PACKS.map((p, i) => `<button type="button" class="spack${p.id === this.pack ? ' sel' : ''}" data-pack="${p.id}" aria-pressed="${p.id === this.pack}">
      <span class="sbadge${p.badge ? '' : ' none'}">${p.badge || '·'}</span>${TOKEN.replace('class="tok"', `class="tok" style="width:${26 + i * 6}px;height:${26 + i * 6}px"`)}
      <b>${fmt(p.tokens)}</b><span class="sbonus">${p.bonus || ''}</span><span class="sprice">${priced(p) ? naira(p.price_kobo) : 'Price soon'}</span></button>`).join('');
    $('shopEarn').innerHTML = [
      ['Daily challenges', `${REWARDS.challenge.easy}–${REWARDS.challenge.hard} each`],
      ['Cup and championship wins', `up to ${Math.max(...Object.values(REWARDS.cup), REWARDS.f1)}`],
      ['7-day streak bonus', REWARDS.streak],
    ].map(([k, v]) => `<span>${k} · <b>${v}</b></span>`).join('');
    // the order
    const sum = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
    $('shopOrderTokens').textContent = `${fmt(pack.tokens)} tokens`;
    const mail = this.game.account?.session?.email, lagos = vatar.active();
    $('shopOrder').innerHTML = sum('Pack', pack.name) + sum('Balance after', fmt(bal + pack.tokens))
      + (wallet.isAccount() ? (lagos ? sum('Paid with', 'Lagos Life') : sum('Receipt to', mail || 'your account email')) : '')
      + sum('Total', priced(pack) ? naira(pack.price_kobo) : 'Price soon');
    const pay = $('shopPay');
    pay.disabled = this.busy || (wallet.isAccount() && !priced(pack));
    pay.textContent = !wallet.isAccount() ? (lagos ? 'Can\'t buy right now' : 'Create account to buy') : priced(pack) ? `Pay ${naira(pack.price_kobo)}` : 'Price soon';
  }

  // ---------- paying ----------
  async pay() {
    const pack = packById(this.pack);
    if (!wallet.isAccount()) return this.guestCard();
    if (this.busy || !priced(pack)) return;
    if (vatar.active()) return this.payVatar(pack);
    this.game.audio.play('click');
    this.busy = true;
    this.render();
    card.show({ icon: 'wait', tone: 'c', title: 'Complete payment', body: 'Opening Paystack…', busy: true });
    try {
      let Pop;
      try { Pop = await loadPaystack(); } catch { return this.problem('Paystack couldn\'t be loaded. Check your connection and try again.'); }
      const r = await wallet.payInit(pack.id);
      if (!r.ok) return r.error === 'session' ? card.hide() : this.problem(INIT_ERRORS[r.error] || INIT_ERRORS.unreachable);
      this.order = { ref: r.reference, access: r.access_code, pack, Pop };
      this.popup();
    } finally {
      this.busy = false;
      this.render();
    }
  }

  // Paystack's popup for the order (again, if the player closed the window and wants it back)
  popup() {
    const o = this.order;
    card.show({
      icon: 'wait', tone: 'c', title: 'Complete payment', body: 'Finish paying in the Paystack window.\nDon\'t close this page.',
      primary: 'Reopen payment window', secondary: 'Cancel', onPrimary: () => this.popup(), onSecondary: () => this.cancelled(o),
    });
    try {
      new o.Pop().resumeTransaction(o.access, {
        onSuccess: () => { if (this.order === o) this.confirm(o); },
        onCancel: () => { if (this.order === o) this.cancelled(o); },
        onError: () => { if (this.order === o) this.failed(o); },
      });
    } catch {
      this.failed(o);
    }
  }

  // Paystack's window says it's paid: the server has to hear it from Paystack too, usually within seconds
  async confirm(o) {
    card.show({ icon: 'wait', tone: 'c', title: 'Confirming…', body: `Checking your payment with Paystack.\nReference ${o.ref}`, busy: true });
    const end = Date.now() + CONFIRM_FOR;
    while (Date.now() < end && this.order === o) {
      const r = await wallet.payStatus(o.ref);
      if (this.order !== o) return;
      if (r.ok && r.status === 'paid') return this.success(o, r);
      if (r.ok && r.status !== 'pending') return this.failed(o);
      await sleep(CONFIRM_EVERY);
    }
    if (this.order === o) this.waiting(o);
  }

  // a bank transfer, or Paystack still working on it: the game keeps checking in the background
  waiting(o) {
    wallet.watch(o.ref);
    card.show({
      icon: 'bank', tone: 'y', title: 'Waiting for your bank',
      body: 'Transfers can take a few minutes. Keep racing; your tokens arrive automatically and we\'ll email a receipt.',
      primary: 'Keep racing', secondary: 'Check status', onDismiss: card.hide,
      onPrimary: () => { this.order = null; this.close('menu'); },
      onSecondary: async () => {
        const r = await wallet.payStatus(o.ref);
        if (r.ok && r.status === 'paid') this.success(o, r);
        else if (r.ok && r.status !== 'pending') this.failed(o);
      },
    });
  }

  success(o, r) {
    this.order = null;
    this.game.audio.play('gauge');
    const w = this.want && item(this.want.id);
    const mail = this.game.account?.session?.email;
    card.show({
      icon: 'ok', tone: 'g', title: `+${fmt(r.tokens)} tokens`,
      body: `Payment confirmed. Balance: ${fmt(r.balance)}.${mail ? `\nReceipt sent to ${mail}.` : ''}`,
      primary: w ? `Unlock ${w.name}` : 'Back to garage', secondary: w ? 'Back to garage' : 'Done', onDismiss: card.hide,
      onPrimary: () => this.close('garage'),
      onSecondary: () => { if (w) this.want = null; card.hide(); this.close(w ? 'garage' : this.from); },
    });
  }

  // the popup closed before paying: nothing was charged. A transfer started there may still arrive, so it's watched quietly.
  cancelled(o) {
    this.order = null;
    wallet.watch(o.ref);
    this.failed(o);
  }

  failed(o) {
    this.order = null;
    card.show({
      icon: 'fail', tone: 'r', title: 'Payment didn\'t go through',
      body: `You were not charged. If money left your account, your bank will reverse it, or contact support with reference ${o.ref}.`,
      primary: 'Try again', secondary: 'Contact support', onDismiss: card.hide,
      onPrimary: () => this.pay(),
      onSecondary: () => { location.href = `mailto:${SUPPORT}?subject=${encodeURIComponent(`Payment ${o.ref}`)}`; },
    });
  }

  // before Paystack: nothing was charged
  problem(msg, title = 'Can\'t buy tokens right now') {
    this.order = null;
    card.show({ icon: 'fail', tone: 'r', title, body: msg, primary: 'Try again', secondary: 'Close', onPrimary: () => this.pay() });
  }

  // ---------- paying in Lagos Life ----------
  // The world's pay sheet opens over the game (and pauses it). It answers once Vatar's server has the payment; then
  // this server checks the purchase with Vatar and adds the tokens.
  async payVatar(pack) {
    this.game.audio.play('click');
    this.busy = true;
    this.render();
    card.show({ icon: 'wait', tone: 'c', title: 'Complete payment', body: 'Finish paying on the Lagos Life pay sheet.', busy: true });
    let p;
    try {
      p = await vatar.purchase(pack.id);
    } catch (e) {
      if (e.code === 'cancelled') return card.hide();
      return this.problem(VATAR_ERRORS[e.code] || VATAR_ERRORS.error, e.code === 'payment_failed' ? 'Payment didn\'t go through' : undefined);
    } finally {
      this.busy = false;
      this.render();
    }
    return this.claimVatar(p);
  }

  async claimVatar(p) {
    card.show({ icon: 'wait', tone: 'c', title: 'Confirming…', body: 'Adding your tokens.', busy: true });
    const r = await wallet.vatarClaim(p.purchaseId);
    if (r.ok) return this.success(null, r);
    // paid, but not added yet: Lagos Life keeps it on the game's undelivered list, and the next launch claims it again
    card.show({
      icon: 'bank', tone: 'y', title: 'Payment received',
      body: `Your tokens are on their way: they're added the next time the game opens. If they don't arrive, email ${SUPPORT} with reference ${p.purchaseId}.`,
      primary: 'Try now', secondary: 'Later', onDismiss: card.hide, onPrimary: () => this.claimVatar(p), onSecondary: card.hide,
    });
  }

  // at launch in Lagos Life: packs paid while the game was away (a reload, or paying on the provider's page) are claimed
  // now, and any that are confirmed later on their own
  vatarBoot() {
    const claim = (p) => wallet.vatarClaim(p.purchaseId, { announce: true });
    vatar.purchases().then(async (list) => { for (const p of list) await claim(p); }).catch(() => { /* asked again next launch */ });
    vatar.onPurchase(claim);
  }

  guestCard() {
    // in Lagos Life everyone has an account, unless the server couldn't be reached at launch
    if (vatar.active()) {
      return card.show({
        icon: 'fail', tone: 'r', title: 'Can\'t buy tokens right now', body: 'The Driftbolt server can\'t be reached, so there\'s no wallet to add tokens to yet.',
        primary: 'Try again', secondary: 'Close', onDismiss: card.hide,
        onPrimary: async () => {
          card.show({ icon: 'wait', tone: 'c', title: 'Connecting…', body: '', busy: true });
          await this.game.account.renewVatar();
          if (wallet.isAccount()) card.hide(); else this.guestCard();
        },
      });
    }
    card.show({
      icon: 'user', tone: 'c', title: 'Save your garage first',
      body: 'Tokens live on your account, so you keep them on every device.\nTakes 20 seconds: name + email.',
      primary: 'Create account', secondary: 'Log in instead', onDismiss: card.hide,
      onPrimary: () => { card.hide(); this.game.account.open('signup'); },
      onSecondary: () => { card.hide(); this.game.account.open('login'); },
    });
  }
}
