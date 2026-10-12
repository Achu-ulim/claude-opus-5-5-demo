// The /admin page: cash races frozen for review (failed checks, reports, or no result) with what the server recorded of
// each, and withdrawals held for review. Served by the Worker (index.js); everything it shows and does goes through
// POST /admin/api/*, which needs an account named in ADMIN_USERS, logged in on this site, and the ADMIN_KEY secret
// (accounts.js adminApi). Every action is logged with the admin's name.
export const ADMIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Driftbolt admin</title>
<style>
:root{--bg:#07080f;--card:#11131f;--edge:rgba(255,255,255,.12);--txt:#f4f1e8;--dim:#a3a6bf;--ok:#7cff9e;--warn:#ffd23a;--bad:#ff6b6b}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;letter-spacing:1px;text-transform:uppercase;color:var(--dim)}
.card{background:var(--card);border:1px solid var(--edge);border-radius:14px;padding:16px;margin-bottom:14px}
.row{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}.dim{color:var(--dim)}.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--warn)}
button{font:inherit;font-weight:700;border-radius:10px;border:1px solid var(--edge);background:rgba(255,255,255,.06);color:var(--txt);padding:8px 14px;cursor:pointer}
button.go{background:var(--ok);color:#07080f;border:0}button.no{background:var(--bad);color:#07080f;border:0}button:disabled{opacity:.5;cursor:default}
input{font:inherit;background:rgba(255,255,255,.06);border:1px solid var(--edge);border-radius:10px;color:var(--txt);padding:8px 12px;min-width:260px}
table{width:100%;border-collapse:collapse;margin:8px 0}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top}th{color:var(--dim);font-weight:600;font-size:12px}
ul{margin:6px 0;padding-left:18px}svg{width:100%;max-width:640px;height:auto;background:#0b0d18;border-radius:12px;display:block}
.legend span{display:inline-flex;align-items:center;gap:6px;margin-right:14px}.legend i{width:12px;height:12px;border-radius:6px;display:inline-block}
#msg{min-height:20px;margin:8px 0}
</style></head><body><main>
<h1>Driftbolt admin</h1><div class="dim" id="who">Cash races under review and flagged withdrawals.</div>
<div class="card row" id="login"><label>Admin key <input id="key" type="password" autocomplete="off"></label><button id="enter">Open</button>
<span class="dim">Log in to the game on this site first with an admin account.</span></div>
<div id="msg" role="status"></div>
<div id="app" hidden>
<h2>Races under review</h2><div id="rooms"></div>
<h2>Withdrawals</h2><div id="wds"></div>
<h2>Admin log</h2><div class="card"><table id="log"></table></div>
</div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const SYM = { NGN: '\\u20a6', USD: '$' };
const money = (m, c) => (SYM[c] || '') + (m / 100).toLocaleString('en-US', { minimumFractionDigits: m % 100 ? 2 : 0, maximumFractionDigits: 2 });
const when = (t) => t ? new Date(t).toLocaleString() : '';
const COLORS = ['#ff3b3b', '#ffd23a', '#36e2ff', '#7cff9e', '#b48cff', '#ff8a00'];
let key = sessionStorage.getItem('db.adminKey') || '';
const session = (() => { try { return JSON.parse(localStorage.getItem('driftbolt.session'))?.token || ''; } catch { return ''; } })();

async function api(path, body) {
  const res = await fetch('/admin/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session, 'x-admin-key': key }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}
const say = (t, bad) => { $('msg').textContent = t; $('msg').className = bad ? 'bad' : 'ok'; };

async function load() {
  if (!session) return say('Not logged in: open the game on this site and log in with an admin account, then come back.', true);
  try {
    const d = await api('list');
    sessionStorage.setItem('db.adminKey', key);
    $('login').hidden = true; $('app').hidden = false;
    $('who').textContent = 'Signed in as ' + d.admin + ' · cash races: ' + d.mode;
    render(d);
  } catch (e) {
    $('app').hidden = true; $('login').hidden = false;
    say(e.message === 'not_admin' ? 'That key, or this account, isn\\'t an admin.' : e.message === 'admin_off' ? 'Admin is off: set ADMIN_USERS and the ADMIN_KEY secret.' : 'Error: ' + e.message, true);
  }
}

function render(d) {
  $('rooms').innerHTML = d.rooms.length ? d.rooms.map((r) => {
    const awards = r.plan?.awards || [];
    const name = (a) => r.seated.find((s) => s.account === a)?.name || a;
    return '<div class="card" data-code="' + esc(r.code) + '"><div class="row"><b>C-' + esc(r.code.slice(1)) + '</b><span>' + esc(r.map) + ' · ' + r.laps + ' lap(s) · ' + r.seats + ' racers · entry ' + money(r.entry, r.currency) + '</span>'
      + '<span class="warn">' + esc(r.note || 'review') + '</span><span class="dim">started ' + when(r.startedAt) + '</span></div>'
      + (r.flags.length ? '<div class="bad"><b>Failed checks</b><ul>' + r.flags.map((f) => '<li>' + esc(f.name) + ': <b>' + esc(f.check) + '</b> · ' + esc(f.detail) + '</li>').join('') + '</ul></div>' : '')
      + (r.reportList.length ? '<div class="warn"><b>Reports</b><ul>' + r.reportList.map((x) => '<li>' + esc(x.name) + ' (' + when(x.at) + '): ' + esc(x.reason || 'no reason given') + '</li>').join('') + '</ul></div>' : '')
      + '<table><tr><th>Pos</th><th>Racer</th><th>Time</th><th>Payout as reported</th></tr>' + (r.result || []).map((x) => '<tr><td>' + (x.finished ? x.place : x.dns ? 'DNS' : 'DNF') + '</td><td>' + esc(x.name) + '</td><td>'
        + (x.finished ? x.time.toFixed(3) + ' s' : '') + '</td><td>' + (awards.find((a) => a.account === x.account) ? money(awards.find((a) => a.account === x.account).amount, r.currency) : '—') + '</td></tr>').join('') + '</table>'
      + '<div class="dim">Pool ' + money(r.pool, r.currency) + ' · fee ' + money(r.plan?.fee ?? r.fee, r.currency) + ' · winners: ' + (awards.map((a) => esc(name(a.account)) + ' ' + money(a.amount, r.currency)).join(', ') || 'none') + '</div>'
      + '<div class="replay"></div>'
      + '<div class="row" style="margin-top:10px"><button data-replay>Show replay</button><button class="go" data-act="release"' + (awards.length ? '' : ' disabled') + '>Release payout as reported</button>'
      + '<button class="no" data-act="refund">Refund everyone</button></div></div>';
  }).join('') : '<div class="card dim">Nothing to review.</div>';
  $('wds').innerHTML = d.withdrawals.length ? '<div class="card"><table><tr><th>When</th><th>Player</th><th>Amount</th><th>To</th><th>Status</th><th>Flags</th><th></th></tr>' + d.withdrawals.map((w) => '<tr data-ref="' + esc(w.reference) + '"><td>'
    + when(w.at) + '</td><td>' + esc(w.username) + '</td><td>' + money(w.amount, w.currency) + '</td><td>' + esc(w.bank) + '</td><td>' + esc(w.status) + (w.note ? ' · ' + esc(w.note) : '') + '</td><td>' + esc(w.flags.join(', ')) + '</td><td>'
    + (w.status === 'review' ? '<button class="go" data-wd="approve">Send</button> <button class="no" data-wd="reject">Return to balance</button>' : '') + '</td></tr>').join('') + '</table></div>' : '<div class="card dim">None waiting.</div>';
  $('log').innerHTML = '<tr><th>When</th><th>Admin</th><th>Action</th><th>On</th><th>Note</th></tr>' + d.log.map((l) => '<tr><td>' + when(l.at) + '</td><td>' + esc(l.admin) + '</td><td>' + esc(l.action) + '</td><td>' + esc(l.target) + '</td><td>' + esc(l.note) + '</td></tr>').join('');
}

// each racer's path from above, and a slider for where everyone was at a moment of the race
function drawReplay(box, rp) {
  if (!rp?.racers?.length) { box.innerHTML = '<div class="dim">No replay was saved.</div>'; return; }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, tEnd = 0;
  for (const r of rp.racers) for (const p of r.rec) { x0 = Math.min(x0, p[1]); x1 = Math.max(x1, p[1]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); tEnd = Math.max(tEnd, p[0]); }
  if (!Number.isFinite(x0)) { box.innerHTML = '<div class="dim">No car updates were recorded.</div>'; return; }
  const W = 640, pad = 16, k = (W - pad * 2) / Math.max(1, x1 - x0, z1 - z0), H = Math.round((z1 - z0) * k + pad * 2);
  const P = (p) => ((p[1] - x0) * k + pad).toFixed(1) + ',' + ((p[2] - z0) * k + pad).toFixed(1);
  const paths = rp.racers.map((r, i) => '<polyline fill="none" stroke-width="2" stroke-opacity=".75" stroke="' + COLORS[i % 6] + '" points="' + r.rec.map(P).join(' ') + '"/>').join('');
  const stats = '<table><tr><th>Racer</th><th>Finished</th><th>Laps</th><th>Top speed</th><th>Checks</th></tr>' + rp.racers.map((r, i) => '<tr><td><i style="background:' + COLORS[i % 6] + ';width:10px;height:10px;border-radius:5px;display:inline-block"></i> ' + esc(r.name)
    + '</td><td>' + (r.finished ? r.time.toFixed(3) + ' s' : 'no') + '</td><td>' + r.lapTimes.map((t) => t.toFixed(2)).join(' / ') + '</td><td>' + (Math.max(0, ...r.rec.map((p) => Math.abs(p[3]))) * 3.6).toFixed(0) + ' km/h</td><td>'
    + (r.flags.length ? '<span class="bad">' + r.flags.map((f) => esc(f.check)).join(', ') + '</span>' : '<span class="ok">passed</span>') + '</td></tr>').join('') + '</table>';
  box.innerHTML = stats + '<svg viewBox="0 0 ' + W + ' ' + H + '">' + paths + '<g class="dots"></g></svg><div class="row"><input type="range" min="0" max="' + tEnd + '" value="' + tEnd + '" step="100" style="min-width:0;flex:1"><span class="dim t"></span></div>';
  const range = box.querySelector('input'), dots = box.querySelector('.dots'), label = box.querySelector('.t');
  const at = () => {
    const t = +range.value;
    label.textContent = (t / 1000).toFixed(1) + ' s';
    dots.innerHTML = rp.racers.map((r, i) => { const p = r.rec.reduce((b, q) => (q[0] <= t ? q : b), r.rec[0]); const [x, y] = P(p).split(','); return '<circle r="6" cx="' + x + '" cy="' + y + '" fill="' + COLORS[i % 6] + '" stroke="#000"/>'; }).join('');
  };
  range.addEventListener('input', at);
  at();
}

document.addEventListener('click', async (e) => {
  const card = e.target.closest('[data-code]');
  if (e.target.matches('[data-replay]') && card) {
    try { drawReplay(card.querySelector('.replay'), (await api('replay', { code: card.dataset.code })).replay); } catch (err) { say('Error: ' + err.message, true); }
  }
  const act = e.target.dataset.act, wd = e.target.dataset.wd;
  if ((act && card) || wd) {
    const target = act ? card.dataset.code : e.target.closest('[data-ref]').dataset.ref;
    const what = { release: 'Release the payout as reported for ' + target, refund: 'Refund every entry in ' + target, approve: 'Send withdrawal ' + target, reject: 'Return withdrawal ' + target + ' to the player\\'s balance' }[act || wd];
    const note = prompt(what + '?\\nA note for the log (required):');
    if (!note) return;
    e.target.disabled = true;
    try { render(await api('act', { action: act || wd, target, note })); say('Done: ' + what + '.'); } catch (err) { say('Error: ' + err.message, true); e.target.disabled = false; }
  }
});
$('enter').addEventListener('click', () => { key = $('key').value; load(); });
$('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') { key = $('key').value; load(); } });
if (key) load();
</script></body></html>`;
