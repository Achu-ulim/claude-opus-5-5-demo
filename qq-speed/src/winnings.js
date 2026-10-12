// The Winnings screen (design/Winnings): the cash balance (what's available, and prizes still in their report window),
// the account checks cash needs (18+, identity, a bank account in the verified name), responsible play (limits and
// breaks), and withdrawing to the bank or converting to tokens. Every step a check or a refusal calls for opens in the
// checkout card (checkout.js) with a small form; the server (server/src/cash.js) decides everything.
import * as cash from './cashwallet.js';
import * as card from './checkout.js';
import * as wallet from './wallet.js';
import { CURRENCIES, transferFee, tokensFor, money } from './cash.js';
import { loadPaystack } from './paystack.js';
import { SUPPORT } from './shop.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATUS = { pending: ['On its way', 'wait'], review: ['Being checked', 'wait'], paid: ['Paid', 'ok'], failed: ['Returned', 'off'], reversed: ['Returned', 'off'], rejected: ['Returned', 'off'] };
const KIND = { deposit: 'Cash added', entry_hold: 'Race entry', entry_refund: 'Entry refunded', prize: 'Race winnings', withdrawal: 'Withdrawal', withdrawal_reversal: 'Withdrawal returned', convert: 'Converted to tokens' };
const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const day = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
// "1,250.50" → minor units (or NaN)
const toMinor = (text) => { const v = Number(String(text).replace(/[^\d.]/g, '')); return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : NaN; };
const major = (minor) => (minor / 100).toLocaleString('en-US', { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 });

export class Winnings {
  constructor(game) {
    this.game = game;
    this.tab = 'withdraw';
    this.shown = false;
    this.from = 'menu';
    $('cwBack').addEventListener('click', () => this.close());
    $('cwAdd').addEventListener('click', () => this.deposit());
    $('cwLimits').addEventListener('click', () => this.limits());
    $('cwChecks').addEventListener('click', (e) => { const b = e.target.closest('[data-step]'); if (b) this.step(b.dataset.step); });
    $('cwTabW').addEventListener('click', () => this.pick('withdraw'));
    $('cwTabC').addEventListener('click', () => this.pick('convert'));
    $('cwMax').addEventListener('click', () => { const s = cash.get(); if (s) { $('cwAmt').value = major(s.balance.available); this.render(); } });
    $('cwAmt').addEventListener('input', () => this.render());
    $('cwBank').addEventListener('click', (e) => { if (e.target.closest('button')) this.bank(); });
    $('cwGo').addEventListener('click', () => (this.tab === 'withdraw' ? this.withdraw() : this.convert()));
    cash.onChange(() => { if (this.shown) this.render(); });
  }

  get isOpen() { return !$('winnings').classList.contains('hidden'); }

  // tab: 'withdraw' | 'convert'; from: the screen to go back to
  open(from = 'menu', tab = null) {
    this.game.audio.play('click');
    this.from = from;
    this.shown = true;
    if (tab) this.tab = tab;
    for (const id of ['menu', 'online', 'cashRes', 'cashHost']) $(id).classList.add('hidden');
    $('winnings').classList.remove('hidden');
    this.msg = '';
    this.render();
    cash.refresh();
    clearInterval(this.tick);
    this.tick = setInterval(() => this.render(), 1000); // "arriving in 9:12"
  }

  close() {
    if (!this.shown) return;
    this.game.audio.play('click');
    this.cancel();
    card.hide();
    $('winnings').classList.add('hidden');
    if (this.from === 'cashRes') this.game.cashRace.reopenResult();
    else if (this.from === 'cashHost') this.game.cashRace.openHost();
    else $(this.from).classList.remove('hidden');
  }

  cancel() { this.shown = false; clearInterval(this.tick); }

  pick(tab) {
    if (tab === this.tab) return;
    this.game.audio.play('click');
    this.tab = tab;
    this.msg = '';
    this.render();
  }

  say(text) { this.msg = text; this.render(); }

  // ---------- the screen ----------
  render() {
    const s = cash.get();
    if (!s) { $('cwTotal').textContent = '…'; return; }
    const cur = s.currency || 'NGN', fmt = (m) => money(m, cur), now = Date.now();
    $('cwCur').textContent = s.currency ? `${CURRENCIES[cur].name} wallet` : '';
    $('cwTotal').textContent = fmt(s.balance.total);
    const arriving = s.balance.arriving.filter((a) => !a.held), held = s.balance.arriving.filter((a) => a.held);
    const next = arriving.reduce((t, a) => Math.min(t, a.releaseAt || Infinity), Infinity);
    $('cwSub').textContent = [
      arriving.length && `${fmt(arriving.reduce((n, a) => n + a.amount, 0))} arriving in ${clock(next - now)}`,
      held.length && `${fmt(held.reduce((n, a) => n + a.amount, 0))} held for review`,
      `${fmt(s.balance.available)} available`,
    ].filter(Boolean).join(' · ');
    $('cwAdd').classList.toggle('hidden', cash.mode() !== 'on');

    // account checks
    const C = s.checks;
    const rows = [
      ['Age 18+ confirmed', C.age === 'done' ? 'done' : C.age === 'blocked' ? 'blocked' : 'needed', 'age'],
      [`ID verified (BVN or NIN)${C.kycName ? ` · ${C.kycName}` : ''}`, C.kyc === 'done' ? 'done' : C.kyc === 'failed' ? 'failed' : 'needed', 'kyc'],
      [`Bank account name matches ID${C.bankLast4 ? ` · ${C.bankName} ·••• ${C.bankLast4}` : ''}`, C.bank === 'done' ? 'done' : 'needed', 'bank'],
    ];
    const LABEL = { done: ['Done', 'ok'], needed: ['To do', 'y'], failed: ['Try again', 'r'], blocked: ['Not available', 'r'] };
    $('cwChecks').innerHTML = rows.map(([name, st, step]) => {
      const [label, tone] = LABEL[st];
      const act = st === 'needed' || st === 'failed';
      return `<${act ? `button type="button" data-step="${step}"` : 'div'} class="cwcheck ${tone}"><i></i><span>${esc(name)}</span><b>${label}</b></${act ? 'button' : 'div'}>`;
    }).join('');

    // responsible play
    const L = s.limits;
    const rp = [];
    if (L) {
      rp.push(['Daily entry limit', fmt(L.entry)], ['Entries in the last 24 h', fmt(L.entryUsed)], ['Daily deposit limit', fmt(L.deposit)], ['Deposits in the last 24 h', fmt(L.depositUsed)]);
      if (L.pending) rp.push(['Higher limit from', new Date(L.pending.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })]);
    }
    if (s.excludedUntil) rp.push(['On a break until', day(s.excludedUntil)]);
    $('cwPlay').innerHTML = rp.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('') || '<div><span>Choose a currency to set your limits</span></div>';

    // withdraw or convert
    const w = this.tab === 'withdraw';
    $('cwTabW').setAttribute('aria-selected', String(w));
    $('cwTabC').setAttribute('aria-selected', String(!w));
    $('cwMain').classList.toggle('conv', !w);
    $('cwW').classList.toggle('hidden', !w);
    $('cwC').classList.toggle('hidden', w);
    $('cwSym').textContent = CURRENCIES[cur].symbol;
    const amt = toMinor($('cwAmt').value), valid = Number.isFinite(amt);
    $('cwAvail').textContent = `${fmt(s.balance.available)} available${arriving.length ? ' (prizes in their report window come later)' : ''}`;
    if (w) {
      $('cwBank').innerHTML = C.bank === 'done'
        ? `<i class="cwbi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10l9-6 9 6M5 10v8M19 10v8M9 10v8M15 10v8M3 20h18"/></svg></i><div><b>${esc(C.bankName)} ·••• ${esc(C.bankLast4)}</b><small>${esc(C.bankAccountName)} · name matches your verified ID</small></div><button type="button">Change</button>`
        : `<i class="cwbi off"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10l9-6 9 6M5 10v8M19 10v8M9 10v8M15 10v8M3 20h18"/></svg></i><div><b>No bank account yet</b><small>${C.kyc === 'done' ? 'Add one in your verified name' : 'Verify your ID first, then add one in your name'}</small></div><button type="button">Add</button>`;
      const fee = valid ? transferFee(amt, cur, cash.cfg()) : 0;
      $('cwFee').textContent = valid ? `${fmt(fee)} · you receive ${fmt(Math.max(0, amt - fee))}` : fmt(transferFee(cash.cfg().minWithdrawal[cur] || 0, cur, cash.cfg()));
      $('cwMin').textContent = fmt(cash.cfg().minWithdrawal[cur] || 0);
      $('cwGo').textContent = valid ? `Withdraw ${fmt(amt)}` : 'Withdraw';
    } else {
      $('cwFrom').textContent = fmt(valid ? amt : 0);
      $('cwTo').textContent = `${(valid ? tokensFor(amt, cur, cash.cfg()) : 0).toLocaleString('en-US')} tokens`;
      $('cwRate').textContent = `${cash.cfg().convertBonusPct}% more tokens than buying them`;
      $('cwGo').textContent = 'Convert to tokens';
    }
    $('cwGo').disabled = !valid || this.busy;
    $('cwMsg').textContent = this.msg || '';

    // recent: withdrawals (with their status) and the rest of the cash history
    const wd = s.withdrawals.slice(0, 4).map((x) => {
      const [label, tone] = STATUS[x.status] || ['', ''];
      return `<div class="cwr"><span>${esc(new Date(x.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</span><span>Withdrawal to ${esc(x.bank || 'bank')} · fee ${fmt(x.fee)}</span><b class="${tone}">${label}</b><b>${fmt(-x.amount)}</b></div>`;
    });
    const hist = s.history.filter((h) => !['withdrawal', 'withdrawal_reversal'].includes(h.kind)).slice(0, 6).map((h) =>
      `<div class="cwr"><span>${esc(new Date(h.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</span><span>${KIND[h.kind] || h.kind}${h.kind.startsWith('entry') || h.kind === 'prize' ? ` · C-${esc(h.ref.slice(1))}` : ''}</span><b></b><b class="${h.amount > 0 ? 'ok' : ''}">${h.amount > 0 ? '+' : ''}${fmt(h.amount)}</b></div>`);
    $('cwRecent').innerHTML = (wd.length || hist.length) ? `<div class="wlab">Recent</div>${[...wd, ...hist].join('')}` : '';
  }

  // ---------- the steps ----------
  // a refusal from the server: the step that fixes it, or its explanation
  handle(r, retry) {
    const { text, step } = cash.explain(r);
    if (r.error === 'bank_mismatch') return this.bankMismatch(r);
    if (step === 'login') { card.hide(); return this.game.account.open('signup'); }
    if (step && step !== 'limits') return this.step(step, retry, text);
    card.show({ icon: 'fail', tone: 'r', title: 'Not this time', body: text, primary: step === 'limits' ? 'See my limits' : 'OK', secondary: step === 'limits' ? 'Close' : '',
      onPrimary: () => (step === 'limits' ? this.limits() : card.hide()), onDismiss: card.hide });
    return null;
  }

  // the checks in the order cash needs them; then: what to do once this one is done
  step(which, then = null, why = '') {
    const s = cash.get();
    if (which === 'kyc' && s?.checks.age !== 'done') which = 'age';
    if (which === 'bank' && s?.checks.kyc !== 'done') which = s?.checks.age !== 'done' ? 'age' : 'kyc';
    if (which === 'deposit') return this.deposit(why);
    const fn = { currency: this.currency, age: this.age, kyc: this.kyc, bank: this.bank }[which];
    return fn ? fn.call(this, then, why) : null;
  }

  currency(then, why = '') {
    const cfg = cash.cfg();
    const form = `<div class="copick">${cfg.currencies.map((c, i) => `<label><input type="radio" name="currency" value="${c}"${i ? '' : ' checked'}>${CURRENCIES[c].symbol} ${CURRENCIES[c].name}</label>`).join('')}</div>
      <span class="cohint">Your cash balance, entries and winnings are all in this currency. You can change it later only while your wallet is empty.</span>`;
    const go = async () => {
      const v = card.values();
      card.show({ ...c, busy: true });
      const r = await cash.setCurrency(v.currency);
      if (!r.ok) return card.show({ ...c, error: cash.explain(r).text });
      card.hide();
      this.render();
      then?.();
    };
    const c = { icon: 'cash', tone: 'g', title: 'Choose your currency', body: why, form, primary: 'Continue', secondary: 'Cancel', onPrimary: go, onSecondary: card.hide };
    card.show(c);
  }

  age(then, why = '') {
    const s = cash.get();
    if (s?.checks.age === 'blocked') return card.show({ icon: 'fail', tone: 'r', title: 'Cash races aren\'t available', body: cash.REASONS.age_blocked[0], primary: 'OK', onPrimary: card.hide });
    const form = `<label>Date of birth<input type="date" name="dob" min="1900-01-01" max="${new Date().toISOString().slice(0, 10)}" required></label>
      <span class="cohint">Cash races are for players 18 and over. You can't change this later, so enter it as it is on your ID.</span>`;
    const go = async () => {
      const { dob } = card.values();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return card.show({ ...c, error: 'Enter your date of birth.' });
      card.show({ ...c, busy: true, error: '' });
      const r = await cash.setAge(dob);
      if (!r.ok) {
        if (r.error === 'under_age' || r.error === 'age_blocked') return card.show({ icon: 'fail', tone: 'r', title: 'Cash races are 18+', body: cash.explain(r).text, primary: 'OK', onPrimary: card.hide });
        return card.show({ ...c, busy: false, error: cash.explain(r).text });
      }
      card.hide();
      this.render();
      then?.();
    };
    const c = { icon: 'cake', tone: 'g', title: 'Confirm your age', body: why && why !== cash.REASONS.age_needed[0] ? why : '', form, primary: 'Confirm', secondary: 'Cancel', onPrimary: go, onSecondary: card.hide };
    card.show(c);
  }

  kyc(then, why = '') {
    const s = cash.get();
    if (!s?.checks.kycReady) return card.show({ icon: 'id', tone: 'y', title: 'Identity checks open soon', body: cash.REASONS.kyc_unavailable[0], primary: 'OK', onPrimary: card.hide });
    const form = `<label>ID type<select name="type"><option value="bvn">BVN (Bank Verification Number)</option><option value="nin">NIN (National Identification Number)</option></select></label>
      <label>Number<input name="number" inputmode="numeric" autocomplete="off" maxlength="11" placeholder="11 digits"></label>
      <div class="corow"><label>First name<input name="firstName" autocomplete="given-name"></label><label>Last name<input name="lastName" autocomplete="family-name"></label></div>
      <label>Middle name (if any)<input name="middleName" autocomplete="additional-name"></label>
      <span class="cohint">Your names as they are on the ID. We keep only the result, the name on record and the date — never the number.</span>`;
    const go = async () => {
      const v = card.values();
      if (!/^\d{11}$/.test(v.number.replace(/\s/g, ''))) return card.show({ ...c, error: 'The number has 11 digits.' });
      if (!v.firstName || !v.lastName) return card.show({ ...c, error: 'Enter your first and last name.' });
      card.show({ ...c, busy: true, error: '' });
      const r = await cash.verifyId({ ...v, number: v.number.replace(/\s/g, '') });
      if (!r.ok) return card.show({ ...c, busy: false, error: cash.explain(r).text });
      card.show({ icon: 'ok', tone: 'g', title: 'Identity verified', body: `Verified as ${r.checks.kycName}. Next: the bank account your winnings go to, in this name.`,
        primary: s.checks.bank === 'done' ? 'Done' : 'Add bank account', secondary: s.checks.bank === 'done' ? '' : 'Later',
        onPrimary: () => (s.checks.bank === 'done' ? (card.hide(), then?.()) : this.bank(then)), onSecondary: card.hide });
      this.render();
    };
    const c = { icon: 'id', tone: 'c', title: 'Verify your identity', body: why && why !== cash.REASONS.kyc_needed[0] ? why : 'Needed once, before your first withdrawal.', form, primary: 'Verify', secondary: 'Cancel', onPrimary: go, onSecondary: card.hide };
    card.show(c);
  }

  async bank(then, why = '') {
    const s = cash.get();
    if (s?.checks.kyc !== 'done') return this.step('kyc', then);
    card.show({ icon: 'bank', tone: 'c', title: 'Bank account', body: 'Loading banks…', busy: true });
    const list = await cash.banks();
    if (!list.ok) return card.show({ icon: 'fail', tone: 'r', title: 'Bank account', body: cash.explain(list).text, primary: 'OK', onPrimary: card.hide });
    const form = `<label>Bank<select name="bankCode"><option value="">Choose your bank</option>${list.banks.map((b) => `<option value="${esc(b.code)}">${esc(b.name)}</option>`).join('')}</select></label>
      <label>Account number<input name="accountNumber" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="10 digits"></label>
      <span class="cohint">It has to be in your verified name, ${esc(s.checks.kycName)}. We check the name with your bank.</span>`;
    const go = async () => {
      const v = card.values();
      if (!v.bankCode) return card.show({ ...c, error: 'Choose your bank.' });
      if (!/^\d{10}$/.test(v.accountNumber)) return card.show({ ...c, error: 'Account numbers have 10 digits.' });
      card.show({ ...c, busy: true, error: '' });
      const r = await cash.setBank(v.bankCode, v.accountNumber);
      if (!r.ok) return r.error === 'bank_mismatch' ? this.bankMismatch(r) : card.show({ ...c, busy: false, error: cash.explain(r).text });
      card.show({ icon: 'ok', tone: 'g', title: 'Bank account added', body: `${r.checks.bankName} ·••• ${r.checks.bankLast4}, in the name ${r.checks.bankAccountName}.`, primary: 'Done', onPrimary: () => { card.hide(); then?.(); } });
      this.render();
    };
    const c = { icon: 'bank', tone: 'c', title: s.checks.bank === 'done' ? 'Change bank account' : 'Add your bank account', body: why && why !== cash.REASONS.bank_needed[0] ? why : '', form,
      primary: 'Check and save', secondary: 'Cancel', onPrimary: go, onSecondary: card.hide };
    card.show(c);
  }

  bankMismatch(r) {
    card.show({
      icon: 'fail', tone: 'r', title: 'Name doesn\'t match',
      body: `That account is in the name ${r.accountName}, but your verified name is ${r.verifiedName}. Winnings can only go to an account in your own name.`,
      primary: 'Try another account', secondary: 'Contact support', onDismiss: card.hide,
      onPrimary: () => this.bank(),
      onSecondary: () => { location.href = `mailto:${SUPPORT}?subject=${encodeURIComponent('Bank account name')}`; },
    });
  }

  // ---------- responsible play ----------
  limits() {
    const s = cash.get();
    if (!s?.currency) return this.step('currency', () => this.limits());
    const L = s.limits, cur = s.currency;
    const form = `<div class="corow"><label>Daily deposit limit<input name="deposit" inputmode="decimal" value="${major(L.deposit)}"></label><label>Daily entry limit<input name="entry" inputmode="decimal" value="${major(L.entry)}"></label></div>
      <span class="cohint">In ${CURRENCIES[cur].name.toLowerCase()}, over any 24 hours; at most ${money(L.depositMax, cur)} and ${money(L.entryMax, cur)}. Lowering a limit works at once; raising one waits 24 hours.</span>`;
    const go = async () => {
      const v = card.values(), deposit = toMinor(v.deposit), entry = toMinor(v.entry);
      if (!Number.isFinite(deposit) || !Number.isFinite(entry)) return card.show({ ...c, error: 'Enter both limits as amounts.' });
      card.show({ ...c, busy: true, error: '' });
      const r = await cash.setLimits({ deposit, entry });
      if (!r.ok) return card.show({ ...c, busy: false, error: cash.explain(r).text });
      card.show({ icon: 'ok', tone: 'g', title: 'Limits saved', body: r.limits.pending ? `A higher limit starts ${new Date(r.limits.pending.at).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}.` : 'Your new limits are on now.', primary: 'Done', onPrimary: card.hide });
      this.render();
    };
    const c = {
      icon: 'pause', tone: 'g', title: 'Play responsibly',
      body: s.excludedUntil ? `You're on a break from cash races until ${day(s.excludedUntil)}.` : 'Set your own limits, or take a break from cash races.',
      form, primary: 'Save limits', secondary: s.excludedUntil ? 'Close' : 'Take a break', onPrimary: go,
      onSecondary: () => (s.excludedUntil ? card.hide() : this.breakCard()), onDismiss: card.hide,
    };
    card.show(c);
  }

  breakCard() {
    const days = cash.cfg().exclusionDays;
    const form = `<div class="copick">${days.map((d, i) => `<label><input type="radio" name="days" value="${d}"${i ? '' : ' checked'}>${d} days</label>`).join('')}</div>
      <span class="cohint">No cash race entries or deposits until the break is over. It can't be ended early. You can still withdraw what you have.</span>`;
    const go = async () => {
      const d = +card.values().days;
      card.show({ ...c, busy: true });
      const r = await cash.takeBreak(d);
      if (!r.ok) return card.show({ ...c, busy: false, error: cash.explain(r).text });
      card.show({ icon: 'ok', tone: 'g', title: 'Break started', body: `No cash races until ${day(r.excludedUntil)}. Tokens, cups and online races are all still open.`, primary: 'OK', onPrimary: card.hide });
      this.render();
    };
    const c = { icon: 'pause', tone: 'y', title: 'Take a break', form, primary: 'Start my break', secondary: 'Cancel', onPrimary: go, onSecondary: card.hide };
    card.show(c);
  }

  // ---------- money in: Paystack ----------
  async deposit(why = '', then = null) {
    const s = cash.get();
    if (!s?.currency) return this.step('currency', () => this.deposit(why, then));
    if (s.checks.age !== 'done') return this.step('age', () => this.deposit(why, then));
    const cur = s.currency, cfg = cash.cfg(), min = cfg.minDeposit[cur] || 100;
    const chips = (cur === 'NGN' ? [50_000, 100_000, 200_000, 500_000] : [500, 1_000, 2_000, 5_000]).filter((v) => v >= min);
    const form = `<label>Amount (${CURRENCIES[cur].symbol})<input name="amount" inputmode="decimal" value="${major(chips[1] || min)}"></label>
      <div class="copick">${chips.map((v) => `<label><input type="radio" name="chip" value="${v}">${money(v, cur)}</label>`).join('')}</div>
      <span class="cohint">Daily deposit limit ${money(s.limits.deposit, cur)}: ${money(Math.max(0, s.limits.deposit - s.limits.depositUsed), cur)} left today. Pay by card, bank transfer, USSD or bank app.</span>`;
    const go = async () => {
      const amount = toMinor(card.values().amount);
      if (!Number.isFinite(amount)) return card.show({ ...c, error: 'Enter an amount.' });
      card.show({ ...c, busy: true, error: '' });
      let Pop;
      try { Pop = await loadPaystack(); } catch { return card.show({ ...c, busy: false, error: 'Paystack couldn\'t be loaded. Check your connection.' }); }
      const r = await cash.depositInit(amount);
      if (!r.ok) {
        if (['deposit_limit', 'min_deposit', 'payments_off', 'paystack', 'excluded', 'withdraw_only', 'slow_down'].includes(r.error)) return card.show({ ...c, busy: false, error: cash.explain(r).text });
        return this.handle(r, () => this.deposit(why, then));
      }
      this.popup({ ref: r.reference, access: r.access_code, Pop, amount, then });
    };
    const c = { icon: 'cash', tone: 'g', title: 'Add cash', body: why, form, primary: 'Pay with Paystack', secondary: 'Cancel', onPrimary: go, onSecondary: card.hide };
    card.show(c);
    // the chips fill the amount in
    $('coForm').querySelectorAll('input[name=chip]').forEach((el) => el.addEventListener('change', () => { $('coForm').querySelector('input[name=amount]').value = major(+el.value); }));
  }

  popup(o) {
    this.order = o;
    card.show({ icon: 'wait', tone: 'c', title: 'Complete payment', body: 'Finish paying in the Paystack window.\nDon\'t close this page.', primary: 'Reopen payment window', secondary: 'Cancel',
      onPrimary: () => this.popup(o), onSecondary: () => { this.order = null; this.watch(o.ref); card.hide(); } });
    try {
      new o.Pop().resumeTransaction(o.access, {
        onSuccess: () => { if (this.order === o) this.confirm(o); },
        onCancel: () => { if (this.order === o) { this.order = null; this.watch(o.ref); card.hide(); } },
        onError: () => { if (this.order === o) this.failed(o.ref); },
      });
    } catch { this.failed(o.ref); }
  }

  // the server has to hear it from Paystack too, usually within seconds
  async confirm(o) {
    card.show({ icon: 'wait', tone: 'c', title: 'Confirming…', body: `Checking your payment with Paystack.\nReference ${o.ref}`, busy: true });
    const end = Date.now() + 60_000;
    while (Date.now() < end && this.order === o) {
      const r = await cash.depositStatus(o.ref);
      if (this.order !== o) return;
      if (r.ok && r.status === 'paid') return this.paid(o, r);
      if (r.ok && r.status !== 'pending') return this.failed(o.ref);
      await sleep(2000);
    }
    if (this.order !== o) return;
    this.order = null;
    this.watch(o.ref);
    card.show({ icon: 'bank', tone: 'y', title: 'Waiting for your bank', body: 'Transfers can take a few minutes. Your cash arrives by itself and we\'ll email a receipt.', primary: 'OK', onPrimary: card.hide });
  }

  // a payment still on its way: checked now and then while the game is open
  watch(ref) {
    let n = 0;
    const t = setInterval(async () => {
      const r = await cash.depositStatus(ref);
      if ((r.ok && r.status !== 'pending') || ++n > 40) {
        clearInterval(t);
        if (r.ok && r.status === 'paid') { cash.refresh(); this.game.toastCredit(`+${money(r.amount, r.currency)} cash added`); }
      }
    }, 30_000);
  }

  paid(o, r) {
    this.order = null;
    this.game.audio.play('gauge');
    cash.refresh();
    card.show({ icon: 'ok', tone: 'g', title: `+${money(r.amount, r.currency)}`, body: `Cash added. Balance: ${money(r.balance, r.currency)}.\nReference ${o.ref}.`,
      primary: o.then ? 'Continue' : 'Done', onPrimary: () => { card.hide(); o.then?.(); } });
  }

  failed(ref) {
    this.order = null;
    card.show({ icon: 'fail', tone: 'r', title: 'Payment didn\'t go through', body: `You were not charged. If money left your account, your bank will reverse it, or contact support with reference ${ref}.`,
      primary: 'Try again', secondary: 'Contact support', onPrimary: () => this.deposit(), onDismiss: card.hide,
      onSecondary: () => { location.href = `mailto:${SUPPORT}?subject=${encodeURIComponent(`Cash deposit ${ref}`)}`; } });
  }

  // after Paystack's own page sent the player back (?cashpay=<reference>)
  returned(ref) {
    this.open('menu');
    this.order = { ref };
    this.confirm(this.order);
  }

  // ---------- money out ----------
  withdraw() {
    const s = cash.get();
    const amt = toMinor($('cwAmt').value);
    if (!s || !Number.isFinite(amt)) return;
    const C = s.checks;
    if (C.age !== 'done') return this.step('age', () => this.withdraw());
    if (C.kyc !== 'done') return this.step('kyc', () => this.withdraw());
    if (C.bank !== 'done') return this.step('bank', () => this.withdraw());
    const cur = s.currency, fee = transferFee(amt, cur, cash.cfg());
    card.show({
      icon: 'bank', tone: 'g', title: `Withdraw ${money(amt, cur)}?`,
      body: `To ${C.bankName} ·••• ${C.bankLast4} (${C.bankAccountName}).\nTransfer fee ${money(fee, cur)}: you receive ${money(amt - fee, cur)}, usually within minutes.`,
      primary: 'Withdraw', secondary: 'Cancel', onSecondary: card.hide,
      onPrimary: async () => {
        card.show({ icon: 'wait', tone: 'g', title: 'Sending…', body: '', busy: true });
        const r = await cash.withdraw(amt);
        if (!r.ok) return this.handle(r, () => this.withdraw());
        $('cwAmt').value = '';
        const done = {
          pending: ['ok', 'g', 'On its way', `${money(amt - r.fee, cur)} is on its way to ${C.bankName} ·••• ${C.bankLast4}. It usually arrives within minutes; we'll email a receipt.`],
          paid: ['ok', 'g', 'Sent', `${money(amt - r.fee, cur)} is in ${C.bankName} ·••• ${C.bankLast4}. We've emailed a receipt.`],
          review: ['wait', 'y', 'Being checked', 'This withdrawal is held for a quick check before it\'s sent, usually within a day. The money is set aside from your balance meanwhile.'],
          failed: ['fail', 'r', 'Didn\'t go through', `The transfer was refused, so ${money(amt, cur)} is back in your balance. Try again later, or contact support.`],
        }[r.status] || ['ok', 'g', 'Requested', 'Your withdrawal has been requested.'];
        card.show({ icon: done[0], tone: done[1], title: done[2], body: done[3], primary: 'OK', onPrimary: card.hide });
        this.render();
      },
    });
  }

  convert() {
    const s = cash.get();
    const amt = toMinor($('cwAmt').value);
    if (!s?.currency || !Number.isFinite(amt)) return;
    const cur = s.currency, tokens = tokensFor(amt, cur, cash.cfg());
    const form = `<label class="cocheck"><span><input type="checkbox" name="ok"> I understand: tokens can't be turned back into cash</span></label>`;
    const c = {
      icon: 'spend', tone: 'y', title: `Convert ${money(amt, cur)}?`,
      body: `You get ${tokens.toLocaleString('en-US')} tokens straight away, ${cash.cfg().convertBonusPct}% more than buying them.\n\nThis is one-way. Tokens can never be turned back into cash, withdrawn or refunded.`,
      form, primary: `Convert to ${tokens.toLocaleString('en-US')} tokens`, secondary: 'Cancel', onSecondary: card.hide,
      onPrimary: async () => {
        if (!card.values().ok) return card.show({ ...c, error: 'Tick the box to confirm you understand.' });
        card.show({ ...c, busy: true, error: '' });
        const r = await cash.convert(amt);
        if (!r.ok) return card.show({ ...c, busy: false, error: cash.explain(r).text });
        $('cwAmt').value = '';
        wallet.refresh();
        this.game.audio.play('gauge');
        card.show({ icon: 'ok', tone: 'g', title: `+${r.tokens.toLocaleString('en-US')} tokens`, body: `Token balance: ${r.tokenBalance.toLocaleString('en-US')}. Spend them in the Garage.`, primary: 'Done', onPrimary: card.hide });
        this.render();
      },
    };
    card.show(c);
  }
}
