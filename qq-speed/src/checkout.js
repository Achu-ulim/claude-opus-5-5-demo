// The checkout card (design/Checkout): one modal card with an icon, a title, a few lines and two buttons, for every step
// of spending and buying tokens: confirming an unlock, asking a guest to save their garage first, Paystack's window,
// waiting for a bank, success and failure. Also the offer to move a guest garage to a new account.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const ICON = {
  spend: '<path d="M12 2l8.66 5v10L12 22l-8.66-5V7z"/>',
  user: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6"/>',
  wait: '<path d="M12 6v6l4 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z"/>',
  bank: '<path d="M3 10l9-6 9 6M5 10v8M19 10v8M9 10v8M15 10v8M3 20h18"/>',
  ok: '<path d="M5 12l5 5L20 7"/>',
  fail: '<path d="M6 6l12 12M18 6L6 18"/>',
  garage: '<path d="M3 21V9l9-6 9 6v12"/><path d="M7 21v-8h10v8M7 17h10"/>',
};
// tone: y (spend, waiting), c (account, Paystack), g (success), r (failed)

let current = null;

// { icon, tone, title, body (\n for a new line), primary, secondary, onPrimary, onSecondary, onDismiss, busy }; the
// buttons' handlers decide whether the card stays (they call show() or hide() themselves). Escape or a tap outside runs
// onDismiss, or else the secondary button.
export function show(c) {
  current = c;
  const box = $('checkout');
  $('coIcon').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[c.icon] || ''}</svg>`;
  $('coCard').className = `cocard t-${c.tone || 'y'}${c.busy ? ' busy' : ''}`;
  $('coTitle').textContent = c.title;
  $('coBody').innerHTML = esc(c.body || '').replace(/\n/g, '<br>');
  const p = $('coPrimary'), s = $('coSecondary');
  p.textContent = c.primary || '';
  p.classList.toggle('hidden', !c.primary);
  p.disabled = !!c.busy;
  s.textContent = c.secondary || '';
  s.classList.toggle('hidden', !c.secondary);
  const opening = box.classList.contains('hidden');
  box.classList.remove('hidden');
  if (opening || document.activeElement === document.body) (c.primary ? p : s).focus();
}

export function hide() {
  current = null;
  $('checkout').classList.add('hidden');
}

export const isOpen = () => !$('checkout').classList.contains('hidden');

export function bind() {
  $('coPrimary').addEventListener('click', () => current?.onPrimary?.());
  $('coSecondary').addEventListener('click', () => (current?.onSecondary ? current.onSecondary() : hide()));
  $('checkout').addEventListener('click', (e) => { if (e.target.id === 'checkout') dismiss(); });
}

function dismiss() {
  if (current?.busy) return;
  (current?.onDismiss || current?.onSecondary || hide)();
}

// Escape: as a tap outside the card, unless something is under way
export function escape() {
  if (!isOpen()) return false;
  dismiss();
  return true;
}
