// All sound effects and background music are synthesized live with WebAudio; no external assets
import { SONGS, Music } from './music.js';

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Simulated gear shifts: RPM cycles between 0.35 and 1 in each of six gears (speedRatio = speed / nitro top speed)
function engineRpm(speedRatio) {
  const gears = 6;
  const g = Math.min(gears - 1, Math.floor(speedRatio * gears * 0.999));
  const inGear = speedRatio * gears - g;
  return 0.3 + inGear * 0.7 * (0.75 + g * 0.05);
}

const TRAFFIC_VOICES = 4; // rivals heard at once (the nearest ones)

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.musicOn = true;
    this.sfxOn = true;
    this.sfxVol = 1; // player's volume settings, 0..1
    this.musicVol = 1;
    this.song = 0;
    this.nextNoteTime = 0;
    this.step = 0;
  }

  get songs() { return SONGS; }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9 * this.sfxVol;
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = this.musicOn ? 0.32 * this.musicVol : 0;
    this.music.connect(this.master);

    // Noise buffer
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.musicEngine = new Music(ctx, this.music, this.noise);
    this.musicEngine.setSong(SONGS[this.song]);

    // Engine: sawtooth + square, low-passed
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 900;
    this.engFilter.Q.value = 4;
    this.eng1 = ctx.createOscillator();
    this.eng1.type = 'sawtooth';
    this.eng2 = ctx.createOscillator();
    this.eng2.type = 'square';
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    this.eng1.connect(this.engFilter);
    this.eng2.connect(g2).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.sfx);
    this.eng1.start();
    this.eng2.start();

    // Drift tire squeal
    this.skidSrc = ctx.createBufferSource();
    this.skidSrc.buffer = this.noise;
    this.skidSrc.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2300;
    bp.Q.value = 3;
    this.skidFilter = bp;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidSrc.connect(bp).connect(this.skidGain).connect(this.sfx);
    this.skidSrc.start();

    // Sustained nitro whoosh
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = this.noise;
    this.windSrc.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 700;
    hp.Q.value = 0.7;
    this.windFilter = hp;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(hp).connect(this.windGain).connect(this.sfx);
    this.windSrc.start();

    // Crowd bed: a filtered roar with a slow swell; setCrowd() sets how loud the fans are
    this.crowdSrc = ctx.createBufferSource();
    this.crowdSrc.buffer = this.noise;
    this.crowdSrc.loop = true;
    this.crowdSrc.playbackRate.value = 0.7;
    const clp = ctx.createBiquadFilter();
    clp.type = 'lowpass';
    clp.frequency.value = 1900;
    const chp = ctx.createBiquadFilter();
    chp.type = 'highpass';
    chp.frequency.value = 280;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;
    const swell = ctx.createGain();
    swell.gain.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.25;
    lfo.connect(lfoAmt).connect(swell.gain);
    lfo.start();
    this.crowdSrc.connect(clp).connect(chp).connect(swell).connect(this.crowdGain).connect(this.sfx);
    this.crowdSrc.start();

    // Rivals' engines: the same synth as the player's, each voice with its own panner
    this.traffic = [];
    for (let i = 0; i < TRAFFIC_VOICES; i++) {
      const o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      const g2 = ctx.createGain();
      g2.gain.value = 0.35;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 3;
      const g = ctx.createGain();
      g.gain.value = 0;
      o1.connect(f);
      o2.connect(g2).connect(f);
      f.connect(g);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) g.connect(pan).connect(this.sfx);
      else g.connect(this.sfx);
      o1.start();
      o2.start();
      this.traffic.push({ o1, o2, f, g, pan, key: null });
    }

    this.schedTimer = setInterval(() => this.schedule(), 25);
  }

  setEngine(speedRatio, throttle, boosting, drifting, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const rpm = engineRpm(speedRatio);
    const base = 55 + rpm * 130 + (boosting ? 35 : 0);
    this.eng1.frequency.setTargetAtTime(base, t, 0.05);
    this.eng2.frequency.setTargetAtTime(base * 0.5, t, 0.05);
    this.engFilter.frequency.setTargetAtTime(500 + rpm * 1600 + (throttle > 0 ? 500 : 0), t, 0.08);
    this.engGain.gain.setTargetAtTime(active ? 0.085 + (throttle > 0 ? 0.05 : 0) : 0, t, 0.1);
    this.skidGain.gain.setTargetAtTime(drifting && active ? 0.13 : 0, t, 0.05);
    this.skidFilter.frequency.setTargetAtTime(1800 + speedRatio * 1200, t, 0.1);
    this.windGain.gain.setTargetAtTime(active ? speedRatio * 0.05 + (boosting ? 0.18 : 0) : 0, t, 0.15);
  }

  silence() {
    this.setEngine(0, 0, false, false, false);
    this.setTraffic([]);
  }

  // Rivals near the camera, nearest first: [{ key, ratio, throttle, boost, dist, pan, doppler, tone }].
  // Each keeps its voice while it stays in range so the pitch glides; the level falls off with distance,
  // distant engines lose their top end, and doppler (approach / recede pitch factor) makes a pass go "neeeow".
  setTraffic(list) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.traffic) if (v.key && !list.some((c) => c.key === v.key)) v.key = null;
    for (const c of list) {
      let v = this.traffic.find((x) => x.key === c.key);
      const fresh = !v;
      if (fresh) {
        v = this.traffic.find((x) => !x.key);
        if (!v) continue;
        v.key = c.key;
      }
      const rpm = engineRpm(c.ratio);
      const base = (55 + rpm * 130 + (c.boost ? 35 : 0)) * c.tone * c.doppler;
      const near = 6 / Math.max(c.dist, 6); // 1 within 6 m, then inverse-distance
      if (fresh) {
        v.o1.frequency.setValueAtTime(base, t);
        v.o2.frequency.setValueAtTime(base * 0.5, t);
      } else {
        v.o1.frequency.setTargetAtTime(base, t, 0.05);
        v.o2.frequency.setTargetAtTime(base * 0.5, t, 0.05);
      }
      v.f.frequency.setTargetAtTime((500 + rpm * 1600 + (c.throttle > 0 ? 400 : 0)) * (0.35 + 0.65 * Math.sqrt(near)), t, 0.08);
      v.g.gain.setTargetAtTime(this.sfxOn === false ? 0 : 0.11 * near * (0.65 + 0.35 * c.throttle), t, 0.06);
      if (v.pan) v.pan.pan.setTargetAtTime(c.pan, t, 0.05);
    }
    for (const v of this.traffic) if (!v.key) v.g.gain.setTargetAtTime(0, t, 0.15);
  }

  // A car going by close: a short rush of air, panned to its side (-1 left .. 1 right)
  whoosh(pan, k = 1) {
    if (!this.ctx || this.sfxOn === false) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.9;
    f.frequency.setValueAtTime(1500, t);
    f.frequency.exponentialRampToValueAtTime(420, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.24 * k, t + 0.07);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    src.connect(f).connect(g);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.sfx);
    } else g.connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 0.6);
  }

  // ---------- Sound effects ----------
  tone(freq, dur, type = 'sine', vol = 0.3, slide = 0, delay = 0) {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  noiseBurst(dur, freq, q, vol, type = 'bandpass', sweep = 0) {
    if (!this.ctx || !this.sfxOn) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.sfx);
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  }

  play(name, arg) {
    if (!this.ctx) return;
    switch (name) {
      case 'count': this.tone(660, 0.25, 'square', 0.18); break;
      case 'go': this.tone(1320, 0.6, 'square', 0.2); this.tone(990, 0.6, 'square', 0.1); break;
      case 'nitro':
        this.noiseBurst(0.9, 300, 0.8, 0.9, 'lowpass', 8);
        this.tone(90, 0.5, 'sawtooth', 0.25, 2.5);
        break;
      case 'small':
        this.noiseBurst(0.35, 900, 1, 0.6, 'bandpass', 3);
        this.tone(420, 0.18, 'triangle', 0.18, 2);
        break;
      case 'double':
        this.tone(880, 0.12, 'square', 0.12);
        this.tone(1320, 0.2, 'square', 0.12, 1, 0.08);
        break;
      case 'gauge':
        [1047, 1319, 1568].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.2, 1, i * 0.06));
        break;
      case 'crash':
        this.noiseBurst(0.35, 400, 0.8, Math.min(1, 0.3 + (arg || 0) * 0.03), 'lowpass', 0.3);
        this.tone(70, 0.25, 'sine', 0.4, 0.5);
        break;
      case 'scrape': this.noiseBurst(0.12, 3000, 2, 0.12); break;
      case 'lap': [784, 988, 1175].forEach((f, i) => this.tone(f, 0.22, 'square', 0.12, 1, i * 0.1)); break;
      case 'finish':
        [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, 0.3, 'square', 0.13, 1, i * 0.13));
        break;
      case 'pad': this.noiseBurst(0.4, 1500, 1, 0.5, 'bandpass', 3); this.tone(600, 0.25, 'sawtooth', 0.1, 2); break;
      case 'land': this.tone(80, 0.2, 'sine', 0.4, 0.6); this.noiseBurst(0.15, 300, 1, 0.3, 'lowpass'); break;
      case 'item': this.tone(880, 0.08, 'square', 0.12); this.tone(1175, 0.12, 'square', 0.12, 1, 0.07); break;
      case 'missile': this.noiseBurst(1.0, 500, 1, 0.5, 'bandpass', 4); break;
      case 'boom': this.noiseBurst(0.8, 200, 0.7, 1, 'lowpass', 0.2); this.tone(55, 0.6, 'sine', 0.5, 0.4); break;
      case 'banana': this.tone(300, 0.3, 'triangle', 0.25, 0.4); break;
      case 'shield': [660, 880, 1100].forEach((f, i) => this.tone(f, 0.25, 'sine', 0.15, 1, i * 0.05)); break;
      case 'click': this.tone(1200, 0.05, 'square', 0.08); break;
      case 'wrong': this.tone(220, 0.3, 'square', 0.1); break;
    }
  }

  // ---------- Crowd ----------
  setCrowd(level) {
    if (!this.ctx) return;
    this.crowdGain.gain.setTargetAtTime(this.sfxOn === false ? 0 : Math.min(0.3, level), this.ctx.currentTime, 0.4);
  }

  // a cheer: the roar swells through vowel-like formants, with whistles and scattered applause
  cheer(k = 1) {
    if (!this.ctx || this.sfxOn === false) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.25;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.32 * k, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.2 + k);
    for (const [f, q, v] of [[620, 2, 1], [1150, 3, 0.7], [2500, 4, 0.3]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(f * 0.85, t);
      bp.frequency.linearRampToValueAtTime(f * 1.1, t + 0.6);
      bp.Q.value = q;
      const gv = ctx.createGain();
      gv.gain.value = v;
      src.connect(bp).connect(gv).connect(g);
    }
    g.connect(this.sfx);
    src.start(t);
    src.stop(t + 3.4 + k);
    for (let i = 0; i < Math.round(2 * k + Math.random()); i++) this.tone(1800 + Math.random() * 900, 0.35, 'sine', 0.045, 1.3, Math.random() * 1.2);
    for (let i = 0; i < Math.round(16 * k); i++) this.clap(t + 0.3 + Math.random() * 1.8, 0.06 * k);
  }

  clap(at, vol) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 1400 + Math.random() * 900;
    hp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.06);
    src.connect(hp).connect(g).connect(this.sfx);
    src.start(at, Math.random());
    src.stop(at + 0.08);
  }

  // A short, stately brass anthem for the podium (an original tune, not any country's). Returns its length in seconds.
  anthem() {
    if (!this.ctx || this.sfxOn === false) return 0;
    const ctx = this.ctx, t0 = ctx.currentTime + 0.1, beat = 0.36;
    const brass = (at, midi, dur, vol) => {
      const f = NOTE(midi);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(500, at);
      lp.frequency.linearRampToValueAtTime(2600, at + 0.06);
      lp.frequency.exponentialRampToValueAtTime(1100, at + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.05);
      g.gain.setValueAtTime(vol * 0.8, at + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.12);
      lp.connect(g).connect(this.sfx);
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(lp);
        o.start(at);
        o.stop(at + dur + 0.2);
      }
    };
    const play = (line, vol) => {
      let t = t0;
      for (const [n, b] of line) {
        if (n) brass(t, n, b * beat * 0.95, vol);
        t += b * beat;
      }
      return t - t0;
    };
    const len = play([[67, 1], [67, 1], [72, 1.5], [71, 0.5], [69, 1], [67, 1], [72, 2], [74, 1], [76, 1.5], [74, 0.5], [72, 1], [71, 1], [72, 3]], 0.11);
    play([[52, 2], [53, 2], [52, 2], [55, 2], [57, 2], [53, 2], [55, 2], [48, 1]], 0.07); // harmony
    play([[36, 2], [41, 2], [36, 2], [43, 2], [45, 2], [41, 2], [43, 2], [36, 1]], 0.1); // bass
    return len;
  }

  // champagne: the cork pops, then the fizz hisses for a while
  champagne(dur = 4) {
    if (!this.ctx || this.sfxOn === false) return;
    this.tone(520, 0.07, 'square', 0.16, 0.4);
    this.noiseBurst(0.09, 2200, 1.2, 0.5);
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 3800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.15);
    g.gain.setValueAtTime(0.09, t + dur - 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  airHorn() {
    if (!this.ctx || this.sfxOn === false) return;
    [[440, 0], [554, 0], [440, 0.9], [554, 0.9]].forEach(([f, d]) => this.tone(f, 0.7, 'sawtooth', 0.07, 1, d));
  }

  // ---------- Background music (look-ahead scheduled step sequencer) ----------
  setSong(i) {
    this.song = ((i % SONGS.length) + SONGS.length) % SONGS.length;
    this.step = 0;
    if (this.ctx) {
      this.nextNoteTime = this.ctx.currentTime + 0.1;
      this.musicEngine.setSong(SONGS[this.song]);
    }
    return SONGS[this.song].name;
  }

  startMusic() {
    if (!this.ctx) return;
    this.playing = true;
    this.nextNoteTime = this.ctx.currentTime + 0.1;
  }

  stopMusic() { this.playing = false; }

  schedule() {
    if (!this.ctx || !this.playing || !this.musicOn) return;
    const song = SONGS[this.song];
    const spb = 60 / song.bpm / 4; // 16th note
    // Timers are throttled while the tab is in the background; don't flush the backlog of notes all at once on return
    if (this.nextNoteTime < this.ctx.currentTime - 0.2) this.nextNoteTime = this.ctx.currentTime + 0.05;
    while (this.nextNoteTime < this.ctx.currentTime + 0.12) {
      this.playStep(song, this.step, this.nextNoteTime, spb);
      this.nextNoteTime += spb;
      this.step++;
    }
  }

  playStep(song, step, t, spb) {
    this.musicEngine.playStep(song, step, t, spb);
  }

  setVolumes(sfx, music) {
    this.sfxVol = sfx;
    this.musicVol = music;
    if (!this.ctx) return;
    this.sfx.gain.setTargetAtTime(0.9 * sfx, this.ctx.currentTime, 0.05);
    this.music.gain.setTargetAtTime(this.musicOn ? 0.32 * music : 0, this.ctx.currentTime, 0.05);
  }

  toggleMusic() {
    this.musicOn = !this.musicOn;
    if (this.music) this.music.gain.setTargetAtTime(this.musicOn ? 0.32 * this.musicVol : 0, this.ctx.currentTime, 0.1);
    if (this.musicOn && this.ctx) this.nextNoteTime = this.ctx.currentTime + 0.1;
    return this.musicOn;
  }
}
