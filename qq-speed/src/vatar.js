// Lagos Life (Vatar Games, https://lagoslife.app/developers/docs): when a Vatar world's Games app shows the game in its
// frame, the player comes from the world (no Log In screen, no email), token packs are paid on the world's own pay
// sheet (never Paystack), and the world can pause the game. Vatar's SDK is loaded from Vatar, and only when the page
// is framed by one of its worlds, so the game everywhere else never fetches it.
// The server checks everything the SDK says before it trusts it (server/src/vatar.js): the game only passes along the
// session token and purchase ids.
const SDK = 'https://lagoslife.app/sdk/vatar-games-v1.js';
const WORLDS = ['https://lagoslife.app', 'https://www.lagoslife.app', 'https://naijalife.app', 'https://www.naijalife.app', 'https://lagoslife.eliysites.com'];
const LOAD_FOR = 10_000;

// Framed by a Vatar world, as far as the browser says (Firefox can't tell who the parent is, so any frame there tries
// the SDK, which gives up after 10 s when nobody answers)
export const framed = (() => {
  try {
    if (window.parent === window) return false;
    const a = location.ancestorOrigins;
    return !a || !a.length || WORLDS.includes(a[0]);
  } catch { return false; }
})();

let V = null; // window.Vatar, once init() answered
let info = null; // { player: { id, name, avatar }, session, mode }

function load() {
  return new Promise((resolve, reject) => {
    if (window.Vatar) return resolve(window.Vatar);
    const s = document.createElement('script');
    s.src = SDK;
    s.async = true;
    const t = setTimeout(() => reject(new Error('Vatar SDK timed out')), LOAD_FOR);
    s.onload = () => { clearTimeout(t); window.Vatar ? resolve(window.Vatar) : reject(new Error('no Vatar')); };
    s.onerror = () => { clearTimeout(t); reject(new Error('Vatar SDK')); };
    document.head.append(s);
  });
}

// The world's player, or null when this isn't a Vatar world after all (or it didn't answer). Once it's answered, the
// page is in Lagos Life mode: body.vatar hides what a framed game mustn't show (logins, Paystack, install, links out).
export async function start() {
  if (!framed) return null;
  try {
    const sdk = await load();
    info = await sdk.init();
    V = sdk;
    document.body.classList.add('vatar');
    return info;
  } catch (e) {
    console.warn('Lagos Life: not available here', e?.code || e?.message);
    return null;
  }
}

export const active = () => !!V;
export const mode = () => info?.mode || null;
export const playerName = () => info?.player?.name || '';
// a fresh session token for the server (they last 15 minutes)
export const session = async () => (await V.session()).session;
// the world's pay sheet: { purchaseId, productId } once Vatar's server has the payment; rejects with an Error whose
// .code is Vatar's (cancelled, payment_failed, not_for_sale, owned, busy, rate_limited, …)
export const purchase = (productId) => V.purchase(productId);
// paid purchases the server hasn't marked delivered yet (a reload or a crash came in between): [{ purchaseId, productId }]
export const purchases = () => (V ? V.purchases() : Promise.resolve([]));
// a purchase confirmed while no purchase() call was waiting (the player came back from paying on the provider's page)
export const onPurchase = (fn) => V?.onPurchase(fn);
// the phone went to the background or the pay sheet opened over the game: sound and timers stop until resume
export const onPause = (fn) => V?.onPause(fn);
export const onResume = (fn) => V?.onResume(fn);
