// WebSocket link to the multiplayer server: joins a room, keeps a clock synced to the server's,
// and rides out dropped connections by reconnecting with the seat token.
const RETRY_FOR = 45000; // ms of reconnect attempts before giving up
const RELIABLE = new Set(['lap', 'quit', 'set']); // sent late rather than never if the link is down

export class NetClient {
  constructor(url) {
    this.url = url.replace(/^http/, 'ws').replace(/\/+$/, '');
    this.handlers = new Map();
    this.ws = null;
    this.id = null;
    this.token = null;
    this.code = null;
    this.offset = null;
    this.rtt = 0;
    this.samples = [];
    this.queue = [];
    this.status = 'idle';
  }

  on(type, fn) { this.handlers.set(type, fn); return this; }
  emit(type, msg) { this.handlers.get(type)?.(msg); }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  // action: 'create' | 'quick' | 'join'. Resolves with the welcome, rejects with { code } (not_found, full, unreachable, ...)
  connect(action, code, hello, token = null) {
    this.hello = hello;
    this.token = token;
    this.leaving = false;
    this.fatal = null;
    this.lostAt = 0;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.open(action, code);
    });
  }

  open(action, code) {
    const u = new URL(this.url + '/ws');
    u.searchParams.set('action', action);
    if (code) u.searchParams.set('room', code);
    let ws;
    try { ws = new WebSocket(u); } catch { return this.fail('unreachable'); }
    this.ws = ws;
    this.setStatus(this.id ? 'reconnecting' : 'connecting');
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', ...this.hello, token: this.token }));
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = (e) => this.onClose(ws, e);
  }

  onMessage(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'pong') return this.onPong(m);
    if (m.t === 'welcome') {
      this.id = m.id;
      this.token = m.token;
      this.code = m.code;
      this.lostAt = 0;
      this.setStatus('online');
      this.startClock();
      const q = this.queue;
      this.queue = [];
      for (const x of q) this.send(x);
      if (this.pending) { this.pending.resolve(m); this.pending = null; }
      return this.emit('welcome', m);
    }
    if (m.t === 'error') {
      this.fatal = m.code;
      if (this.pending) { this.pending.reject(m); this.pending = null; }
      return this.emit('error', m);
    }
    this.emit(m.t, m);
  }

  onClose(ws, e) {
    if (ws !== this.ws) return;
    clearInterval(this.pingT);
    this.ws = null;
    // the same seat was taken over by another tab: reconnecting would just take it back and start a tug of war
    if (e.code === 4005 && !this.fatal) { this.fatal = 'replaced'; this.emit('error', { code: 'replaced' }); }
    if (this.leaving || this.fatal) return this.setStatus('offline');
    // never got in: nothing to resume
    if (!this.id) return this.fail('unreachable');
    if (!this.lostAt) this.lostAt = performance.now();
    if (performance.now() - this.lostAt > RETRY_FOR) {
      this.setStatus('offline');
      return this.emit('lost', {});
    }
    this.setStatus('reconnecting');
    this.tries = (this.tries || 0) + 1;
    clearTimeout(this.retryT);
    this.retryT = setTimeout(() => this.open('join', this.code), Math.min(4000, 300 * 2 ** Math.min(this.tries, 4)));
  }

  fail(code) {
    this.setStatus('offline');
    if (this.pending) { this.pending.reject({ code }); this.pending = null; }
  }

  get online() { return this.status === 'online' && this.ws?.readyState === WebSocket.OPEN; }

  send(msg) {
    if (this.online) this.ws.send(JSON.stringify(msg));
    else if (RELIABLE.has(msg.t) && this.status === 'reconnecting') this.queue.push(msg);
  }

  leave() {
    this.leaving = true;
    clearTimeout(this.retryT);
    clearInterval(this.pingT);
    if (this.online) this.ws.send(JSON.stringify({ t: 'leave' }));
    try { this.ws?.close(1000); } catch { /* ignore */ }
    this.ws = null;
    this.id = null;
    this.setStatus('offline');
  }

  // ---------- Clock ----------
  // NTP-style: the sample with the lowest round trip gives the best offset; later samples nudge it rather than jump,
  // so race clocks never visibly step
  startClock() {
    this.tries = 0;
    clearInterval(this.pingT);
    for (let i = 0; i < 6; i++) setTimeout(() => this.ping(), i * 150);
    this.pingT = setInterval(() => this.ping(), 2000);
  }

  ping() { if (this.online) this.ws.send(JSON.stringify({ t: 'ping', c: performance.now() })); }

  onPong(m) {
    const now = performance.now();
    const rtt = now - m.c;
    if (!(rtt >= 0 && rtt < 10000)) return;
    this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
    this.samples.push({ rtt, off: m.s + rtt / 2 - now });
    if (this.samples.length > 12) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    if (this.offset == null || Math.abs(best.off - this.offset) > 300) this.offset = best.off;
    else this.offset += (best.off - this.offset) * 0.25;
    this.emit('clock', {});
  }

  // server time (ms) now
  now() { return performance.now() + (this.offset ?? Date.now() - performance.now()); }
}
