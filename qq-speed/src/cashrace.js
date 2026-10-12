// Cash races in the game: hosting one (design/CashCreate), the room's lobby (design/CashLobby) and the result with its
// payout (design/CashResult). The room's connection is the Online class's (online.js); this draws the cash screens and
// takes their money steps through cashwallet.js. The server holds the entries, checks the race and pays out.
import * as cash from './cashwallet.js';
import * as card from './checkout.js';
import { SPLITS, splitAllowed, prizePool, placeShares, money, showCashCode } from './cash.js';
import { MAPS, MAP_TINT } from './maps.js';
import { trackName } from './leagues.js';
import { CARS } from './carModel.js';
import { CAR_ITEMS } from './catalog.js';
import { formatTime } from './util.js';
import { SUPPORT } from './shop.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1) && n % 10] || 'th');
const SEAT_COLORS = ['#ff3b3b', '#ffd23a', '#d7dae5', '#b6ff3b', '#b48cff', '#3a6bff'];
const ICON = { ok: 'M5 12l5 5L20 7', clock: 'M12 7v5l3 2', warn: 'M12 8v5M12 16.5v.5', x: 'M6 6l12 12M18 6L6 18' };
const STEP_TONE = { ok: '#7cff9e', wait: '#ffd23a', bad: '#ff6b6b', off: '#5b5e73' };

export class CashRace {
  constructor(game, online) {
    this.game = game;
    this.online = online;
    this.opts = { entry: 0, seats: 2, split: 'wta', map: 'neon', laps: 2 };
    this.res = null; // the result being shown: { code, rows, laps, map, room (GET /cash/rooms) }

    // host
    $('chBack').addEventListener('click', () => { this.game.audio.play('click'); this.closeHost(); this.online.open(); });
    $('chBal').addEventListener('click', () => this.game.winnings.open('cashHost'));
    $('chGroups').addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (!b || b.disabled) return;
      this.game.audio.play('click');
      const g = b.dataset.g, v = b.dataset.v;
      this.opts[g] = ['entry', 'seats', 'laps'].includes(g) ? +v : v;
      if (!splitAllowed(this.opts.split, this.opts.seats)) this.opts.split = 'wta';
      this.renderHost();
    });
    $('chCreate').addEventListener('click', () => this.create());
    $('chRules').addEventListener('click', (e) => { if (e.target.id === 'chPlay') { e.preventDefault(); this.game.winnings.limits(); } });

    // lobby
    $('crLeave').addEventListener('click', () => this.leave());
    $('crCopy').addEventListener('click', () => this.online.copyInvite('crCopy'));
    $('crShare').addEventListener('click', () => this.online.shareInvite());
    $('crShare').classList.toggle('hidden', !navigator.share);
    $('crGo').addEventListener('click', () => this.go());
    $('crSeats').addEventListener('click', (e) => { const k = e.target.closest('.kick'); if (k) this.kick(k.dataset.id, k.dataset.name); });

    // result
    $('cxWithdraw').addEventListener('click', () => this.game.winnings.open('cashRes', 'withdraw'));
    $('cxConvert').addEventListener('click', () => this.game.winnings.open('cashRes', 'convert'));
    $('cxAgain').addEventListener('click', () => { this.game.audio.play('click'); this.leaveResult(); this.openHost(); });
    $('cxBack').addEventListener('click', () => { this.game.audio.play('click'); this.leaveResult(); this.online.open(); });
    $('cxStand').addEventListener('click', (e) => { if (e.target.closest('#cxReportBtn')) this.report(); });

    setInterval(() => this.tick(), 500);
    cash.onChange(() => { if (!$('cashHost').classList.contains('hidden')) this.renderHost(); });
  }

  get room() { return this.online.room?.cash ? this.online.room : null; }

  // ---------- getting in ----------
  // what has to be true to put money into a cash race; then() once it is
  async ready(then) {
    await cash.loaded();
    const g = this.game, s = cash.get();
    if (!cash.isAccount()) {
      return card.show({ icon: 'user', tone: 'c', title: 'Cash races need an account', body: 'Create an account (or log in) to race for cash.\nTakes 20 seconds: name + email.',
        primary: 'Create account', secondary: 'Log in instead', onDismiss: card.hide,
        onPrimary: () => { card.hide(); g.account.open('signup'); }, onSecondary: () => { card.hide(); g.account.open('login'); } });
    }
    if (cash.mode() !== 'on') return card.show({ icon: 'pause', tone: 'y', title: 'Cash races', body: cash.explain({ error: cash.mode() === 'withdraw-only' ? 'withdraw_only' : 'cash_off' }).text, primary: 'OK', onPrimary: card.hide });
    if (!s) { cash.refresh().then((r) => (r.ok ? this.ready(then) : card.show({ icon: 'fail', tone: 'r', title: 'Cash races', body: cash.explain(r).text, primary: 'OK', onPrimary: card.hide }))); return; }
    if (!s.currency) return g.winnings.step('currency', () => this.ready(then));
    if (s.checks.age !== 'done') return g.winnings.step('age', () => this.ready(then), s.checks.age === 'blocked' ? '' : 'Cash races are 18+. Confirm your date of birth to continue.');
    if (s.excludedUntil) return card.show({ icon: 'pause', tone: 'y', title: 'You\'re taking a break', body: cash.explain({ error: 'excluded', until: s.excludedUntil }).text, primary: 'OK', onPrimary: card.hide });
    return then();
  }

  // a room code starting with C, typed in or from an invite link: its terms first, then the entry, then the room
  async join(code) {
    this.ready(async () => {
      card.show({ icon: 'wait', tone: 'g', title: `Cash race ${showCashCode(code)}`, body: 'Looking it up…', busy: true });
      const r = await cash.room(code);
      if (!r.ok) return this.problem(r);
      const R = r.room;
      if (!R.preview) { card.hide(); return this.online.connectCash(code); } // already paid in
      if (R.status !== 'open') return this.problem({ error: 'room_closed' });
      const cur = R.currency, shares = placeShares(R.prize, R.split);
      const pay = R.split === 'wta' ? `Winner gets ${money(R.prize, cur)}` : `1st ${money(shares[0], cur)} · 2nd ${money(shares[1], cur)} · 3rd ${money(shares[2], cur)}`;
      card.show({
        icon: 'cash', tone: 'g', title: `Join ${showCashCode(code)}?`,
        body: `${R.hostName}'s race · ${trackName(R.map)} · ${R.laps} lap${R.laps > 1 ? 's' : ''} · ${R.paid} of ${R.seats} paid.\n${pay} (pool ${money(R.pool, cur)}, fee ${R.feePct}%).\n\nYour ${money(R.entry, cur)} entry is taken from your cash balance now and held until the race. If the room doesn't fill, you get it back.`,
        primary: `Pay ${money(R.entry, cur)} and join`, secondary: 'Cancel', onSecondary: card.hide,
        onPrimary: async () => {
          card.show({ icon: 'wait', tone: 'g', title: 'Joining…', body: '', busy: true });
          const j = await cash.joinRoom(code);
          if (!j.ok) return this.problem(j, () => this.join(code));
          card.hide();
          this.online.connectCash(code);
        },
      });
    });
  }

  problem(r, retry) {
    const { step } = cash.explain(r);
    if (step) return this.game.winnings.handle(r, retry);
    card.show({ icon: 'fail', tone: 'r', title: 'Cash race', body: cash.explain(r).text, primary: 'OK', onPrimary: card.hide });
  }

  // ---------- host (design/CashCreate) ----------
  openHost() {
    this.ready(() => {
      for (const id of ['menu', 'online', 'winnings', 'cashRes']) $(id).classList.add('hidden');
      $('cashHost').classList.remove('hidden');
      const cfg = cash.cfg(), cur = cash.currency();
      if (!cfg.entries[cur]?.includes(this.opts.entry)) this.opts.entry = cfg.entries[cur]?.[0] || 0;
      if (!cfg.seats.includes(this.opts.seats)) this.opts.seats = cfg.seats[0];
      if (!cfg.maps.includes(this.opts.map)) this.opts.map = cfg.maps[0];
      if (!cfg.laps.includes(this.opts.laps)) this.opts.laps = cfg.laps[0];
      this.renderHost();
      cash.refresh();
    });
  }

  closeHost() { $('cashHost').classList.add('hidden'); }

  renderHost() {
    const s = cash.get(), cfg = cash.cfg(), o = this.opts;
    if (!s?.currency) return;
    const cur = s.currency, fmt = (m) => money(m, cur);
    const L = s.limits;
    const chip = (g, v, label, on, disabled = false) => `<button type="button" class="chchip${on ? ' sel' : ''}" data-g="${g}" data-v="${esc(v)}" aria-pressed="${on}"${disabled ? ' disabled' : ''}>${label}</button>`;
    const group = (label, chips, note) => `<div class="chgroup"><div class="olab">${label}</div><div class="chchips">${chips.join('')}</div>${note ? `<div class="chnote">${note}</div>` : ''}</div>`;
    const car = CARS[Math.max(0, CAR_ITEMS.findIndex((c) => c.car === cfg.car))];
    $('chGroups').innerHTML = [
      group('Entry per player', cfg.entries[cur].map((v) => chip('entry', v, fmt(v), v === o.entry)), `Same entry for everyone. Your daily entry limit: ${fmt(L.entry)} (${fmt(Math.max(0, L.entry - L.entryUsed))} left today).`),
      group('Players', cfg.seats.map((v) => chip('seats', v, `${v} racers`, v === o.seats)), 'The race starts when every seat is filled and paid.'),
      group('Prize split', cfg.splits.map((id) => chip('split', id, SPLITS[id].name, id === o.split, !splitAllowed(id, o.seats))), 'Top 3 split needs at least 4 racers.'),
      group('Track', cfg.maps.map((id) => chip('map', id, `<i style="background:${MAP_TINT[id] || '#888'}"></i>${esc(MAPS.find((m) => m.id === id)?.name || id)}`, id === o.map))),
      group('Laps', cfg.laps.map((v) => chip('laps', v, `${v} lap${v > 1 ? 's' : ''}`, v === o.laps))),
    ].join('');
    $('chCar').textContent = `${car?.name || 'One car'} · stock tune`;
    $('chBalAmt').textContent = fmt(s.balance.available);
    const { pool, fee, prize } = prizePool(o.entry, o.seats, cfg.feePct);
    $('chEntryLine').textContent = `${fmt(o.entry)} × ${o.seats}`;
    $('chPool').textContent = fmt(pool);
    $('chFeePct').textContent = `${cfg.feePct}%`;
    $('chFee').textContent = `−${fmt(fee)}`;
    const shares = placeShares(prize, o.split);
    $('chPayouts').innerHTML = o.split === 'wta'
      ? `<div class="chpo big"><span>Winner gets</span><b>${fmt(prize)}</b></div>`
      : shares.map((v, i) => `<div class="chpo"><span>${ordinal(i + 1)}</span><b>${fmt(v)}</b></div>`).join('');
    $('chStake').textContent = fmt(o.entry);
    const short = s.balance.available < o.entry;
    $('chCreate').textContent = short ? `Add cash to host · ${fmt(o.entry)}` : `Create room · ${fmt(o.entry)}`;
    $('chCreate').disabled = this.busy;
  }

  async create() {
    const s = cash.get(), o = this.opts;
    if (!s || this.busy) return;
    this.game.audio.play('click');
    if (s.balance.available < o.entry) return this.game.winnings.deposit(`You need ${money(o.entry - s.balance.available, s.currency)} more to host this race.`);
    this.busy = true;
    this.renderHost();
    const r = await cash.createRoom({ entry: o.entry, seats: o.seats, split: o.split, map: o.map, laps: o.laps });
    this.busy = false;
    this.renderHost();
    if (!r.ok) {
      if (r.error === 'in_room' && r.code) return card.show({ icon: 'cash', tone: 'y', title: 'You\'re already in a cash race', body: `Finish or leave ${showCashCode(r.code)} first.`, primary: 'Go to it', secondary: 'Close', onSecondary: card.hide, onPrimary: () => { card.hide(); this.closeHost(); this.online.connectCash(r.code); } });
      return this.problem(r, () => this.create());
    }
    this.closeHost();
    this.online.connectCash(r.room.code);
  }

  // ---------- lobby (design/CashLobby) ----------
  renderLobby() {
    const R = this.room;
    if (!R) return;
    const C = R.cash, cur = C.currency, fmt = (m) => money(m, cur), now = this.online.now();
    const me = this.online.me, host = this.online.isHost;
    $('crKind').textContent = `Cash race · ${SPLITS[C.split]?.name || ''}`;
    $('crCode').textContent = showCashCode(R.code);
    $('crEntry').textContent = fmt(C.entry);
    const shares = placeShares(C.prize, C.split);
    $('crWinLab').textContent = C.split === 'wta' ? 'Winner gets' : '1st gets';
    $('crWin').textContent = fmt(shares[0]);
    $('crTrack').textContent = `${trackName(R.cfg.map)} · ${R.cfg.laps} lap${R.cfg.laps > 1 ? 's' : ''} · items off`;
    const paid = C.seated.length, full = paid >= C.seats, open = C.status === 'open' && R.phase === 'lobby';
    $('crClockLab').textContent = !open ? 'Status' : full ? 'Starts by' : 'Fills in';
    $('crClock').textContent = !open ? { racing: 'Racing', window: 'Paying out', review: 'In review', settled: 'Paid', refunded: 'Refunded' }[C.status] || C.status : clock(C.expiresAt - now);

    const players = R.players;
    const seats = [];
    for (let i = 0; i < C.seats; i++) {
      const s = C.seated[i];
      if (!s) {
        seats.push(`<div class="crseat open"><i class="av">+</i><b>Open seat</b><small>Verified 18+ players only</small><span class="tag open">${fmt(C.entry)} to join</span></div>`);
        continue;
      }
      const p = players.find((x) => x.name === s.name);
      const isHost = s.name === C.host, mine = p && p.id === this.online.myId;
      const tag = !s.here ? ['Paid · connecting', 'y'] : isHost ? ['Paid · host', 'g'] : p?.ready ? ['Paid · ready', 'g'] : ['Paid · not ready', 'y'];
      const kick = host && !mine && p && open ? `<button class="kick" type="button" data-id="${esc(p.id)}" data-name="${esc(s.name)}" title="Remove and refund" aria-label="Remove ${esc(s.name)} and refund their entry"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON.x}"/></svg></button>` : '';
      seats.push(`<div class="crseat${mine ? ' me' : ''}">${kick}<i class="av" style="background:${SEAT_COLORS[i % SEAT_COLORS.length]}">${esc(s.name[0] || '?')}</i><b>${esc(s.name)}</b>
        <small>${[isHost && 'Host', mine && 'you'].filter(Boolean).join(' · ') || 'Racer'}</small><span class="tag ${tag[1]}">${tag[0]}</span></div>`);
    }
    $('crSeats').innerHTML = seats.join('');
    $('crSeats').dataset.n = C.seats;

    $('crBar').style.width = `${Math.round((paid / C.seats) * 100)}%`;
    $('crHeld').textContent = `${fmt(C.entry * paid)} of ${fmt(C.pool)} held safely`;
    $('crPaid').textContent = `${paid} / ${C.seats} paid`;
    const left = C.seats - paid;
    $('crPoolNote').textContent = C.status === 'refunded' ? 'This room was called off: every entry has been refunded in full.'
      : !open ? 'Entries are held until the server has checked the race.'
        : full ? `Every seat is paid. If the race hasn't started by ${clock(C.expiresAt - now)}, everyone gets their ${fmt(C.entry)} back.`
          : `Entries sit in a holding account and only move when the server confirms the finish. If ${left} more racer${left > 1 ? 's don\'t' : ' doesn\'t'} join by ${clock(C.expiresAt - now)}, everyone gets ${fmt(C.entry)} back.`;

    // the button: the host starts once every seat is paid and everyone's ready; guests ready up
    const go = $('crGo');
    const others = C.seated.filter((s) => s.name !== C.host);
    const allReady = others.every((s) => s.here && players.find((p) => p.name === s.name)?.ready) && C.seated.every((s) => s.here);
    go.classList.remove('sec');
    if (C.status === 'refunded') { go.textContent = 'Back'; go.disabled = false; go.dataset.act = 'back'; }
    else if (R.phase === 'over') { go.textContent = 'See result'; go.disabled = false; go.dataset.act = 'result'; }
    else if (!open) { go.textContent = 'Race in progress'; go.disabled = true; go.dataset.act = ''; }
    else if (host) {
      go.dataset.act = 'start';
      go.textContent = !full ? `Waiting for ${left} more` : !allReady ? 'Waiting for everyone to be ready' : 'Start race';
      go.disabled = !full || !allReady;
    } else {
      go.dataset.act = 'ready';
      go.textContent = me?.ready ? 'Not ready' : 'Ready';
      go.classList.toggle('sec', !!me?.ready);
      go.disabled = false;
    }
    if (!this.notice) this.online.say('crMsg', C.status === 'refunded' ? `Called off (${C.note === 'cancelled' ? 'the host left' : C.note === 'expired' ? 'it didn\'t fill in time' : 'refunded'}). Your ${fmt(C.entry)} is back in your cash balance.` : '', false);
    this.online.renderNet();
  }

  go() {
    const act = $('crGo').dataset.act;
    this.game.audio.play('click');
    if (act === 'start') this.online.net?.send({ t: 'start' });
    else if (act === 'ready') this.online.net?.send({ t: 'set', ready: !this.online.me?.ready });
    else if (act === 'back') this.online.leave();
    else if (act === 'result') this.reopenResult();
  }

  // a word from the room (the race couldn't start)
  onNotice(code) {
    const text = { not_full: 'Every seat has to be filled and paid first.', room_closed: 'This room has closed.', unreachable: 'The server couldn\'t do that just now. Try again.', not_started: 'The race couldn\'t start. Try again.' }[code] || '';
    this.notice = text;
    this.online.say('crMsg', text, true);
    clearTimeout(this.noticeT);
    this.noticeT = setTimeout(() => { this.notice = ''; this.renderLobby(); }, 4000);
  }

  kick(id, name) {
    const C = this.room?.cash;
    if (!C) return;
    card.show({ icon: 'fail', tone: 'r', title: `Remove ${name}?`, body: `They get their ${money(C.entry, C.currency)} entry back and the seat opens again.`, primary: 'Remove', secondary: 'Cancel',
      onSecondary: card.hide, onPrimary: () => { card.hide(); this.online.net?.send({ t: 'kick', id }); } });
  }

  // leaving before the start gives the entry back (the host leaving calls the room off); after it, nothing changes
  leave() {
    const R = this.room;
    if (!R) return this.online.leave();
    const C = R.cash, fmt = (m) => money(m, C.currency);
    if (C.status !== 'open' || R.phase !== 'lobby') return this.online.leave();
    const host = this.online.isHost;
    card.show({
      icon: 'cash', tone: 'y', title: host ? 'Call off this race?' : 'Leave this race?',
      body: host ? `Everyone's entry is refunded in full, yours (${fmt(C.entry)}) included.` : `You get your ${fmt(C.entry)} entry back. You can't rejoin this room.`,
      primary: host ? 'Call it off' : 'Leave and refund', secondary: 'Stay', onSecondary: card.hide,
      onPrimary: () => { card.hide(); this.online.leave(); cash.refresh(); },
    });
  }

  // leaving mid-race forfeits the entry
  confirmQuit(then) {
    const C = this.room?.cash;
    if (!C) return then();
    card.show({ icon: 'fail', tone: 'r', title: 'Leave the race?', body: `You'd forfeit your ${money(C.entry, C.currency)} entry: it stays in the prize pool.`, primary: 'Keep racing', secondary: 'Leave and forfeit',
      onPrimary: card.hide, onSecondary: () => { card.hide(); then(); } });
  }

  // ---------- result (design/CashResult) ----------
  // the race's results from the room; the payout follows from the server (room views and GET /cash/rooms)
  showResult(res) {
    const R = this.room;
    this.res = { code: R.code, rows: res.rows, laps: res.laps, map: R.cfg.map, room: null, at: Date.now() };
    this.reopenResult();
    this.poll();
  }

  reopenResult() {
    if (!this.res) return this.online.open();
    for (const id of ['menu', 'online', 'winnings', 'cashHost', 'result']) $(id).classList.add('hidden');
    $('cashRes').classList.remove('hidden');
    this.renderResult();
  }

  leaveResult() {
    $('cashRes').classList.add('hidden');
    this.res = null;
    clearTimeout(this.pollT);
    if (this.room) this.online.leaveRoom();
    this.game.toMenuQuiet?.();
  }

  // GET /cash/rooms/<code> until the money is settled: my payout, the report window and whether I've reported
  async poll() {
    clearTimeout(this.pollT);
    const res = this.res;
    if (!res) return;
    const r = await cash.room(res.code);
    if (this.res !== res) return;
    if (r.ok) { res.room = r.room; this.renderResult(); }
    if (!r.ok || !['settled', 'refunded'].includes(r.room?.status)) this.pollT = setTimeout(() => this.poll(), 3000);
    else cash.refresh();
  }

  renderResult() {
    const X = this.res;
    if (!X) return;
    const live = this.room?.code === X.code ? this.room.cash : null; // the room's view, while still connected
    const D = X.room, C = D || live || {};
    const cur = C.currency || cash.currency() || 'NGN', fmt = (m) => money(m, cur), now = Date.now();
    const status = D?.status || live?.status || 'racing';
    const checking = status === 'racing' || live?.checking;
    const me = X.rows.find((r) => r.name === (this.online.me?.name || cash.get()?.user)) || X.rows.find((r) => D?.result?.find((x) => x.me && x.name === r.name));
    const myName = D?.result?.find((x) => x.me)?.name || me?.name;
    const mine = D?.mine || live?.plan?.awards?.find((a) => a.name === myName) || null;
    const awards = D?.plan?.awards || live?.plan?.awards || [];
    const pay = (name) => awards.find((a) => a.name === name)?.amount || 0;
    const row = X.rows.find((r) => r.name === myName);

    $('cxMeta').textContent = `Cash race ${showCashCode(X.code)} · ${trackName(X.map)} · ${X.rows.length} racers`;
    const pool = C.plan?.pool ?? C.pool ?? 0, fee = C.plan?.fee ?? C.fee ?? 0;
    $('cxSub').textContent = `Pool ${fmt(pool)} · platform fee ${fmt(fee)} (${C.feePct ?? cash.cfg().feePct}%)`;
    let head, big, tone = 'g';
    if (status === 'refunded') { head = 'Refunded'; big = fmt(C.entry || 0); }
    else if (checking) { head = row?.finished ? `You finished ${ordinal(row.place)}` : 'Race over'; big = 'Checking…'; tone = 'y'; }
    else if (mine) { head = mine.place === 1 ? 'You won' : `You placed ${ordinal(mine.place)}`; big = fmt(mine.amount); }
    else if (row?.finished) { head = `You finished ${ordinal(row.place)}`; big = 'No payout'; tone = 'w'; }
    else { head = 'Did not finish'; big = 'DNF'; tone = 'w'; }
    $('cxHead').textContent = head;
    $('cxBig').textContent = big;
    $('cxBig').className = `cxbig ${tone}`;

    // payout progress
    const flagged = D?.flagged || live?.flagged, reported = (D?.reports || live?.reports || 0) > 0;
    const step = (name, note, state, icon) => ({ name, note, state, icon });
    const steps = [
      step('Race finished', row?.finished ? (row.place === 1 ? 'You crossed the line first' : `You crossed the line ${ordinal(row.place)}`) : row?.out ? 'You disconnected or left: your entry stayed in the pool' : 'You didn\'t finish', 'ok', 'ok'),
      checking ? step('Checking the result', 'Lap times, speeds and positions, checked by the server', 'wait', 'clock')
        : status === 'refunded' ? step('Result checked', C.note === 'admin_refund' ? 'Reviewed: the race was voided' : 'Nobody finished: the race was voided', 'ok', 'ok')
          : flagged ? step('Result held for review', 'Something didn\'t add up, so a person is reviewing the replay', 'bad', 'warn')
            : step('Result checked by the server', 'Lap times, speeds and positions verified', 'ok', 'ok'),
      status === 'settled' ? step(mine ? 'Paid to your cash balance' : 'Paid out', mine ? 'Withdraw it, convert it, or race again' : 'The winnings went to the top finishers', 'ok', 'ok')
        : status === 'refunded' ? step('Entries refunded', `Your ${fmt(C.entry || 0)} is back in your cash balance`, 'ok', 'ok')
          : status === 'review' ? step(mine ? 'Payout held' : 'Payout held', reported ? 'A racer reported this race: held while we review the replay' : 'Waiting for the review, usually within a day', 'wait', 'clock')
            : status === 'window' ? step(mine ? 'Paid to your cash balance' : 'Payout', `${mine ? 'Available' : 'Paid out'} in ${clock((D?.releaseAt || live?.releaseAt || now) - now).replace(/^0/, '')} after the report window closes`, 'wait', 'clock')
              : step('Paid to your cash balance', 'After the check and a 10-minute report window', 'off', 'clock'),
    ];
    $('cxSteps').innerHTML = steps.map((s) => `<div class="cxstep"><span class="${s.state}" style="--c:${STEP_TONE[s.state]}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[s.icon]}"/></svg></span><div><b>${s.name}</b><small>${s.note}</small></div></div>`).join('');

    // standings
    $('cxRows').innerHTML = X.rows.map((r) => {
      const isMe = r.name === myName, amt = pay(r.name);
      const time = r.finished ? formatTime(r.time) : r.dns ? 'Didn\'t start' : r.out ? 'Disconnected' : 'Not finished';
      return `<div class="cxrow${isMe ? ' me' : ''}"><span class="p">${r.finished ? r.place : 'DNF'}</span><span>${isMe ? 'You · ' : ''}${esc(r.name)}</span><span class="t">${time}</span><span class="a${amt ? ' g' : ''}">${amt && !checking ? fmt(amt) : '—'}</span></div>`;
    }).join('');

    // reporting
    const canReport = D?.canReport && !D.reported;
    $('cxReport').innerHTML = D?.reported ? 'You reported this race. The payout is held while we review the replay.'
      : canReport ? `Think something's wrong? <button type="button" id="cxReportBtn">Report this race</button> within ${clock(D.releaseAt - now).replace(/^0/, '')} and the payout is held while we review the replay.`
        : status === 'window' || checking ? 'Think something\'s wrong? You can report this race once the result is in, for 10 minutes.'
          : status === 'review' ? 'This race is being reviewed.' : 'The report window has closed.';
    $('cxWithdraw').classList.toggle('hidden', !mine || status !== 'settled');
    $('cxConvert').classList.toggle('hidden', !mine || status !== 'settled');
  }

  report() {
    const X = this.res;
    if (!X) return;
    const form = '<label>What went wrong?<input name="reason" maxlength="280" placeholder="e.g. a car went through a wall on lap 2"></label><span class="cohint">The payout is held while a person reviews what the server recorded of the race.</span>';
    const c = {
      icon: 'warn', tone: 'y', title: 'Report this race', form, primary: 'Report', secondary: 'Cancel', onSecondary: card.hide,
      onPrimary: async () => {
        card.show({ ...c, busy: true });
        const r = await cash.report(X.code, card.values().reason);
        if (!r.ok) return card.show({ ...c, busy: false, error: cash.explain(r).text });
        X.room = r.room;
        this.renderResult();
        card.show({ icon: 'ok', tone: 'g', title: 'Reported', body: `Thanks. The payout is held while we review the replay; we may email you. Questions: ${SUPPORT}.`, primary: 'OK', onPrimary: card.hide });
      },
    };
    card.show(c);
  }

  // the lobby's clocks and the result's countdowns
  tick() {
    if (this.room && !$('onCashRoom').classList.contains('hidden')) this.renderLobby();
    if (this.res && !$('cashRes').classList.contains('hidden')) this.renderResult();
  }
}

