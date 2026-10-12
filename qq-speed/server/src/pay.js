// Paystack: token purchases in naira. The browser only ever gets an access code for Paystack's popup; tokens are added
// by the server once Paystack itself says the payment succeeded (the webhook, or a verify call), never on the
// browser's word. Accounts (accounts.js, wallet.js) keep the payments and credit them.
//   PAYSTACK_SECRET_KEY (a secret): server calls and webhook signatures. Unset, purchases are off.
//   PAYSTACK_API (a var, optional): another base URL for Paystack's API; only for testing against a stand-in locally.
import { CODE_CHARS } from '../../src/netproto.js';

const enc = (s) => new TextEncoder().encode(s);
export const paymentsReady = (env) => typeof env.PAYSTACK_SECRET_KEY === 'string' && env.PAYSTACK_SECRET_KEY.length > 0;

// a call to Paystack's API: its `data`, or a thrown error carrying Paystack's status and error type
// ('validation_error': Paystack turned the request down; anything else: try again later)
export async function paystack(env, path, body) {
  const res = await fetch((env.PAYSTACK_API || 'https://api.paystack.co') + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok || out?.status !== true || !out.data) {
    throw Object.assign(new Error(`Paystack answered ${res.status}`), { status: res.status, type: out?.type || null });
  }
  return out.data;
}

// whether a webhook really comes from Paystack: x-paystack-signature is the hex HMAC-SHA512 of the raw body
export async function signatureOk(env, raw, signature) {
  if (!paymentsReady(env) || typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', enc(env.PAYSTACK_SECRET_KEY), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, raw));
  const given = Uint8Array.from(signature.match(/../g), (h) => parseInt(h, 16));
  return mac.length === given.length && crypto.subtle.timingSafeEqual(mac, given);
}

// "DB-7QM4-2210": four room-code characters, then the day and month (UTC)
export function newReference(now = new Date()) {
  const b = crypto.getRandomValues(new Uint8Array(4));
  const code = Array.from(b, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
  return `DB-${code}-${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
export const REFERENCE_RE = /^DB-[A-Z0-9]{4}-\d{4}$/;
