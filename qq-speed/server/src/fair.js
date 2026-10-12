// Fair play for cash races: the server's own check of each finisher's race before any money moves (the Room calls it
// once a cash race is over). Every racer's game streams its car state (SNAPSHOT_HZ a second); the Room records each
// snapshot with the time it arrived: [recv, t, x, y, z, s, d, laps], where t is the game's idea of server time, s the
// speed (m/s), d the distance along the track's centerline and laps the laps done (-1 on the grid), so progress is
// laps × L + d. A failed check freezes the payout for a person to review the replay; it never decides on its own.
//
// What's checked, per finisher:
//   checkpoints  each lap is cut into `checkpoints` stretches; the stream must pass through every one, in order
//   lap_time     no lap quicker than the track can be driven: L × lapMargin / topSpeed
//   finish       the finish time claimed matches when the stream crossed the line
//   speed        no speed above the car's top speed plus speedTolerance
//   teleport     no jump in position (with progress) the elapsed time can't explain; a reset onto the track is fine
//   pace         progress over any second no faster than the car can go
//   clock        snapshot and lap times in step with the server's clock
// A racer who didn't finish isn't checked: they get nothing whatever their stream says.

export const REC = { RECV: 0, T: 1, X: 2, Y: 3, Z: 4, S: 5, D: 6, LAPS: 7 };
const JUMP = 12; // m of slack in the jump check (snapshot jitter)
const PACE = 15; // m of slack in the pace check
const SKEW = 5000; // ms a snapshot's time may be from when it arrived
const BACKSTEP = 1500; // ms a game's clock may step back after it resyncs
const LAP_LATE = 45_000; // ms a lap message may arrive after it happened (queued through a reconnect)
const FINISH_TOL = 3000; // ms between the claimed finish and the stream's crossing of the line
const GAP = 2000; // ms without a snapshot that counts as a gap in the data

// e: { finished, time (s), lapTimes, rec: [...], laps: [{ lap, time, recv }] the lap messages }
// race: { L, laps, startAt }, cfg: the cash config. Returns [{ check, detail }].
export function checkRacer(e, race, cfg) {
  if (!e.finished) return [];
  const { L, laps, startAt } = race;
  const top = cfg.topSpeed, flags = [];
  const flag = (check, detail) => { if (!flags.some((f) => f.check === check)) flags.push({ check, detail }); };
  const rec = (e.rec || []).filter((r) => r[REC.T] >= startAt - 1000);
  if (rec.length < 10) {
    flag('no_data', `only ${rec.length} car updates were received`);
    return flags;
  }
  const P = (r) => r[REC.LAPS] * L + r[REC.D];

  // lap times
  const minLap = (L * cfg.lapMargin) / top;
  e.lapTimes.forEach((t, i) => { if (t < minLap) flag('lap_time', `lap ${i + 1} took ${t.toFixed(3)} s; the fastest possible is ${minLap.toFixed(1)} s`); });

  // the clock: lap messages, then snapshots
  for (const m of e.laps || []) {
    const now = (m.recv - startAt) / 1000;
    if (m.time > now + 2) flag('clock', `lap ${m.lap} was claimed at ${m.time.toFixed(2)} s when the server's race clock said ${now.toFixed(2)} s`);
    else if ((now - m.time) * 1000 > LAP_LATE) flag('clock', `lap ${m.lap} arrived ${(now - m.time).toFixed(0)} s after it was driven`);
  }
  let skewed = 0, worst = 0;
  for (let i = 0; i < rec.length; i++) {
    const r = rec[i], off = r[REC.RECV] - r[REC.T];
    if (off < -SKEW || off > SKEW) { skewed++; worst = Math.max(worst, Math.abs(off)); }
    if (i && r[REC.T] < rec[i - 1][REC.T] - BACKSTEP) flag('clock', `the car's clock went back ${((rec[i - 1][REC.T] - r[REC.T]) / 1000).toFixed(1)} s`);
  }
  if (skewed > 3) flag('clock', `${skewed} updates were stamped up to ${(worst / 1000).toFixed(1)} s away from the server's clock`);

  // speed, jumps, pace
  const limit = top * (1 + cfg.speedTolerance);
  let fast = 0, max = 0;
  for (const r of rec) if (Math.abs(r[REC.S]) > limit) { fast++; max = Math.max(max, Math.abs(r[REC.S])); }
  if (fast) flag('speed', `${fast} update${fast > 1 ? 's' : ''} at up to ${(max * 3.6).toFixed(0)} km/h; the car tops out at ${(top * 3.6).toFixed(0)} km/h`);
  let w = 0;
  for (let i = 1; i < rec.length; i++) {
    const a = rec[i - 1], b = rec[i];
    const dt = (b[REC.T] - a[REC.T]) / 1000;
    if (dt > 0) {
      const dist = Math.hypot(b[REC.X] - a[REC.X], b[REC.Y] - a[REC.Y], b[REC.Z] - a[REC.Z]);
      const allowed = top * 1.25 * dt + JUMP;
      if (dist > allowed && P(b) - P(a) > allowed) flag('teleport', `the car moved ${dist.toFixed(0)} m (and ${(P(b) - P(a)).toFixed(0)} m along the track) in ${dt.toFixed(2)} s`);
    }
    // pace: the window back to the first update at least a second earlier
    while (w < i - 1 && b[REC.T] - rec[w + 1][REC.T] >= 1000) w++;
    const dtw = (b[REC.T] - rec[w][REC.T]) / 1000;
    if (dtw >= 1 && P(b) - P(rec[w]) > top * 1.2 * dtw + PACE) flag('pace', `${(P(b) - P(rec[w])).toFixed(0)} m along the track in ${dtw.toFixed(1)} s`);
  }

  // checkpoints in order
  const N = cfg.checkpoints, seg = L / N;
  let next = 0, prevT = rec[0][REC.T];
  for (const r of rec) {
    const p = P(r);
    if (p >= 0 && p < laps * L) {
      const idx = Math.floor(p / seg);
      if (idx === next) next++;
      else if (idx > next) {
        const gap = r[REC.T] - prevT > GAP;
        flag('checkpoints', `checkpoint ${(next % N) + 1} of lap ${Math.floor(next / N) + 1} was skipped${gap ? ` (no car updates for ${((r[REC.T] - prevT) / 1000).toFixed(1)} s)` : ''}`);
        next = idx + 1;
      }
    }
    prevT = r[REC.T];
  }
  if (next < laps * N) flag('checkpoints', `the car's updates stop at checkpoint ${(next % N) + 1} of lap ${Math.floor(next / N) + 1}`);

  // the finish: when the stream crossed the line, against the time claimed
  const claimed = startAt + e.time * 1000;
  const k = rec.findIndex((r) => P(r) >= laps * L);
  if (k > 0) {
    const a = rec[k - 1], b = rec[k];
    const f = (laps * L - P(a)) / Math.max(1e-6, P(b) - P(a));
    const crossed = a[REC.T] + (b[REC.T] - a[REC.T]) * Math.min(1, Math.max(0, f));
    if (Math.abs(claimed - crossed) > FINISH_TOL) flag('finish', `finish claimed at ${e.time.toFixed(2)} s; the car crossed the line at ${((crossed - startAt) / 1000).toFixed(2)} s`);
  } else if (k < 0 && claimed < rec[rec.length - 1][REC.T] - 1000) {
    flag('finish', `finish claimed at ${e.time.toFixed(2)} s, while the car was still short of the line at ${((rec[rec.length - 1][REC.T] - startAt) / 1000).toFixed(2)} s`);
  }
  return flags;
}

// what's kept for review: about 5 updates a second per racer, [ms since the start, x, z, speed, progress]
export function replayOf(e, race) {
  const out = [];
  const rec = (e.rec || []).filter((r) => r[REC.T] >= race.startAt - 3000);
  const r1 = (v) => Math.round(v * 10) / 10;
  rec.forEach((r, i) => {
    if (i % 3 && i !== rec.length - 1) return;
    out.push([Math.round(r[REC.T] - race.startAt), r1(r[REC.X]), r1(r[REC.Z]), r1(r[REC.S]), r1(r[REC.LAPS] * race.L + r[REC.D])]);
  });
  return out;
}
