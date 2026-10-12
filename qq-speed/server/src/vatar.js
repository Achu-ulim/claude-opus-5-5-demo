// Lagos Life (Vatar Games, https://lagoslife.app/developers/docs): the game runs framed in a Vatar world's Games app.
// There a player is known by their Vatar session, never a Driftbolt login, and token packs are paid on the world's own
// pay sheet, never Paystack. This server checks every session and purchase with Vatar's API before it trusts them:
// accounts.js links each Vatar player to a Driftbolt account with no email, and wallet.js credits a paid purchase once
// and then marks it delivered.
//   VATAR_SECRET (a secret): vtr_test_… for the sandbox, vtr_live_… once approved. Unset, Lagos Life play is off.
//   VATAR_WEBHOOK_SECRET (a secret): vtr_whsec_…, checks the signature on Vatar's webhooks.
//   VATAR_RESULTS_SECRET (a secret): vtr_rsec_…, signs match results; kept for multiplayer matches, not used yet.
//   VATAR_API (a var, optional): another base URL for Vatar's API; only for testing against a stand-in locally.
const enc = (s) => new TextEncoder().encode(s);
export const vatarReady = (env) => typeof env.VATAR_SECRET === 'string' && env.VATAR_SECRET.startsWith('vtr_');

// a call to Vatar's API: { http, ...answer }; { http: 0 } when it can't be reached
export async function vatar(env, path, body) {
  try {
    const res = await fetch((env.VATAR_API || 'https://lagoslife.app/api/games/v1') + path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${env.VATAR_SECRET}`, 'content-type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }),
    });
    const out = await res.json().catch(() => ({}));
    return { ...(out && typeof out === 'object' ? out : {}), http: res.status };
  } catch (e) {
    return { http: 0, error: 'unreachable', message: e?.message };
  }
}

// Vatar's ids: purchase ids are hex today; this allows a little more without letting anything odd into a URL path
export const VATAR_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
export const PLAYER_ID_RE = /^[pt]_[A-Za-z0-9_-]{1,80}$/;

// whether a webhook really comes from Vatar: X-Vatar-Signature is "sha256=" + the hex HMAC-SHA256 of the raw body
export async function webhookSignatureOk(env, raw, signature) {
  const secret = env.VATAR_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || !secret || typeof signature !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signature);
  if (!m) return false;
  const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, raw));
  const given = Uint8Array.from(m[1].match(/../g), (h) => parseInt(h, 16));
  return mac.length === given.length && crypto.subtle.timingSafeEqual(mac, given);
}
