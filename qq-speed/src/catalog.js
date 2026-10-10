// Everything a player can unlock in the Garage: the cars and the cosmetic parts, each with a price in tokens
// (0 = free) and, for some, a way to earn it free. Parts are looks only: nothing here may change how a car drives
// (that is each car's tune in carModel.js and vehicle.js). The game and, through netproto.js, the multiplayer server
// both import this file, so it must stay free of browser and three.js code.
//
// earn: the free way to unlock something, shown as "Unlock with tokens, or <text> to get it free"
//   { cup: 'pro' }     win that cup in Tournament mode (league.js CUPS)
//   { unlock: 'gold' } a flag in the league's saved unlocks (league.js unlocked): Gold comes with a Legend Cup win,
//                      the others are hard daily challenge rewards (challenges.js)
const CHALLENGE = 'win it in a hard daily challenge';

// ---------- Cars ----------
// One line per car in carModel.js CARS. A car missing here can't be unlocked, so add new cars here too.
const car = (id, price = 0, earn = null) => ({ id: 'car.' + id, car: id, category: 'car', price, earn });
export const CAR_ITEMS = [
  car('sedan'), car('gt'), car('mclaren'), car('audi'),
  car('bugatti', 2500, { cup: 'pro', text: 'win the Pro Cup' }),
  car('ferrari'), car('lambo'), car('porsche'),
  car('koenigsegg', 3000),
  car('pagani', 2800, { cup: 'legend', text: 'win the Legend Cup' }),
];
export const carItemId = (carId) => 'car.' + carId;

// ---------- Parts ----------
// A look is { paint, wheels, bodykit, glow }: one part id per slot. The slots are the categories.
export const CATEGORIES = [
  { id: 'paint', name: 'Paint' },
  { id: 'wheels', name: 'Wheels' },
  { id: 'bodykit', name: 'Body kit' },
  { id: 'glow', name: 'Glow' },
];
export const LOOK_SLOTS = CATEGORIES.map((c) => c.id);
// the parts every car comes with; a look that leaves a slot out has this part there
export const FACTORY = { paint: 'paint.factory', wheels: 'wheels.factory', bodykit: 'kit.stock', glow: 'glow.factory' };

// color: the preview colour, and the colour the part puts on the car; none = the car's own (Factory)
// swatch: CSS for the preview when one colour can't show it (metals, pearl, rainbow)
// finish (paint, wheels): how the surface takes the light, see carModel.js
// kit (body kits): the pieces carModel.js adds
//   splitter: how far the front splitter reaches past the nose (m); skirts: 'paint' | 'carbon' | 'wide';
//   wing: 'gt' | 'duck' | 'ta', replacing the car's own; canards: dive planes per side; flares: bolt-on wheel arches;
//   valance: a carbon lip under the rear bumper
const METAL = {
  chrome: 'linear-gradient(135deg,#9aa3b5,#f4f6fa 45%,#8d95a6)',
  gold: 'linear-gradient(135deg,#a67c00,#ffe680 45%,#a67c00)',
};
export const PARTS = [
  { id: 'paint.factory', name: 'Factory', category: 'paint', price: 0 },
  { id: 'paint.rosso', name: 'Rosso', category: 'paint', price: 0, color: 0xff3b3b },
  { id: 'paint.bolt', name: 'Bolt Yellow', category: 'paint', price: 0, color: 0xffd23a },
  { id: 'paint.ice', name: 'Ice', category: 'paint', price: 0, color: 0xd7dae5 },
  { id: 'paint.lime', name: 'Lime', category: 'paint', price: 0, color: 0xb6ff3b },
  { id: 'paint.violet', name: 'Violet', category: 'paint', price: 0, color: 0xb48cff },
  { id: 'paint.midnight-pearl', name: 'Midnight Pearl', category: 'paint', price: 400, color: 0x1b2a6b, finish: 'pearl', swatch: 'linear-gradient(135deg,#1b2a6b,#6b7bd6)' },
  { id: 'paint.matte-black', name: 'Matte Black', category: 'paint', price: 300, color: 0x202228, finish: 'matte' },
  { id: 'paint.chrome', name: 'Chrome', category: 'paint', price: 900, color: 0xc0c6d6, finish: 'chrome', swatch: METAL.chrome, earn: { unlock: 'chrome', text: CHALLENGE } },
  { id: 'paint.gold-leaf', name: 'Gold Leaf', category: 'paint', price: 1600, color: 0xe0b23a, finish: 'gold', swatch: METAL.gold, earn: { unlock: 'gold', text: 'win the Legend Cup' } },

  { id: 'wheels.factory', name: 'Factory', category: 'wheels', price: 0 },
  { id: 'wheels.gunmetal', name: 'Gunmetal', category: 'wheels', price: 0, color: 0x3a3d52 },
  { id: 'wheels.silver', name: 'Silver', category: 'wheels', price: 0, color: 0xc9cbdb },
  { id: 'wheels.bronze', name: 'Bronze', category: 'wheels', price: 250, color: 0xb07a3a },
  { id: 'wheels.neon', name: 'Neon Cyan', category: 'wheels', price: 450, color: 0x36e2ff, finish: 'neon', earn: { unlock: 'neon', text: CHALLENGE } },
  { id: 'wheels.carbon', name: 'Carbon', category: 'wheels', price: 350, color: 0x15161f, finish: 'carbon' },
  { id: 'wheels.gold', name: 'Gold', category: 'wheels', price: 600, color: 0xe0b23a, finish: 'gold', swatch: METAL.gold },

  { id: 'kit.stock', name: 'Stock', category: 'bodykit', price: 0, color: 0x2a2d38 },
  { id: 'kit.street', name: 'Street Kit', category: 'bodykit', price: 500, color: 0x3b3f4d, kit: { splitter: 0.05, skirts: 'paint', valance: true } },
  { id: 'kit.gt-wing', name: 'GT Wing', category: 'bodykit', price: 700, color: 0x4a4f60, kit: { wing: 'gt' } },
  { id: 'kit.wide', name: 'Wide Body', category: 'bodykit', price: 1200, color: 0x5a6072, kit: { flares: true, skirts: 'wide', splitter: 0.07 } },
  { id: 'kit.drift', name: 'Drift Kit', category: 'bodykit', price: 800, color: 0x3b3f4d, kit: { splitter: 0.06, skirts: 'carbon', canards: 1, wing: 'duck' } },
  { id: 'kit.time-attack', name: 'Time Attack', category: 'bodykit', price: 1500, color: 0x6a7186, kit: { splitter: 0.16, skirts: 'carbon', canards: 2, wing: 'ta', valance: true } },

  { id: 'glow.factory', name: 'Factory', category: 'glow', price: 0 },
  { id: 'glow.off', name: 'Off', category: 'glow', price: 0, color: 0x000000 },
  { id: 'glow.cyan', name: 'Cyan', category: 'glow', price: 0, color: 0x36e2ff },
  { id: 'glow.pink', name: 'Pink', category: 'glow', price: 300, color: 0xff3da6 },
  { id: 'glow.yellow', name: 'Yellow', category: 'glow', price: 300, color: 0xffd23a },
  { id: 'glow.green', name: 'Green', category: 'glow', price: 300, color: 0x7cff6b, earn: { unlock: 'green', text: CHALLENGE } },
  { id: 'glow.rainbow', name: 'Rainbow cycle', category: 'glow', price: 1000, color: 0xff3da6, rainbow: true, swatch: 'linear-gradient(90deg,#ff3da6,#ffd23a,#36e2ff,#7cff6b)' },
];

const BY_ID = new Map([...CAR_ITEMS, ...PARTS].map((it) => [it.id, it]));
// a car or part by id; undefined for anything not in the catalog
export const item = (id) => BY_ID.get(id);
export const partsIn = (category) => PARTS.filter((p) => p.category === category);
// the part a league unlock flag stands for (the daily challenge rewards)
export const partForUnlock = (flag) => PARTS.find((p) => p.earn?.unlock === flag);

// ---------- Rewards ----------
// Tokens for playing, paid by the server wallet. A game claims the first four kinds (POST /wallet/earn), so each
// can only be claimed once (a challenge per day, a cup or championship per run) and claims share a daily cap.
// The others the server grants itself: the welcome bonus, invites, and league race wins (the League confirms those).
export const REWARDS = {
  challenge: { easy: 50, medium: 100, hard: 200 }, // each daily challenge
  cup: { rookie: 150, pro: 300, legend: 500 }, // winning a Tournament cup
  f1: 500, // winning a Formula 1 championship
  streak: 300, // a 7-day daily challenge streak
  welcome: 200, // once per account
  invite: 250, // to each of the two players, once the invited friend has finished INVITE_RACES online races
  leagueWin: 300, // winning a league race night
};
export const EARN_KINDS = ['challenge', 'cup', 'f1', 'streak'];
export const DAILY_EARN_CAP = 1000; // tokens a day from claims; the rest waits for the next day
export const INVITE_RACES = 3;
// a guest's bought cars and parts can move to their new account up to this many tokens' worth: guest wallets live
// on the device, so this is the most a faked one can bring along
export const MOVE_CAP = 1250;
const own = (o, k) => (typeof k === 'string' && Object.hasOwn(o, k) ? o[k] : 0);
// what a claim is worth (0: not a reward)
export function earnAmount(kind, proof) {
  switch (kind) {
    case 'challenge': return own(REWARDS.challenge, proof?.tier);
    case 'cup': return own(REWARDS.cup, proof?.cup);
    case 'f1': return REWARDS.f1;
    case 'streak': return REWARDS.streak;
  }
  return 0;
}

// ---------- Token packs ----------
// Bought with Paystack in naira. price_kobo is the price in kobo (₦1 = 100 kobo); null means not on sale yet.
export const PACKS = [
  { id: 'pit-stop', name: 'Pit Stop', tokens: 500, price_kobo: null, badge: '' },
  { id: 'podium', name: 'Podium', tokens: 1200, price_kobo: null, badge: 'Popular', bonus: '+20% bonus' },
  { id: 'champion', name: 'Champion', tokens: 3000, price_kobo: null, badge: 'Best value', bonus: '+50% bonus' },
  { id: 'legend', name: 'Legend', tokens: 8000, price_kobo: null, badge: '', bonus: '+60% bonus' },
];
// only for an account's first purchase; it also unlocks the parts in `grants`
export const STARTER_PACK = { id: 'starter', name: 'Starter Pack', tokens: 1500, price_kobo: null, badge: 'One-time', grants: ['paint.gold-leaf'] };
export const packById = (id) => [STARTER_PACK, ...PACKS].find((p) => p.id === id);
// ₦ with kobo shown only when there are any: 250000 → "₦2,500"
export const naira = (kobo) => '₦' + (kobo / 100).toLocaleString('en-US', { minimumFractionDigits: kobo % 100 ? 2 : 0, maximumFractionDigits: 2 });

// a look from the first garage, which stored colours ({ paint: 0xff3b3b, finish, rimColor, glow, … }), as part ids:
// the colours that match a part carry over, the rest go back to factory
export function legacyLook(old) {
  if (!old || typeof old !== 'object') return {};
  const match = (category, color) => PARTS.find((p) => p.category === category && p.color != null && p.color === color && !p.rainbow)?.id;
  const look = {
    paint: old.finish === 'chrome' ? 'paint.chrome' : match('paint', old.paint),
    wheels: match('wheels', old.rimColor),
    glow: match('glow', old.glow),
  };
  return Object.fromEntries(Object.entries(look).filter(([, id]) => id));
}
