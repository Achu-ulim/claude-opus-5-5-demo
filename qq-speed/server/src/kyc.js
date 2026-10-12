// Identity checks (KYC) for cash withdrawals: a BVN or NIN is checked with a provider, behind this one interface, so the
// provider can change without touching the cash code (server/src/cash.js).
//   KYC_PROVIDER (a var): 'mock'  local dev only: no real check (see mockProvider). It only answers requests from this
//                                 machine (CF-Connecting-IP is a loopback address, which Cloudflare never lets a real
//                                 visitor send), so a forgotten setting can't wave real players through.
//                         unset   identity checks are off, so withdrawals can't start
// To add the real provider: write a function like mockProvider that calls its API (its key in a Wrangler secret, e.g.
// KYC_API_KEY) and returns the same shape, and list it in PROVIDERS.
//
// What comes back is all that's kept: whether it passed, the name on record and when. The ID number itself is only
// passed through to the provider and never stored or logged.

export const ID_TYPES = { bvn: 'BVN', nin: 'NIN' };
const ID_RE = /^\d{11}$/; // both are 11 digits

// { type, number, firstName, lastName, middleName?, dob: 'YYYY-MM-DD' } →
//   { ok: true, name: { first, middle, last }, dob? }              the provider found the ID and it's the player's
//   { ok: false, reason: 'not_found' | 'mismatch' | 'unavailable' }
// The provider's own dob (when it returns one) is checked against the one the player confirmed (cash.js).

// local dev: numbers starting 000 aren't found, 111 are someone else's; any other 11 digits pass with the name typed
async function mockProvider(input) {
  if (input.number.startsWith('000')) return { ok: false, reason: 'not_found' };
  if (input.number.startsWith('111')) return { ok: false, reason: 'mismatch' };
  return { ok: true, name: { first: input.firstName, middle: input.middleName || '', last: input.lastName }, dob: input.dob };
}

const PROVIDERS = { mock: mockProvider };

// local: the request came from this machine (wrangler dev)
export function kycReady(env, local = false) {
  const p = env.KYC_PROVIDER;
  if (p === 'mock') return local;
  return Object.hasOwn(PROVIDERS, p);
}
export const isLocal = (ip) => ip === '127.0.0.1' || ip === '::1';

export async function verifyIdentity(env, local, input) {
  if (!kycReady(env, local)) return { ok: false, reason: 'unavailable' };
  if (!Object.hasOwn(ID_TYPES, input.type) || !ID_RE.test(input.number)) return { ok: false, reason: 'bad_id' };
  try {
    return await PROVIDERS[env.KYC_PROVIDER](input, env);
  } catch (e) {
    console.error(`kyc: provider failed (${e?.name || 'error'})`); // never the number or the name
    return { ok: false, reason: 'unavailable' };
  }
}

// ---------- names ----------
// Whether the name on a bank account is the verified person's. Banks and ID records order and abbreviate names
// differently ("OKAFOR ADA C" for Ada Chioma Okafor), so the names are compared as sets of words: every word of the
// shorter name must match a word of the longer one (exactly, as an initial, or with one letter different in a word of
// five or more letters), and at least two words must match in full.
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);

function oneOff(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

export function namesMatch(verified, bank) {
  let a = words(verified), b = words(bank);
  if (a.length > b.length) [a, b] = [b, a];
  if (a.length < 2) return false;
  const left = [...b];
  let full = 0;
  for (const w of a) {
    let k = left.findIndex((x) => x === w);
    if (k >= 0) full++;
    else k = left.findIndex((x) => (w.length === 1 && x[0] === w) || (x.length === 1 && w[0] === x) || (Math.min(w.length, x.length) >= 5 && oneOff(w, x)));
    if (k < 0) return false;
    left.splice(k, 1);
  }
  return full >= 2;
}

export const fullName = (n) => [n.first, n.middle, n.last].filter(Boolean).join(' ');
