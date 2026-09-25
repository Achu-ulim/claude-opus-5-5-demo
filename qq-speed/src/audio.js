// All sound effects and background music are synthesized live with WebAudio; no external assets
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

const SONGS = [
  { name: 'Speed City', bpm: 128, root: 57, prog: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], lead: [0, 7, 12, 7, 10, 7, 3, 7], bassPat: [1, 0, 1, 1, 0, 1, 1, 0], style: 0 },
  { name: 'Aegean Breeze', bpm: 118, root: 62, prog: [[0, 4, 7], [-3, 0, 4], [5, 9, 12], [7, 11, 14]], lead: [12, 11, 7, 4, 7, 11, 12, 14], bassPat: [1, 0, 0, 1, 1, 0, 1, 0], style: 1 },
  { name: "Pharaoh's Trial", bpm: 132, root: 55, prog: [[0, 3, 7], [1, 5, 8], [0, 3, 7], [-2, 1, 5]], lead: [0, 1, 4, 5, 7, 8, 7, 4], bassPat: [1, 1, 0, 1, 1, 0, 1, 1], style: 2 },
  { name: 'Blizzard Rush', bpm: 140, root: 60, prog: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]], lead: [7, 12, 16, 12, 14, 12, 11, 7], bassPat: [1, 0, 1, 0, 1, 1, 1, 0], style: 3 },
];

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.musicOn = true;
    this.sfxOn = true;
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
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = 0.32;
    this.music.connect(this.master);

    // Noise buffer
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

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

    this.schedTimer = setInterval(() => this.schedule(), 25);
  }

  setEngine(speedRatio, throttle, boosting, drifting, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Simulated gear shifts: RPM cycles between 0.35 and 1 in each gear
    const gears = 6;
    const g = Math.min(gears - 1, Math.floor(speedRatio * gears * 0.999));
    const inGear = speedRatio * gears - g;
    const rpm = 0.3 + inGear * 0.7 * (0.75 + g * 0.05);
    const base = 55 + rpm * 130 + (boosting ? 35 : 0);
    this.eng1.frequency.setTargetAtTime(base, t, 0.05);
    this.eng2.frequency.setTargetAtTime(base * 0.5, t, 0.05);
    this.engFilter.frequency.setTargetAtTime(500 + rpm * 1600 + (throttle > 0 ? 500 : 0), t, 0.08);
    this.engGain.gain.setTargetAtTime(active ? 0.085 + (throttle > 0 ? 0.05 : 0) : 0, t, 0.1);
    this.skidGain.gain.setTargetAtTime(drifting && active ? 0.13 : 0, t, 0.05);
    this.skidFilter.frequency.setTargetAtTime(1800 + speedRatio * 1200, t, 0.1);
    this.windGain.gain.setTargetAtTime(active ? speedRatio * 0.05 + (boosting ? 0.18 : 0) : 0, t, 0.15);
  }

  silence() { this.setEngine(0, 0, false, false, false); }

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

  airHorn() {
    if (!this.ctx || this.sfxOn === false) return;
    [[440, 0], [554, 0], [440, 0.9], [554, 0.9]].forEach(([f, d]) => this.tone(f, 0.7, 'sawtooth', 0.07, 1, d));
  }

  // ---------- Background music (look-ahead scheduled step sequencer) ----------
  setSong(i) {
    this.song = ((i % SONGS.length) + SONGS.length) % SONGS.length;
    this.step = 0;
    if (this.ctx) this.nextNoteTime = this.ctx.currentTime + 0.1;
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
    const ctx = this.ctx;
    const bar = Math.floor(step / 16) % 4;
    const s16 = step % 16;
    const chord = song.prog[bar];
    const root = song.root;
    // Kick
    if (s16 % 4 === 0) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.connect(g).connect(this.music);
      o.start(t);
      o.stop(t + 0.2);
    }
    // Snare / clap
    if (s16 === 4 || s16 === 12) this.musicNoise(t, 0.12, 1800, 0.35, 'bandpass');
    // Hi-hat
    if (s16 % 2 === 1 || song.style === 3) this.musicNoise(t, 0.03, 8000, s16 % 4 === 2 ? 0.18 : 0.1, 'highpass');
    // Bass
    const bi = Math.floor(s16 / 2);
    if (s16 % 2 === 0 && song.bassPat[bi % 8]) {
      const n = root - 24 + chord[0] + (bi % 4 === 3 ? 12 : 0);
      this.musicTone(t, NOTE(n), spb * 1.8, 'sawtooth', 0.22, 600);
    }
    // Chord pad (every bar)
    if (s16 === 0)
      for (const c of chord) this.musicTone(t, NOTE(root + c), spb * 15, song.style === 1 ? 'triangle' : 'sawtooth', 0.045, 1400, true);
    // Arpeggiated lead
    if (s16 % 2 === 0) {
      const li = (s16 / 2 + bar * 2) % song.lead.length;
      const n = root + 12 + chord[0] + song.lead[li];
      this.musicTone(t, NOTE(n), spb * 1.6, song.style === 2 ? 'triangle' : 'square', 0.06, 3000);
    }
  }

  musicTone(t, f, dur, type, vol, cutoff, pad = false) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const fl = this.ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + (pad ? 0.2 : 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(fl).connect(g).connect(this.music);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  musicNoise(t, dur, f, vol, type) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const fl = this.ctx.createBiquadFilter();
    fl.type = type;
    fl.frequency.value = f;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl).connect(g).connect(this.music);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.02);
  }

  toggleMusic() {
    this.musicOn = !this.musicOn;
    if (this.music) this.music.gain.setTargetAtTime(this.musicOn ? 0.32 : 0, this.ctx.currentTime, 0.1);
    if (this.musicOn && this.ctx) this.nextNoteTime = this.ctx.currentTime + 0.1;
    return this.musicOn;
  }
}
