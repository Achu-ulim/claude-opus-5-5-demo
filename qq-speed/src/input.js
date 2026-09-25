// Controls: match the QQ Speed PC client defaults as closely as possible
// ↑↓←→ drive · Shift drift · Ctrl nitro/item · ↑ (tap on corner exit) or W mini boost · Alt swap items · R reset
const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'AltLeft', 'AltRight', 'PageUp', 'PageDown', 'Tab', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyW', 'KeyR']);

const RAD = Math.PI / 180;
const TILT_DEAD = 2; // degrees of lean ignored around the center (hand tremor)
const TILT_FULL = 20; // degrees of lean for full steering lock: tilt all the way, turn all the way

export class Input {
  constructor() {
    this.steerMode = 'buttons'; // 'buttons' | 'tilt' | 'swipe'
    this.tiltRaw = null;
    this.tiltZero = 0;
    this.swipeAxis = 0;
    this.down = new Set();
    this.pressed = new Set();
    this.touch = { up: false, down: false, left: false, right: false, shift: false };
    this.touchPressed = new Set();
    this.onKey = null; // Callback for non-driving keys (pause, camera, etc.)
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (PREVENT.has(e.code)) e.preventDefault();
      if (e.ctrlKey && (e.code === 'KeyW' || e.code === 'KeyR')) e.preventDefault();
      if (!e.repeat) {
        this.pressed.add(e.code);
        if (this.onKey) this.onKey(e.code, e);
      }
      this.down.add(e.code);
    }, { passive: false });
    window.addEventListener('keyup', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      this.down.delete(e.code);
    });
    window.addEventListener('blur', () => this.down.clear());
  }

  has(...codes) { return codes.some((c) => this.down.has(c)); }
  was(...codes) { return codes.some((c) => this.pressed.has(c) || this.touchPressed.has(c)); }

  // Build driving input once per frame (edge-triggered values only last for this frame)
  frame() {
    const t = this.touch;
    const left = this.has('ArrowLeft') || t.left, right = this.has('ArrowRight') || t.right;
    // analog steering: + = left, like the digital (left - right); keys and buttons override motion steering
    const digital = (left ? 1 : 0) - (right ? 1 : 0);
    const motion = digital !== 0 ? 0 : this.motionAxis();
    const steer = digital !== 0 ? digital : -motion;
    const inp = {
      up: this.has('ArrowUp') || t.up,
      down: this.has('ArrowDown') || t.down,
      left: steer > 0.3,
      right: steer < -0.3,
      steer,
      analog: digital === 0 && this.steerMode !== 'buttons',
      shift: this.has('ShiftLeft', 'ShiftRight') || t.shift,
      upPressed: this.was('ArrowUp', 'TouchBoost'),
      wPressed: this.was('KeyW'),
      nitroPressed: this.was('ControlLeft', 'ControlRight', 'Space', 'TouchNitro'),
      swapPressed: this.was('AltLeft', 'AltRight', 'TouchSwap'),
      resetPressed: this.was('KeyR'),
      boxPressed: this.was('KeyB', 'TouchBox'),
    };
    this.pressed.clear();
    this.touchPressed.clear();
    return inp;
  }

  // Motion steering amount, -1 (full left) .. 1 (full right)
  motionAxis() {
    if (this.steerMode === 'swipe') return this.swipeAxis;
    if (this.steerMode !== 'tilt' || this.tiltRaw == null) return 0;
    const deg = this.tiltRaw - this.tiltZero;
    const m = Math.min(1, Math.max(0, Math.abs(deg) - TILT_DEAD) / (TILT_FULL - TILT_DEAD));
    return Math.sign(deg) * Math.pow(m, 1.1); // near-linear: the car turns as much as you tilt
  }

  // Tilt: project gravity onto the screen's horizontal axis. That reading is the same whether the phone is held flat,
  // angled, or upright like a steering wheel, in portrait or landscape. iOS only asks for permission inside a tap.
  async enableTilt() {
    if (this.onOrient) return true; // already listening; iOS remembers the grant for the page
    const D = window.DeviceOrientationEvent;
    if (!D || !window.isSecureContext) return false;
    if (typeof D.requestPermission === 'function') {
      try { if ((await D.requestPermission()) !== 'granted') return false; } catch { return false; }
    }
    if (!this.onOrient) {
      this.onOrient = (e) => {
        if (e.beta == null || e.gamma == null) return;
        const b = e.beta * RAD, g = e.gamma * RAD;
        // "down" in device coordinates is (cos b * sin g, -sin b, -cos b * cos g); rotate x/y into screen space
        const dx = Math.cos(b) * Math.sin(g), dy = -Math.sin(b);
        const ang = (screen.orientation?.angle ?? window.orientation ?? 0) * RAD;
        const sx = dx * Math.cos(ang) - dy * Math.sin(ang);
        const deg = Math.asin(Math.max(-1, Math.min(1, sx))) / RAD;
        // light low-pass against sensor jitter; the car's own steering damping smooths the rest
        this.tiltRaw = this.tiltRaw == null ? deg : this.tiltRaw + (deg - this.tiltRaw) * 0.6;
      };
      window.addEventListener('deviceorientation', this.onOrient);
    }
    return true;
  }

  centerTilt() { if (this.tiltRaw != null) this.tiltZero = this.tiltRaw; }

  // Swipe: drag sideways anywhere on the pad; steering follows the finger's distance from where it landed
  bindSwipe(el) {
    const knob = el.querySelector('i');
    let id = null, x0 = 0;
    const range = () => Math.max(50, Math.min(140, window.innerWidth * 0.1));
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (id != null) return;
      const t = e.changedTouches[0];
      id = t.identifier;
      x0 = t.clientX;
      const r = el.getBoundingClientRect();
      knob.style.left = t.clientX - r.left + 'px';
      knob.style.top = t.clientY - r.top + 'px';
      knob.style.transform = 'translate(-50%,-50%)';
      el.classList.add('on');
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== id) continue;
        const R = range();
        let dx = t.clientX - x0;
        // drag the anchor along past full lock, so reversing direction responds at once
        if (Math.abs(dx) > R) { x0 = t.clientX - Math.sign(dx) * R; dx = Math.sign(dx) * R; }
        this.swipeAxis = dx / R;
        knob.style.transform = `translate(calc(-50% + ${dx}px),-50%)`;
      }
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) if (t.identifier === id) { id = null; this.swipeAxis = 0; el.classList.remove('on'); }
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }

  // Touch buttons
  bindTouch(root) {
    const btn = (sel, key, edge) => {
      const el = root.querySelector(sel);
      if (!el) return;
      const on = (e) => {
        e.preventDefault();
        el.classList.add('on');
        if (key) this.touch[key] = true;
        if (edge) this.touchPressed.add(edge);
      };
      const off = (e) => {
        e.preventDefault();
        el.classList.remove('on');
        if (key) this.touch[key] = false;
      };
      el.addEventListener('touchstart', on, { passive: false });
      el.addEventListener('touchend', off, { passive: false });
      el.addEventListener('touchcancel', off, { passive: false });
    };
    btn('#t-left', 'left');
    btn('#t-right', 'right');
    btn('#t-drift', 'shift');
    btn('#t-brake', 'down');
    btn('#t-nitro', null, 'TouchNitro');
    btn('#t-boost', null, 'TouchBoost');
    btn('#t-swap', null, 'TouchSwap');
    btn('#t-box', null, 'TouchBox');
    btn('#t-gas', 'up');
    this.bindSwipe(root.querySelector('#t-swipe'));
    const c = root.querySelector('#t-center');
    // a tap is also the moment iOS allows the permission prompt, if it was never granted
    c.addEventListener('touchstart', (e) => { e.preventDefault(); this.enableTilt(); this.centerTilt(); c.classList.add('on'); setTimeout(() => c.classList.remove('on'), 200); }, { passive: false });
  }
}
