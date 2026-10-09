// Background music: original arcade-racing songs played live by a small WebAudio synth.
// Each song has sections (intro, verse, chorus, break) built from a chord progression, a melody and a style
// that sets the drums, bass and instruments. Nothing is sampled, so it all works offline.
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Chords as semitones above the song's root
const CH = {
  I: [0, 4, 7], ii: [2, 5, 9], iii: [4, 7, 11], IV: [5, 9, 12], V: [7, 11, 14], vi: [-3, 0, 4],
  i: [0, 3, 7], bII: [1, 5, 8], III: [3, 7, 10], iv: [5, 8, 12], v: [7, 10, 14], VI: [-4, 0, 3], VII: [-2, 2, 5],
  Imaj7: [0, 4, 7, 11], IVmaj7: [5, 9, 12, 16], iii7: [4, 7, 11, 14], vi7: [-3, 0, 4, 7], ii7: [2, 5, 9, 12], V7: [7, 11, 14, 17],
};

// Melody bars: 16 tokens (16th notes) or 8 tokens (8th notes). A number is semitones above the lead octave,
// "-" holds the previous note, "." is a rest.
function parseBar(str) {
  const tok = str.trim().split(/\s+/);
  if (tok.length !== 16 && tok.length !== 8) throw new Error(`melody bar needs 8 or 16 notes: "${str}"`);
  const k = 16 / tok.length;
  const out = new Array(16).fill(null);
  let last = null;
  tok.forEach((x, i) => {
    if (x === '-') { if (last) last.len += k; return; }
    if (x === '.') { last = null; return; }
    last = { n: +x, len: k };
    out[i * k] = last;
  });
  return out;
}

const STYLES = {
  // Initial D-style Eurobeat: four on the floor, offbeat open hats, octave-jumping bass, brass stabs
  eurobeat: { kick: 'x...x...x...x...', clap: '....x.......x...', oh: '..x...x...x...x.', bass: 'oct', bassP: 'sawBass', stab: 'x..x..x...x..x..', stabP: 'brass', pad: 'pad', duck: true, lead: 'supersaw' },
  // City pop: laid-back groove, slap-style bass, electric piano comping
  citypop: { kick: 'x.....x...x.....', snare: '....x.......x...', ch: 'x.x.x.x.x.x.x.x.', bass: 'funk', bassP: 'roundBass', stab: '..x..x....x..x..', stabP: 'epiano', lead: 'bell' },
  // Breakbeat with a desert scale
  breakbeat: { kick: 'x.....x...x..x..', snare: '....x.......x...', ch: 'x.x.x.x.x.x.x.x.', bass: 'syncopated', bassP: 'sawBass', pad: 'pad', arp: 'pluck', lead: 'reed' },
  // Uplifting trance: rolling offbeat bass, 16th arps, supersaw anthem
  trance: { kick: 'x...x...x...x...', clap: '....x.......x...', ch: 'xxxxxxxxxxxxxxxx', oh: '..x...x...x...x.', bass: 'roll', bassP: 'sawBass', pad: 'pad', arp: 'pluck', duck: true, lead: 'supersaw' },
  // OutRun-style synthwave: gated reverb snare, 16th pluck bass, square lead with vibrato
  synthwave: { kick: 'x.......x.x.....', snare: '....x.......x...', ch: 'x.x.x.x.x.x.x.x.', bigSnare: true, bass: 'sixteenths', bassP: 'pluckBass', pad: 'pad', arp: 'chipArp', arpRate: 2, duck: true, lead: 'square' },
  // Chiptune: pulse waves, triangle bass, noise drums
  chip: { kick: 'x.....x.x.......', snare: '....x.......x..x', ch: 'x.x.x.x.x.x.x.x.', chip: true, bass: 'alt', bassP: 'triBass', arp: 'chipArp', lead: 'pulse' },
  // Drum & bass: two-step beat, reese bass
  dnb: { kick: 'x.........x.....', snare: '....x.......x...', ghost: '.......x.x....x.', ch: 'x.xxx.x.x.xxx.x.', bass: 'long', bassP: 'reese', pad: 'pad', lead: 'supersaw' },
};

// Instruments: oscillators ([type, cents, frequency multiple, level]), filter, envelope, effect sends
const P = {
  supersaw: { osc: [['sawtooth', -14, 1, 0.5], ['sawtooth', 0, 1, 0.5], ['sawtooth', 14, 1, 0.5], ['square', 0, 0.5, 0.25]], cut: 3800, a: 0.01, r: 0.12, dly: 0.25, rev: 0.25 },
  square: { osc: [['square', 0, 1, 1]], cut: 3000, a: 0.01, r: 0.1, vib: 9, dly: 0.35, rev: 0.25 },
  pulse: { osc: [['square', 0, 1, 1]], cut: 9000, a: 0.002, r: 0.03, dly: 0.12 },
  reed: { osc: [['sawtooth', 0, 1, 0.7], ['square', 5, 1, 0.4]], cut: 2200, q: 2, a: 0.03, r: 0.1, vib: 18, dly: 0.2, rev: 0.3 },
  bell: { osc: [['sine', 0, 1, 1], ['sine', 0, 2, 0.35], ['triangle', 0, 4, 0.08]], cut: 6000, a: 0.004, decay: 0.9, sus: 0.25, r: 0.25, dly: 0.2, rev: 0.3 },
  pluck: { osc: [['sawtooth', -6, 1, 0.6], ['sawtooth', 6, 1, 0.6]], cut: 600, fenv: [4200, 500, 0.22], a: 0.003, decay: 0.25, sus: 0.15, r: 0.08, dly: 0.25, rev: 0.2 },
  chipArp: { osc: [['square', 0, 1, 1]], cut: 7000, a: 0.002, decay: 0.12, sus: 0.3, r: 0.03 },
  brass: { osc: [['sawtooth', -8, 1, 0.6], ['sawtooth', 8, 1, 0.6]], cut: 900, fenv: [3000, 1100, 0.15], a: 0.005, decay: 0.15, sus: 0.4, r: 0.06, rev: 0.15 },
  epiano: { osc: [['sine', 0, 1, 1], ['triangle', 0, 2, 0.25]], cut: 5000, a: 0.004, decay: 0.5, sus: 0.3, r: 0.15, rev: 0.25 },
  pad: { osc: [['sawtooth', -10, 1, 0.5], ['sawtooth', 10, 1, 0.5]], cut: 1300, a: 0.25, r: 0.4, rev: 0.45 },
  sawBass: { osc: [['sawtooth', 0, 1, 0.8], ['square', 0, 0.5, 0.5]], cut: 500, fenv: [1600, 420, 0.12], q: 3, a: 0.003, decay: 0.15, sus: 0.6, r: 0.04 },
  pluckBass: { osc: [['sawtooth', 0, 1, 1]], cut: 400, fenv: [1800, 300, 0.1], q: 4, a: 0.002, decay: 0.12, sus: 0.3, r: 0.03 },
  roundBass: { osc: [['triangle', 0, 1, 1], ['square', 0, 1, 0.25]], cut: 1100, a: 0.004, decay: 0.2, sus: 0.6, r: 0.05 },
  triBass: { osc: [['triangle', 0, 1, 1]], cut: 8000, a: 0.002, r: 0.02 },
  reese: { osc: [['sawtooth', -18, 1, 0.7], ['sawtooth', 18, 1, 0.7], ['sine', 0, 0.5, 0.8]], cut: 360, q: 2, a: 0.02, r: 0.1 },
};

const song = (s) => {
  for (const sec of Object.values(s.sections)) {
    sec.chordList = sec.chords.split(/\s+/).map((c) => CH[c]);
    sec.melody = sec.mel ? sec.mel.map(parseBar) : null;
  }
  // flatten the form into bars; after the last section it loops back to form[loop]
  s.bars = [];
  s.form.forEach((name, fi) => {
    if (fi === s.loop) s.loopBar = s.bars.length;
    const sec = s.sections[name];
    for (let i = 0; i < sec.bars; i++) s.bars.push({ sec, i, next: s.sections[s.form[fi + 1] ?? s.form[s.loop]] });
  });
  return s;
};

export const SONGS = [
  song({
    name: 'Speed City', style: 'eurobeat', bpm: 156, root: 57, loop: 1,
    form: ['I', 'A', 'B', 'C', 'A', 'B', 'B'],
    sections: {
      I: { bars: 4, chords: 'i VI VII i', drums: 'kick' },
      A: { bars: 8, chords: 'i VI VII i', mel: [
        '12 . 12 . 10 . 12 . 15 - - 14 - 12 . .', '12 . 12 . 10 . 8 . 7 - - - . . . .',
        '10 . 10 . 12 . 14 . 15 - - 14 - 12 . .', '12 - - - - - - - . . 7 . 10 . 12 .',
        '12 . 12 . 10 . 12 . 15 - - 14 - 12 . .', '12 . 12 . 10 . 8 . 7 - - - . . . .',
        '10 . 10 . 12 . 14 . 15 - - 14 - 12 . .', '12 - - - . . . . 14 . 15 . 17 . 19 .'] },
      B: { bars: 8, chords: 'VI VII v i', roll: true, mel: [
        '15 - 14 - 12 - 10 12', '14 - 12 - 10 - 7 10', '12 - 10 - 7 - 10 12', '12 - - - - - 7 10',
        '15 - 14 - 12 - 15 17', '19 - 17 - 15 - 14 15', '14 - 12 - 10 - 12 14', '12 - - - - - . .'] },
      C: { bars: 4, chords: 'VI VII v i', drums: 'none', bass: false, riser: true },
    },
  }),
  song({
    name: 'Aegean Breeze', style: 'citypop', bpm: 112, root: 62, loop: 1,
    form: ['I', 'A', 'B', 'A', 'B'],
    sections: {
      I: { bars: 4, chords: 'Imaj7 IVmaj7 iii7 vi7', drums: 'half' },
      A: { bars: 8, chords: 'Imaj7 IVmaj7 iii7 vi7', mel: [
        '4 . 7 . 11 - - 9 - - 7 . . . . .', '9 . 12 . 16 - - 14 - - 12 . . . . .',
        '11 . 9 . 7 . 11 - - 9 . 7 4 . . .', '4 - - - - - 2 - 0 - - - . . . .',
        '4 . 7 . 11 - - 9 - - 7 . . . . .', '9 . 12 . 16 - - 14 - - 12 . . . . .',
        '11 . 12 . 14 . 16 - - 14 . 12 . 11 . .', '9 - - - - - - - . . . . . . . .'] },
      B: { bars: 8, chords: 'IVmaj7 V7 iii7 vi7 ii7 V7 Imaj7 Imaj7', mel: [
        '12 - 14 - 16 - 14 12', '14 - - 12 11 - 9 -', '11 - 12 - 14 - 11 9', '9 - - - 7 - 4 -',
        '5 - 9 - 12 - 14 -', '17 - 16 - 14 - 12 11', '12 - - - - - - -', '. . 7 9 11 - 12 -'] },
    },
  }),
  song({
    name: "Pharaoh's Trial", style: 'breakbeat', bpm: 132, root: 52, loop: 1,
    form: ['I', 'A', 'B', 'C', 'A', 'B'],
    sections: {
      I: { bars: 4, chords: 'I bII I iv', drums: 'half' },
      A: { bars: 8, chords: 'I bII I iv', mel: [
        '12 - 13 - 12 - 8 - 7 - - - 8 7 5 4', '5 - - - 4 - 1 - 0 - - - . . . .',
        '7 . 8 . 7 . 4 . 5 - 4 - 1 - 0 -', '0 - - - - - - - . . . . 4 5 7 8'] },
      B: { bars: 8, chords: 'iv bII I I', roll: true, mel: [
        '12 - 13 - 12 8 5 -', '8 - 7 - 5 - 1 -', '4 - 5 - 7 - 8 7', '4 - - - - - . .',
        '12 - 13 - 16 - 13 12', '13 - 12 - 8 - 5 8', '7 - 4 - 5 - 1 -', '0 - - - - - - -'] },
      C: { bars: 4, chords: 'I bII I bII', drums: 'half', bass: false, riser: true },
    },
  }),
  song({
    name: 'Blizzard Rush', style: 'trance', bpm: 138, root: 60, loop: 1,
    form: ['I', 'A', 'B', 'C', 'B', 'B'],
    sections: {
      I: { bars: 4, chords: 'vi IV I V', drums: 'kick', bass: false },
      A: { bars: 8, chords: 'vi IV I V', lead: 'pluck', mel: [
        '9 - 12 - 16 - 12 -', '9 - 12 - 17 - 12 -', '7 - 12 - 16 - 12 -', '7 - 11 - 14 - 11 -'] },
      B: { bars: 8, chords: 'vi IV I V', roll: true, mel: [
        '16 - - 14 - - 12 -', '17 - - 16 - - 12 -', '16 - - 14 - - 12 14', '14 - - - 11 - 12 14',
        '16 - - 14 - - 12 -', '17 - - 19 - - 21 -', '19 - - 17 - - 16 14', '14 - - - - - - -'] },
      C: { bars: 8, chords: 'vi IV I V', drums: 'none', bass: false, riser: true, mel: [
        '16 - - 14 - - 12 -', '17 - - 16 - - 12 -', '16 - - 14 - - 12 14', '14 - - - - - - -'] },
    },
  }),
  song({
    name: 'Neon Overdrive', style: 'synthwave', bpm: 116, root: 54, loop: 1,
    form: ['I', 'A', 'B', 'A', 'B', 'C'],
    sections: {
      I: { bars: 4, chords: 'i VI III VII', drums: 'kick' },
      A: { bars: 8, chords: 'i VI III VII', mel: [
        '7 - - - 10 - 12 - 10 - 7 - 5 - 3 -', '3 - - - 5 - 7 - 8 - - - 7 - 5 -',
        '7 - - - 10 - 12 - 14 - - - 12 - 10 -', '10 - - - - - - - 5 - 7 - 8 - 10 -'] },
      B: { bars: 8, chords: 'VI VII i i VI VII III VII', mel: [
        '15 - 12 - 15 - 17 -', '17 - 14 - 10 - 14 -', '15 - - - 12 - 10 -', '12 - - - - - - -',
        '15 - 12 - 15 - 17 -', '19 - 17 - 14 - 17 19', '22 - 19 - 17 - 15 -', '14 - - - 10 - 12 14'] },
      C: { bars: 4, chords: 'VI VII i i', drums: 'half', bass: false },
    },
  }),
  song({
    name: 'Harbor Lights', style: 'chip', bpm: 150, root: 55, loop: 1,
    form: ['I', 'A', 'B', 'A', 'B'],
    sections: {
      I: { bars: 4, chords: 'I V vi IV', drums: 'half' },
      A: { bars: 8, chords: 'I V vi IV', mel: [
        '12 . 11 . 12 . 7 . 4 . 7 . 12 . 14 .', '14 . 12 . 11 . 7 . 2 . 7 . 11 . 14 .',
        '16 . 14 . 12 . 9 . 4 . 9 . 12 . 16 .', '17 . 16 . 14 . 12 . 9 . 12 . 14 . 16 .'] },
      B: { bars: 8, chords: 'I V vi IV', mel: [
        '19 - 16 - 14 - 12 -', '14 - - 12 11 - 7 -', '12 - 14 - 16 - 19 -', '17 - - - 16 - 14 -',
        '19 - 16 - 14 - 12 14', '16 - 14 - 11 - 14 -', '12 - - 11 12 - 14 -', '12 - - - - - - -'] },
    },
  }),
  song({
    name: 'Desert Mirage', style: 'dnb', bpm: 172, root: 52, loop: 1,
    form: ['I', 'A', 'B', 'C', 'B'],
    sections: {
      I: { bars: 4, chords: 'i VI iv VI', drums: 'half', bass: false },
      A: { bars: 8, chords: 'i VI iv VI', lead: 'pluck', mel: [
        '7 - - - 10 - 12 -', '12 - - - 10 - 7 -', '8 - - - 7 - 5 -', '7 - - - - - - -'] },
      B: { bars: 8, chords: 'i VI iv VI', roll: true, mel: [
        '19 - 17 - 15 - 14 15', '15 - - - 12 - 15 -', '17 - 15 - 12 - 10 12', '12 - - - - - . .',
        '19 - 17 - 15 - 19 22', '24 - - - 20 - 19 -', '17 - 15 - 12 - 15 17', '19 - - - - - - -'] },
      C: { bars: 4, chords: 'i VI iv VI', drums: 'none', riser: true },
    },
  }),
];

function impulse(ctx, secs) {
  const len = Math.floor(ctx.sampleRate * secs);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

export class Music {
  constructor(ctx, out, noise) {
    this.ctx = ctx;
    this.out = out;
    this.noise = noise;
    // bass and pads go through a ducking gain that dips on each kick (the "pumping" sound of dance music)
    this.duck = ctx.createGain();
    this.duck.connect(out);
    this.revIn = ctx.createGain();
    const rev = ctx.createConvolver();
    rev.buffer = impulse(ctx, 2.2);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.5;
    this.revIn.connect(rev).connect(revOut).connect(out);
    // dotted-eighth echo with a darkening feedback loop
    this.dlyIn = ctx.createGain();
    this.delay = ctx.createDelay(1.5);
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const dlyOut = ctx.createGain();
    dlyOut.gain.value = 0.45;
    this.dlyIn.connect(this.delay).connect(lp).connect(fb).connect(this.delay);
    lp.connect(dlyOut).connect(out);
  }

  setSong(s) {
    this.delay.delayTime.setValueAtTime((60 / s.bpm) * 0.75, this.ctx.currentTime);
  }

  playStep(s, step, t, spb) {
    const st = STYLES[s.style];
    const total = s.bars.length;
    const b = Math.floor(step / 16);
    const bar = s.bars[b < total ? b : s.loopBar + ((b - total) % (total - s.loopBar))];
    const sec = bar.sec;
    const s16 = step % 16;
    const chord = sec.chordList[bar.i % sec.chordList.length];
    const drums = sec.drums ?? 'full';
    const lastBar = bar.i === sec.bars - 1;
    const at = (pat) => pat && pat[s16] === 'x';

    // ---- drums
    if (drums !== 'none') {
      if (drums !== 'half' && at(st.kick)) this.kick(t, st.chip, st.duck);
      if (drums === 'full') {
        if (at(st.snare)) this.snare(t, 0.34, st.chip, st.bigSnare);
        if (at(st.clap)) this.clap(t, 0.32);
        if (at(st.ghost)) this.snare(t, 0.08, false, false);
        if (sec.roll && lastBar && bar.next !== sec && s16 >= 8) this.snare(t, 0.06 + (s16 - 8) * 0.03, st.chip, false);
      }
      if (at(st.ch)) this.hat(t, st.chip ? 0.07 : (s16 % 4 === 2 ? 0.08 : 0.05), false, st.chip);
      if (drums !== 'kick' && at(st.oh)) this.hat(t, 0.06, true, st.chip);
    }
    if (bar.i === 0 && s16 === 0 && drums === 'full' && b > 0) this.crash(t);
    if (sec.riser && lastBar && s16 === 0) this.riser(t, spb * 16);

    // ---- bass
    const pc = ((chord[0] % 12) + 12) % 12;
    const bassRoot = s.root - 24 + (pc > 6 ? pc - 12 : pc);
    if (sec.bass !== false) {
      const bp = P[st.bassP], dest = st.duck ? this.duck : this.out;
      let n = null, len = 1;
      switch (st.bass) {
        case 'oct': if (s16 % 2 === 0) { n = bassRoot + (s16 % 4 === 2 ? 12 : 0); len = 1.6; } break;
        case 'funk': if ('x..x..x.x.x..x..'[s16] === 'x') { n = bassRoot + (s16 === 6 || s16 === 13 ? 12 : 0); len = 1.5; } break;
        case 'syncopated': if ('x..x..x.x..x.x..'[s16] === 'x') { n = bassRoot + (s16 === 11 ? 12 : 0); len = 1.8; } break;
        case 'roll': if (s16 % 4 !== 0) { n = bassRoot; len = 0.9; } break;
        case 'sixteenths': n = bassRoot + (s16 === 14 ? 12 : 0); len = 0.9; break;
        case 'alt': if (s16 % 2 === 0) { n = bassRoot + (s16 % 4 === 2 ? 7 : 0); len = 1.5; } break;
        case 'long': if (s16 === 0 || s16 === 10) { n = bassRoot; len = s16 === 0 ? 9.5 : 5.5; } break;
      }
      if (n != null) this.voice(t, NOTE(n), spb * len, bp, st.bass === 'long' ? 0.2 : st.bassP === 'triBass' ? 0.26 : 0.17, dest);
    }

    // ---- harmony
    if (s16 === 0 && st.pad && sec.pad !== false) for (const c of chord) this.voice(t, NOTE(s.root + c), spb * 16, P.pad, 0.022, st.duck ? this.duck : this.out);
    if (st.stab && at(st.stab) && sec.drums !== 'none') for (const c of chord) this.voice(t, NOTE(s.root + c), spb * 1.4, P[st.stabP], st.stabP === 'epiano' ? 0.035 : 0.028, this.out);
    if (st.arp && s16 % (st.arpRate || 1) === 0) {
      const tones = [...chord, ...chord.map((c) => c + 12)];
      const k = (s16 / (st.arpRate || 1)) % tones.length;
      this.voice(t, NOTE(s.root + 12 + tones[k]), spb * 0.9, P[st.arp], st.arp === 'chipArp' ? 0.036 : 0.028, this.out);
    }

    // ---- lead
    const ev = sec.melody?.[bar.i % sec.melody.length]?.[s16];
    if (ev && sec.lead !== false) {
      const lp = P[sec.lead || st.lead];
      this.voice(t, NOTE(s.root + 12 + ev.n), spb * ev.len * 0.95, lp, lp === P.supersaw ? 0.05 : lp === P.pulse ? 0.06 : 0.065, this.out);
    }
  }

  // one note: oscillators -> lowpass -> envelope -> destination (+ echo and reverb sends)
  voice(t, f, dur, p, vol, dest) {
    const ctx = this.ctx;
    const fl = ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.value = p.cut;
    fl.Q.value = p.q || 0.7;
    if (p.fenv) {
      fl.frequency.setValueAtTime(p.fenv[0], t);
      fl.frequency.exponentialRampToValueAtTime(p.fenv[1], t + p.fenv[2]);
    }
    const g = ctx.createGain();
    const a = p.a ?? 0.005, r = p.r ?? 0.08;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    if (p.decay) g.gain.setTargetAtTime(vol * p.sus, t + a, p.decay / 3);
    g.gain.setTargetAtTime(0.0001, t + Math.max(dur, a), r / 3);
    const end = t + Math.max(dur, a) + r * 2 + 0.05;
    let lfo = null;
    if (p.vib) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(p.vib, t + 0.25);
      lfo.connect(lg);
      lfo.start(t);
      lfo.stop(end);
      lfo.lg = lg;
    }
    for (const [type, cents, mult, lvl] of p.osc) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      o.detune.value = cents;
      if (lfo) lfo.lg.connect(o.detune);
      const og = ctx.createGain();
      og.gain.value = lvl;
      o.connect(og).connect(fl);
      o.start(t);
      o.stop(end);
    }
    fl.connect(g).connect(dest);
    if (p.dly) { const s = ctx.createGain(); s.gain.value = p.dly; g.connect(s).connect(this.dlyIn); }
    if (p.rev) { const s = ctx.createGain(); s.gain.value = p.rev; g.connect(s).connect(this.revIn); }
  }

  noiseHit(t, dur, type, f, vol, { q = 0.8, rev = 0, attack = 0 } = {}) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.frequency.value = f;
    fl.Q.value = q;
    const g = ctx.createGain();
    if (attack) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); } else g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl).connect(g).connect(this.out);
    if (rev) { const r = ctx.createGain(); r.gain.value = rev; g.connect(r).connect(this.revIn); }
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.02);
    return fl;
  }

  kick(t, chip, duck) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = chip ? 'square' : 'sine';
    o.frequency.setValueAtTime(chip ? 220 : 165, t);
    o.frequency.exponentialRampToValueAtTime(chip ? 50 : 42, t + (chip ? 0.06 : 0.12));
    g.gain.setValueAtTime(chip ? 0.35 : 0.85, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (chip ? 0.1 : 0.3));
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.32);
    if (duck) {
      this.duck.gain.cancelScheduledValues(t);
      this.duck.gain.setValueAtTime(0.35, t);
      this.duck.gain.linearRampToValueAtTime(1, t + 0.2);
    }
  }

  snare(t, vol, chip, big) {
    if (chip) { this.noiseHit(t, 0.09, 'highpass', 1500, vol * 0.8); return; }
    this.noiseHit(t, big ? 0.22 : 0.15, 'bandpass', 1900, vol, { rev: big ? 0.9 : 0.15 });
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    g.gain.setValueAtTime(vol * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.1);
  }

  clap(t, vol) {
    for (const d of [0, 0.011, 0.023]) this.noiseHit(t + d, d === 0.023 ? 0.16 : 0.02, 'bandpass', 1250, vol, { q: 1.2, rev: d === 0.023 ? 0.25 : 0 });
  }

  hat(t, vol, open, chip) {
    this.noiseHit(t, open ? 0.22 : chip ? 0.025 : 0.035, 'highpass', chip ? 9000 : 7500, vol);
  }

  crash(t) { this.noiseHit(t, 1.5, 'highpass', 4500, 0.1, { rev: 0.4 }); }

  // white-noise sweep that builds into the next section
  riser(t, dur) {
    const fl = this.noiseHit(t, dur, 'bandpass', 400, 0.12, { q: 2, attack: dur * 0.95, rev: 0.3 });
    fl.frequency.setValueAtTime(400, t);
    fl.frequency.exponentialRampToValueAtTime(7000, t + dur);
  }
}
