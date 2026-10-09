// Player accounts on this device: the Log In, Create Account, Verify and Change email screens, the session, and the
// accounts used here (the one-tap tiles on Log In). Talks to the server's /auth API (server/src/accounts.js).
// Guests skip all of it and play exactly as before; once someone picks "Play as guest", the game opens to the lobby.
import { USERNAME_RE, EMAIL_RE, EMAIL_MAX, LOGIN_CODE_LEN, RESEND_GAP } from './netproto.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const SESSION = 'driftbolt.session'; // { token, username, email (masked), exp }
const SAVED = 'driftbolt.accounts'; // [{ username, device?, at }]: accounts used on this device, most recent first
const GUEST = 'driftbolt.guest'; // true: this player chose to play as a guest
const GUEST_NAME = 'driftbolt.guestName'; // a guest's driver name, put back when they log out
const PANELS = { login: 'auLogin', signup: 'auSignup', verify: 'auVerify', email: 'auEmail' };
const COLORS = ['#ff3b3b', '#36e2ff', '#ffd23a', '#7cff9e', '#ff5fa8', '#b07cff'];
const RENEW = 7 * 86_400_000; // a session this close to its end is renewed with the device token
const MAX_SAVED = 6;
const NAME_HINT = '3–16 letters, numbers or _. This is how other racers see you.';
const ERRORS = {
  bad_name: 'Usernames are 3–16 letters, numbers or _.',
  name_not_allowed: 'That name isn\'t allowed. Try another.',
  name_taken: 'That name was just taken. Try another.',
  bad_email: 'That doesn\'t look like an email address.',
  same_email: 'That\'s already your email.',
  slow_down: 'Too many tries. Wait a few minutes, then try again.',
  too_soon: 'A code is on its way. You can ask for another in a minute.',
  code_locked: 'Too many wrong tries, so that code no longer works. Tap Resend for a new one.',
  code_expired: 'That code has expired. Tap Resend for a new one.',
  email_unavailable: 'We can\'t send emails right now, so new devices can\'t log in. Play as guest for now.',
  not_configured: 'Accounts aren\'t set up on this server yet. Play as guest for now.',
  session: 'Your login has expired. Log in again.',
  unreachable: 'Can\'t reach the server. Check your connection, or play as guest.',
  offline: 'Accounts aren\'t available in this copy of the game.',
};

function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function write(key, v) { try { if (v == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage off */ } }
// a session token's expiry, read from its payload (the server checks the signature; this is only for planning)
function expiry(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).x || 0; } catch { return 0; }
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const color = (name) => COLORS[[...name.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const avatar = (el, name) => { el.textContent = name ? name[0].toUpperCase() : ''; el.style.setProperty('--av', color(name || '')); };
const touch = () => matchMedia('(pointer: coarse)').matches;

export class Account {
  // serverUrl: the online server (ws://, wss:// or http://); empty when this build has no server, and then no accounts
  constructor(game, serverUrl) {
    this.game = game;
    this.base = serverUrl ? serverUrl.replace(/^ws/, 'http') : '';
    const s = read(SESSION);
    this.session = s && typeof s.token === 'string' && typeof s.username === 'string' ? s : null;
    const saved = read(SAVED);
    this.saved = Array.isArray(saved) ? saved.filter((a) => a && typeof a.username === 'string' && USERNAME_RE.test(a.username)) : [];
    this.done = null; // resolves the launch screen
    this.pending = null; // the code being waited for: { purpose: 'login' | 'email', username, masked, email?, resendAt }
    this.nameCheck = { name: '', state: '' };
    this.mailTouched = false;
    this.busy = false;
    this.bind();
  }

  get user() { return this.session?.username || null; }
  get token() { return this.session?.token || null; }
  get isOpen() { return !$('auth').classList.contains('hidden'); }

  // ---------- launch ----------
  // Resolves once the player is in: logged in (a saved session), a guest, or through the Log In / Create Account screens
  start() {
    if (!this.base) { this.session = null; this.apply(); return Promise.resolve(); }
    if (this.session && expiry(this.session.token) > Date.now()) {
      this.apply();
      this.check();
      return Promise.resolve();
    }
    if (this.session) this.endSession();
    this.apply();
    if (read(GUEST) === true) return Promise.resolve();
    return new Promise((resolve) => {
      this.done = resolve;
      this.open(this.saved.length ? 'login' : 'signup');
    });
  }

  // in the background at launch: is the session still good (it may have been logged out from another device)?
  // Close to its end, it's renewed with this device's token.
  async check() {
    const token = this.token;
    try {
      const r = await this.call('/auth/me', {}, token);
      if (this.token !== token) return;
      this.session.email = r.account.email;
      write(SESSION, this.session);
      this.renderSettings();
    } catch (e) {
      if (e.code === 'session' && this.token === token) this.expired();
      return; // offline: carry on with what we have
    }
    const dev = this.find(this.user)?.device;
    if (dev && expiry(token) - Date.now() < RENEW) {
      try {
        const r = await this.call('/auth/login', { username: this.user, deviceToken: dev });
        if (r.session && this.token === token) this.keep(r, dev);
      } catch { /* next launch */ }
    }
  }

  // the server no longer takes this session: back to Log In, the account's tile ready to tap
  expired(msg = ERRORS.session) {
    if (!this.user) return;
    this.endSession();
    this.game.online.leaveRoom();
    this.apply();
    this.open('login', msg);
  }

  // ---------- server ----------
  async call(path, body, token) {
    if (!this.base) throw { code: 'offline' };
    let res;
    try {
      res = await fetch(this.base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
      });
    } catch { throw { code: 'unreachable' }; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { ...data, code: data.error || 'unreachable' };
    return data;
  }

  error(e) {
    if (e.code === 'bad_code') return `That code isn't right. ${e.left} ${e.left === 1 ? 'try' : 'tries'} left.`;
    if (e.code === 'slow_down' && e.retryIn) return `Too many tries. Try again in ${e.retryIn >= 90 ? Math.ceil(e.retryIn / 60) + ' minutes' : e.retryIn + ' seconds'}.`;
    return ERRORS[e.code] || ERRORS.unreachable;
  }

  // ---------- who's playing ----------
  find(name) { return name ? this.saved.find((a) => same(a.username, name)) : null; }

  // a session from signup, login or verify. device: this device's token for the account (new, or the one that just worked)
  keep(r, device) {
    const name = r.account.username;
    if (!this.user) write(GUEST_NAME, this.game.league.name);
    this.session = { token: r.session, username: name, email: r.account.email, exp: expiry(r.session) };
    write(SESSION, this.session);
    this.saved = [{ username: name, ...(device && { device }), at: Date.now() }, ...this.saved.filter((a) => !same(a.username, name))].slice(0, MAX_SAVED);
    write(SAVED, this.saved);
  }

  signedIn(r, device) {
    const was = this.user;
    this.keep(r, device);
    write(GUEST, null);
    // a different driver now: the online room this tab was in belongs to the last one
    if (!was || !same(was, this.user)) this.game.online.leaveRoom();
    this.apply();
    this.close();
  }

  endSession() {
    this.session = null;
    write(SESSION, null);
    const n = read(GUEST_NAME);
    if (typeof n === 'string' && n) this.game.league.name = n;
    write(GUEST_NAME, null);
  }

  // shows who's playing: the account's name in the lobby (fixed), or the guest's editable driver name
  apply() {
    const u = this.user, g = this.game;
    if (u) g.league.name = u;
    $('pname').value = g.league.name;
    $('pname').closest('.driver').classList.toggle('acct', !!u);
    $('pacctName').textContent = u || '';
    $('pacct').setAttribute('aria-label', u ? `Account: ${u}` : 'Account');
    avatar($('pacctAv'), u);
    for (const id of ['onName']) {
      $(id).value = g.league.name;
      $(id).readOnly = !!u;
      $(id).title = u ? 'Your account name. Change accounts from Settings.' : '';
    }
    this.renderSettings();
  }

  // ---------- screens ----------
  open(mode, msg = '', bad = true) {
    const a = $('auth');
    a.classList.remove('hidden');
    a.classList.toggle('su', mode === 'signup');
    for (const [k, id] of Object.entries(PANELS)) $(id).classList.toggle('hidden', k !== mode);
    this.mode = mode;
    a.scrollTop = 0;
    clearInterval(this.tickT);
    if (mode === 'login') {
      this.renderTiles();
      this.say('auLoginMsg', msg, bad);
      const u = $('auUser');
      if (!u.value && !this.saved.length && !touch()) u.focus();
    } else if (mode === 'signup') {
      this.say('auSignupMsg', msg);
      this.renderSignup();
      if (!touch()) $('auSUser').focus();
    } else if (mode === 'verify') {
      this.renderVerify();
      this.say('auVerifyMsg', msg);
      this.tickT = setInterval(() => this.renderResend(), 250);
      this.digits.forEach((d) => { d.value = ''; d.classList.remove('on'); });
      $('auDigits').classList.remove('bad');
      if (!touch()) this.digits[0].focus();
    } else if (mode === 'email') {
      $('auNewMail').value = '';
      this.say('auEmailMsg', msg);
      if (!touch()) $('auNewMail').focus();
    }
  }

  close() {
    $('auth').classList.add('hidden');
    clearInterval(this.tickT);
    this.pending = null;
    if (this.done) { const d = this.done; this.done = null; d(); }
  }

  say(id, text, bad = true) {
    $(id).textContent = text || '';
    $(id).classList.toggle('bad', bad && !!text);
  }

  guest() {
    this.game.audio.play('click');
    write(GUEST, true);
    this.close();
  }

  bind() {
    document.querySelectorAll('#auth [data-guest]').forEach((b) => b.addEventListener('click', () => this.guest()));
    $('auToSignup').addEventListener('click', () => this.open('signup'));
    $('auToLogin').addEventListener('click', () => this.open('login'));

    // Log In
    $('auLoginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('auUser').value.trim();
      if (!USERNAME_RE.test(name)) return this.say('auLoginMsg', name ? ERRORS.bad_name : 'Type your username, or tap your name above.');
      this.login(name);
    });
    $('auTiles').addEventListener('click', (e) => {
      const x = e.target.closest('.atx');
      if (x) return this.forget(x.dataset.name);
      const t = e.target.closest('.atmain');
      if (t) this.login(t.dataset.name);
    });

    // Create Account: the name is checked as it's typed (300 ms after the last key), the email as it's typed
    $('auSUser').addEventListener('input', () => {
      clearTimeout(this.nameT);
      const name = $('auSUser').value.trim();
      this.nameCheck = { name, state: USERNAME_RE.test(name) ? 'checking' : name ? 'format' : '' };
      if (this.nameCheck.state === 'checking') this.nameT = setTimeout(() => this.checkName(name), 300);
      this.renderSignup();
    });
    $('auSMail').addEventListener('input', () => this.renderSignup());
    $('auSMail').addEventListener('blur', () => { this.mailTouched = !!$('auSMail').value.trim(); this.renderSignup(); });
    $('auSignupForm').addEventListener('submit', (e) => { e.preventDefault(); this.signup(); });

    // Verify: six boxes. Typing moves on, Backspace moves back, a pasted (or autofilled) code fills them all
    const box = $('auDigits');
    this.digits = Array.from({ length: LOGIN_CODE_LEN }, (_, i) => {
      const d = document.createElement('input');
      d.inputMode = 'numeric';
      d.autocomplete = i === 0 ? 'one-time-code' : 'off';
      d.pattern = '[0-9]*';
      d.setAttribute('aria-label', `Digit ${i + 1}`);
      box.append(d);
      return d;
    });
    this.digits.forEach((d, i) => {
      d.addEventListener('input', () => {
        const v = d.value.replace(/\D/g, '');
        if (v.length > 1) return this.fill(v, i);
        d.value = v;
        d.classList.toggle('on', !!v);
        $('auDigits').classList.remove('bad');
        if (v && i < LOGIN_CODE_LEN - 1) this.digits[i + 1].focus();
        if (v) this.autoSubmit();
      });
      d.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !d.value && i > 0) {
          e.preventDefault();
          const p = this.digits[i - 1];
          p.value = '';
          p.classList.remove('on');
          p.focus();
        } else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); this.digits[i - 1].focus(); }
        else if (e.key === 'ArrowRight' && i < LOGIN_CODE_LEN - 1) { e.preventDefault(); this.digits[i + 1].focus(); }
      });
      d.addEventListener('paste', (e) => {
        const v = (e.clipboardData?.getData('text') || '').replace(/\D/g, '');
        if (!v) return;
        e.preventDefault();
        this.fill(v, v.length >= LOGIN_CODE_LEN ? 0 : i);
      });
      d.addEventListener('focus', () => d.select());
    });
    $('auVerifyForm').addEventListener('submit', (e) => { e.preventDefault(); this.verify(); });
    $('auResend').addEventListener('click', () => this.resend());
    $('auNotYou').addEventListener('click', () => {
      if (this.pending?.purpose === 'email') return this.close();
      $('auUser').value = '';
      this.open('login');
    });

    // Change email
    $('auEmailForm').addEventListener('submit', (e) => { e.preventDefault(); this.changeEmail(); });
    $('auEmailCancel').addEventListener('click', () => this.close());

    // the lobby's account chip and the Settings section
    $('pacct').addEventListener('click', () => this.game.openSettings());
    $('acLogin').addEventListener('click', () => this.open(this.saved.length ? 'login' : 'signup'));
    $('acSignup').addEventListener('click', () => this.open('signup'));
    $('acEmail').addEventListener('click', () => this.open('email'));
    $('acOut').addEventListener('click', () => this.logout(false));
    $('acAll').addEventListener('click', () => this.logout(true));
  }

  // ---------- Log In ----------
  renderTiles() {
    const list = this.saved;
    $('auTilesBox').classList.toggle('hidden', !list.length);
    $('auOr').classList.toggle('hidden', !list.length);
    $('auTiles').innerHTML = list.map((a, i) => {
      const sub = !a.device ? 'Needs an emailed code' : i === 0 ? 'Tap to race' : 'On this device';
      return `<div class="atile${i === 0 ? ' first' : ''}"><button class="atmain" type="button" data-name="${esc(a.username)}">
        <i class="av" style="--av:${color(a.username)}">${esc(a.username[0].toUpperCase())}</i><span><b>${esc(a.username)}</b><small>${sub}</small></span></button>
        <button class="atx" type="button" data-name="${esc(a.username)}" title="Remove from this device" aria-label="Remove ${esc(a.username)} from this device"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
    }).join('');
  }

  async login(name) {
    if (this.busy) return;
    this.game.audio.play('click');
    this.busy = true;
    $('auLoginGo').classList.add('busy');
    this.say('auLoginMsg', 'Checking…', false);
    const saved = this.find(name);
    try {
      const r = await this.call('/auth/login', { username: name, ...(saved?.device && { deviceToken: saved.device }) });
      if (r.session) return this.signedIn(r, saved?.device);
      // this device's token for the account no longer works (logged out everywhere): a code instead
      if (saved?.device) this.dropDevice(saved.username);
      this.pending = { purpose: 'login', username: saved?.username || name, masked: r.maskedEmail, resendAt: Date.now() + (r.resendIn ?? RESEND_GAP) * 1000 };
      this.open('verify');
    } catch (e) {
      this.say('auLoginMsg', this.error(e));
    } finally {
      this.busy = false;
      $('auLoginGo').classList.remove('busy');
    }
  }

  dropDevice(name) {
    const a = this.find(name);
    if (a) delete a.device;
    write(SAVED, this.saved);
  }

  // the × on a tile: off this device's list, and its device token stops working
  forget(name) {
    const a = this.find(name);
    if (!a) return;
    this.game.audio.play('click');
    if (a.device) this.call('/auth/forget', { username: a.username, deviceToken: a.device }).catch(() => { /* it expires unused */ });
    this.saved = this.saved.filter((x) => x !== a);
    write(SAVED, this.saved);
    this.renderTiles();
  }

  // ---------- Create Account ----------
  async checkName(name) {
    try {
      const r = await this.call('/auth/check-name', { username: name });
      if (this.nameCheck.name !== name) return;
      this.nameCheck.state = r.available ? 'ok' : r.reason || 'taken';
    } catch (e) {
      if (this.nameCheck.name !== name) return;
      this.nameCheck.state = 'error';
      this.say('auSignupMsg', this.error(e));
    }
    this.renderSignup();
  }

  renderSignup() {
    const { name, state } = this.nameCheck;
    const mail = $('auSMail').value.trim();
    const mailOk = mail.length <= EMAIL_MAX && EMAIL_RE.test(mail);
    const nameOk = state === 'ok' && name === $('auSUser').value.trim();
    const bad = ['taken', 'not_allowed', 'format'].includes(state);
    $('auSUser').classList.toggle('ok', nameOk);
    $('auSUser').classList.toggle('bad', bad);
    $('auSUserTag').textContent = nameOk ? 'AVAILABLE' : state === 'taken' ? 'TAKEN' : '';
    $('auSUserTag').className = 'atag ' + (nameOk ? 'ok' : 'bad');
    const base = name.slice(0, 14);
    $('auSUserHint').textContent = state === 'taken' ? `That name is taken. Try ${base}7 or ${base}GT.`
      : state === 'not_allowed' ? 'That name isn\'t allowed. Try another.'
        : state === 'format' && /[^A-Za-z0-9_]/.test(name) ? 'Only letters, numbers and _, with no spaces.' : NAME_HINT;
    $('auSUserHint').classList.toggle('bad', bad);
    $('auSMail').classList.toggle('ok', mailOk);
    $('auSMail').classList.toggle('bad', !mailOk && this.mailTouched);
    $('auSignupGo').disabled = !(nameOk && mailOk) || this.busy;
  }

  async signup() {
    if ($('auSignupGo').disabled || this.busy) return;
    this.game.audio.play('click');
    this.busy = true;
    this.renderSignup();
    this.say('auSignupMsg', 'Creating your account…', false);
    try {
      const r = await this.call('/auth/signup', { username: $('auSUser').value.trim(), email: $('auSMail').value.trim() });
      this.busy = false;
      $('auSUser').value = $('auSMail').value = '';
      this.nameCheck = { name: '', state: '' };
      this.mailTouched = false;
      this.say('auSignupMsg', '');
      this.renderSignup();
      return this.signedIn(r, r.deviceToken);
    } catch (e) {
      this.busy = false;
      if (e.code === 'name_taken' || e.code === 'name_not_allowed') this.nameCheck.state = e.code === 'name_taken' ? 'taken' : 'not_allowed';
      this.say('auSignupMsg', this.error(e));
      this.renderSignup();
    }
  }

  // ---------- Verify ----------
  renderVerify() {
    const P = this.pending;
    const email = P.purpose === 'email';
    $('auVTitle').textContent = email ? 'Confirm email' : 'New device';
    $('auVText').innerHTML = email ? `We sent a 6-digit code to<br><b>${esc(P.masked)}</b>`
      : `Hi <b>${esc(P.username)}</b>. We sent a 6-digit code to<br><b>${esc(P.masked)}</b>`;
    $('auRememberRow').classList.toggle('hidden', email);
    $('auNotYou').textContent = email ? 'Cancel' : 'Not you?';
    this.renderResend();
  }

  renderResend() {
    if (!this.pending) return;
    const left = Math.max(0, Math.ceil((this.pending.resendAt - Date.now()) / 1000));
    const b = $('auResend');
    const text = left ? `Resend in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Resend code';
    if (b.textContent !== text) b.textContent = text;
    b.disabled = left > 0 || this.busy;
  }

  fill(v, from) {
    const ds = this.digits;
    for (let k = 0; k < v.length && from + k < ds.length; k++) { ds[from + k].value = v[k]; ds[from + k].classList.add('on'); }
    $('auDigits').classList.remove('bad');
    ds[Math.min(from + v.length, ds.length - 1)].focus();
    this.autoSubmit();
  }

  code() { return this.digits.map((d) => d.value).join(''); }

  // all six in: confirm without waiting for the button
  autoSubmit() { if (this.code().length === LOGIN_CODE_LEN) this.verify(); }

  async verify() {
    const P = this.pending;
    if (!P || this.busy) return;
    const code = this.code();
    if (!/^\d{6}$/.test(code)) return this.say('auVerifyMsg', 'Enter all 6 digits.');
    this.busy = true;
    $('auVerifyGo').classList.add('busy');
    this.say('auVerifyMsg', 'Checking…', false);
    try {
      if (P.purpose === 'email') {
        const r = await this.call('/auth/email/verify', { code }, this.token);
        this.session.email = r.account.email;
        write(SESSION, this.session);
        this.busy = false;
        this.renderSettings('Email changed.');
        this.close();
      } else {
        const remember = $('auRemember').checked;
        const r = await this.call('/auth/verify', { username: P.username, code, remember });
        this.signedIn(r, r.deviceToken);
      }
    } catch (e) {
      if (e.code === 'session') return this.expired();
      this.say('auVerifyMsg', this.error(e));
      $('auDigits').classList.add('bad');
      this.digits.forEach((d) => { d.value = ''; d.classList.remove('on'); });
      if (e.code === 'bad_code') this.digits[0].focus();
    } finally {
      this.busy = false;
      $('auVerifyGo').classList.remove('busy');
      this.renderResend();
    }
  }

  async resend() {
    const P = this.pending;
    if (!P || this.busy || Date.now() < P.resendAt) return;
    this.game.audio.play('click');
    this.busy = true;
    this.say('auVerifyMsg', 'Sending a new code…', false);
    try {
      const r = P.purpose === 'email' ? await this.call('/auth/email', { email: P.email }, this.token) : await this.call('/auth/resend', { username: P.username });
      P.resendAt = Date.now() + (r.resendIn ?? RESEND_GAP) * 1000;
      this.say('auVerifyMsg', 'New code sent. The old one no longer works.', false);
      this.digits.forEach((d) => { d.value = ''; d.classList.remove('on'); });
      $('auDigits').classList.remove('bad');
      if (!touch()) this.digits[0].focus();
    } catch (e) {
      if (e.retryIn) P.resendAt = Date.now() + e.retryIn * 1000;
      if (e.code === 'session') return this.expired();
      this.say('auVerifyMsg', this.error(e));
    } finally {
      this.busy = false;
      this.renderResend();
    }
  }

  // ---------- Settings: the account ----------
  async changeEmail() {
    const email = $('auNewMail').value.trim();
    if (!(email.length <= EMAIL_MAX && EMAIL_RE.test(email))) return this.say('auEmailMsg', ERRORS.bad_email);
    if (this.busy) return;
    this.busy = true;
    this.say('auEmailMsg', 'Sending a code…', false);
    try {
      const r = await this.call('/auth/email', { email }, this.token);
      this.pending = { purpose: 'email', username: this.user, email, masked: r.maskedEmail, resendAt: Date.now() + (r.resendIn ?? RESEND_GAP) * 1000 };
      this.busy = false;
      this.open('verify');
    } catch (e) {
      this.busy = false;
      if (e.code === 'session') return this.expired();
      this.say('auEmailMsg', this.error(e));
    }
  }

  async logout(all) {
    const u = this.user;
    if (!u || this.busy) return;
    if (all && !confirm(`Log ${u} out everywhere? Every device, this one too, will need an emailed code to log in again.`)) return;
    this.game.audio.play('click');
    this.busy = true;
    this.renderSettings(all ? 'Logging out everywhere…' : '');
    try {
      await this.call(all ? '/auth/logout-all' : '/auth/logout', {}, this.token);
    } catch (e) {
      // logging out of this device works offline too; everywhere needs the server
      if (all && e.code !== 'session') { this.busy = false; return this.renderSettings(this.error(e), true); }
    }
    this.busy = false;
    if (all) this.dropDevice(u);
    this.endSession();
    this.game.online.leaveRoom();
    this.apply();
    this.game.closeSettings();
    this.open('login', all ? `${u} is logged out on every device.` : '', false);
  }

  renderSettings(msg = '', bad = false) {
    $('setAcct').classList.toggle('hidden', !this.base);
    if (!this.base) return;
    const u = this.user;
    $('acIn').classList.toggle('hidden', !u);
    $('acInBtns').classList.toggle('hidden', !u);
    $('acAll').classList.toggle('hidden', !u);
    $('acGuest').classList.toggle('hidden', !!u);
    if (u) {
      $('acName').textContent = u;
      $('acMail').textContent = this.session.email || '';
      avatar($('acAv'), u);
    }
    // not mid-race: logging in or out changes the driver
    const lobby = this.game.state === 'menu';
    for (const id of ['acEmail', 'acOut', 'acAll', 'acLogin', 'acSignup']) $(id).disabled = !lobby || this.busy;
    $('acMsg').textContent = msg || (lobby ? '' : 'Account changes wait until you\'re back in the lobby.');
    $('acMsg').classList.toggle('bad', bad);
  }
}
