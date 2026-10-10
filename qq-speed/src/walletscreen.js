// The Wallet screen (design/Wallet): the token balance with what was earned and bought, the ways to earn more with
// how far along each one is, and the history of every change to the balance (wallet.js).
import { CARS } from './carModel.js';
import { CUPS } from './league.js';
import { REWARDS, INVITE_RACES, item, packById, naira } from './catalog.js';
import { dailySet } from './challenges.js';
import * as wallet from './wallet.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => n.toLocaleString('en-US');
const TIERS = ['easy', 'medium', 'hard'];
const SLOT_WORD = { paint: 'paint', wheels: 'rims', bodykit: '', glow: 'glow' };
const STATUS = { done: ['Done', 'ok'], paid: ['Paid', 'ok'], pending: ['Pending', 'wait'], failed: ['Failed', 'off'], abandoned: ['Cancelled', 'off'] };

// "Unlocked Neon Cyan rims", "Unlocked Bugatti"
function itemName(it) {
  if (it.category === 'car') return CARS.find((c) => c.id === it.car)?.name || it.car;
  return [it.name, SLOT_WORD[it.category]].filter(Boolean).join(' ');
}

// what a history row was for
export function describe(r) {
  switch (r.reason) {
    case 'welcome': return 'Welcome bonus';
    case 'league': return 'League race win';
    case 'invite': return r.ref === 'invited' ? 'Invite reward' : 'Your invited friend raced';
    case 'move': return 'Guest garage moved in';
    case 'unlock': { const it = item(r.ref.slice('unlock:'.length)); return it ? `Unlocked ${itemName(it)}` : 'Unlocked'; }
    case 'purchase': case 'payment': return `Bought ${packById(r.pack)?.name || 'a token'} pack`;
    case 'earn': {
      if (r.label) return r.label;
      const [kind, a, b] = r.ref.split(':');
      if (kind === 'challenge') { const c = dailySet(a)[TIERS.indexOf(b)]; return c ? `Daily: ${c.title}` : 'Daily challenge'; }
      if (kind === 'cup') return `${CUPS.find((c) => REWARDS.cup[c.id] === r.delta)?.name || 'Cup'} win`;
      if (kind === 'f1') return 'F1 championship win';
      if (kind === 'streak') return '7-day streak';
    }
  }
  return 'Tokens';
}

function when(t) {
  const d = new Date(t), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export class WalletScreen {
  constructor(game) {
    this.game = game;
    this.shown = false;
    $('walBack').addEventListener('click', () => this.close());
    $('walGet').addEventListener('click', () => this.game.shop.open({ from: 'wallet' }));
    $('walEarn').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) this.act(b.dataset.act);
    });
    wallet.onChange(() => { if (this.shown) this.render(); });
  }

  get isOpen() { return !$('wallet').classList.contains('hidden'); }

  open(from = 'menu') {
    this.game.audio.play('click');
    this.from = from;
    this.shown = true;
    $(from).classList.add('hidden');
    $('wallet').classList.remove('hidden');
    this.msg = '';
    this.render();
    wallet.refresh();
    wallet.retryHeld();
    clearInterval(this.tick);
    this.tick = setInterval(() => this.render(), 30_000); // "resets in 7h"
  }

  close() {
    if (!this.shown) return;
    this.game.audio.play('click');
    this.cancel();
    $('wallet').classList.add('hidden');
    $(this.from).classList.remove('hidden');
  }

  cancel() { this.shown = false; clearInterval(this.tick); }

  async act(what) {
    const g = this.game;
    g.audio.play('click');
    if (what === 'claim') await g.challenges.claimAll();
    else if (what === 'challenges') { this.cancel(); $('wallet').classList.add('hidden'); g.challenges.open(); }
    else if (what === 'held') {
      const n = await wallet.retryHeld();
      this.msg = n ? `+${fmt(n)} tokens added.` : wallet.held().length ? 'Still waiting: today\'s reward limit is reached, or the server can\'t be reached. They\'re added as soon as they fit.' : '';
    } else if (what === 'invite') {
      const link = `${location.origin}/?invite=${encodeURIComponent(wallet.user())}`;
      try {
        if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Driftbolt', text: 'Race me on Driftbolt', url: link });
        else { await navigator.clipboard.writeText(link); this.msg = 'Invite link copied.'; }
      } catch { this.msg = link; }
    } else if (what === 'signup') g.account.open('signup');
    this.render();
  }

  render() {
    const g = this.game, ch = g.challenges, t = wallet.totals(), acct = wallet.isAccount();
    $('walBal').textContent = fmt(wallet.getBalance());
    $('walEarned').textContent = fmt(t.earned);
    $('walBought').textContent = fmt(t.bought);
    $('walWho').textContent = acct ? `${wallet.user()}'s tokens, on every device` : 'Guest wallet: these tokens stay on this device';

    // ways to earn, each with how far along it is
    const rows = [];
    const D = ch.today(), done = ch.set.filter((_, i) => ch.done(i)).length;
    const left = Math.ceil((new Date(new Date().setHours(24, 0, 0, 0)) - Date.now()) / 3_600_000);
    rows.push({ name: 'Daily challenges', reward: `+${TIERS.reduce((n, k) => n + REWARDS.challenge[k], 0)}`, p: done / 3,
      note: `${done} of 3 done today · resets in ${left}h`, ...(ch.unclaimed ? { btn: 'Claim', act: 'claim', hot: true } : { btn: 'See', act: 'challenges' }) });
    const cup = g.league.d.cup, def = g.league.cupDef();
    rows.push({ name: 'Win a cup', reward: `+${Math.min(...Object.values(REWARDS.cup))}–${Math.max(...Object.values(REWARDS.cup))}`, p: cup ? cup.idx / def.races : 0,
      note: cup ? `${def.name}: race ${cup.idx + 1} of ${def.races}` : 'Start a Tournament from the lobby' });
    const f1 = g.league.f1;
    rows.push({ name: 'Win a Formula 1 championship', reward: `+${REWARDS.f1}`, p: f1 ? f1.idx / f1.calendar.length : 0,
      note: f1 ? `Round ${f1.idx + 1} of ${f1.calendar.length}` : 'Start a season from the lobby' });
    const n = ch.streak, day = n ? n % 7 || 7 : 0;
    rows.push({ name: '7-day streak', reward: `+${REWARDS.streak}`, p: day / 7, note: n ? `Day ${day} of 7 · a challenge a day keeps it going` : 'Finish a daily challenge to start one' });
    const fr = wallet.info()?.friends;
    rows.push({ name: 'Invite a friend who races', reward: `+${REWARDS.invite}`, p: 0,
      note: acct ? `Both of you get tokens when they finish ${INVITE_RACES} online races${fr?.rewarded ? ` · ${fr.rewarded} so far` : ''}` : 'Create an account to invite friends',
      ...(acct ? { btn: 'Copy link', act: 'invite' } : { btn: 'Sign up', act: 'signup' }) });
    const held = wallet.held();
    if (held.length) {
      rows.unshift({ name: 'Waiting to be added', reward: `+${fmt(held.reduce((s, c) => s + c.amount, 0))}`, p: 1, hot: true, btn: 'Claim now', act: 'held',
        note: `${held.map((c) => c.label).filter(Boolean).slice(0, 2).join(', ') || 'Rewards'}: added when today's limit has room or you're back online` });
    }
    $('walEarn').innerHTML = rows.map((r) => `<div class="wearn${r.hot ? ' hot' : ''}"><div class="wtop"><span>${esc(r.name)}</span><b>${r.reward}</b></div>
      <div class="wbar"><i style="width:${Math.round(Math.min(1, r.p) * 100)}%"></i></div>
      <div class="wfoot"><span>${esc(r.note)}</span>${r.btn ? `<button type="button" class="wbtn${r.hot ? ' hot' : ''}" data-act="${r.act}">${r.btn}</button>` : ''}</div></div>`).join('');
    $('walToday').textContent = `Rewards today: ${fmt(t.today)} of ${fmt(t.cap)}`;
    $('walMsg').textContent = this.msg || '';

    // history
    const hist = wallet.history();
    $('walHist').innerHTML = hist.length ? hist.map((r) => {
      const [label, tone] = STATUS[r.status] || STATUS.done;
      const ref = r.reason === 'purchase' ? r.ref.slice(4) : r.ref;
      const pay = r.amount ? `${naira(r.amount)} · ${ref}` : '—';
      const amt = r.delta > 0 ? `+${fmt(r.delta)}` : r.delta < 0 ? `−${fmt(-r.delta)}` : '0';
      const cls = r.status === 'pending' ? 'wait' : r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : 'zero';
      return `<div class="hrow"><span class="hd">${when(r.at)}</span><span class="hw">${esc(describe(r))}</span><span class="hp">${esc(pay)}</span>
        <span class="hs ${tone}">${label}</span><span class="ha ${cls}">${amt}</span></div>`;
    }).join('') : '<div class="hnone">Nothing yet. Race, finish challenges and win cups to earn tokens.</div>';
  }
}
