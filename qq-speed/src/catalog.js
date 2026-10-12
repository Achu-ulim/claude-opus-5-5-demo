// Everything a player can unlock in the Garage: the cars and the parts, each with a price in tokens (0 = free) and,
// for some, a way to earn it free. Parts are looks, except engines: an engine adds power, but only in races against
// the computer (solo, Tournament, challenges). Online rooms, leagues and cash races run every car on its stock engine,
// so tokens never buy a faster car there (carModel.js tuneFor). The game and, through netproto.js, the multiplayer
// server both import this file, so it must stay free of browser and three.js code.
//
// earn: the free way to unlock something, shown as "Unlock with tokens, or <text> to get it free"
//   { cup: 'pro' }     win that cup in Tournament mode (league.js CUPS)
//   { unlock: 'gold' } a flag in the league's saved unlocks (league.js unlocked): Gold comes with a Legend Cup win,
//                      the others are hard daily challenge rewards (challenges.js)
const CHALLENGE = 'win it in a hard daily challenge';

// ---------- Cars ----------
// One line per car in carModel.js CARS. A car missing here can't be unlocked, so add new cars here too.
// Two starter cars are free; the rest cost more the stronger they are: by carModel.js carRating (top speed, launch,
// handling and nitro from each car's tune), shown in the Garage. Weakest to strongest, with its rating:
// Sedan 25, GT 35, Audi 50, Bugatti 53, McLaren 60, Ferrari 65, Porsche 75, Lamborghini 80, Pagani 81, Koenigsegg 82.
// A change to a tune can reorder them: keep the prices rising with the rating.
const car = (id, price = 0, earn = null) => ({ id: 'car.' + id, car: id, category: 'car', price, earn });
export const CAR_ITEMS = [
  car('sedan'), car('gt'),
  car('mclaren', 1200), car('audi', 600),
  car('bugatti', 900, { cup: 'pro', text: 'win the Pro Cup' }),
  car('ferrari', 1600), car('lambo', 2700), car('porsche', 2100),
  car('koenigsegg', 4200),
  car('pagani', 3400, { cup: 'legend', text: 'win the Legend Cup' }),
];
export const carItemId = (carId) => 'car.' + carId;

// ---------- Parts ----------
// A look is one part id per slot (the slots are the categories), plus what the player made themselves for some
// parts: paintHex (Custom Colour), plateText (a plate) and logoKey (an uploaded logo). See netproto.js cleanLook.
export const CATEGORIES = [
  { id: 'paint', name: 'Paint' },
  { id: 'livery', name: 'Skin' },
  { id: 'wheels', name: 'Wheels' },
  { id: 'tyres', name: 'Tyres' },
  { id: 'bodykit', name: 'Body' },
  { id: 'exhaust', name: 'Exhaust' },
  { id: 'glow', name: 'Glow' },
  { id: 'logo', name: 'Logo' },
  { id: 'plate', name: 'Plate' },
  { id: 'steering', name: 'Steering' },
  { id: 'engine', name: 'Engine' },
];
export const LOOK_SLOTS = CATEGORIES.map((c) => c.id);
// the parts every car comes with; a look that leaves a slot out has this part there
export const FACTORY = {
  paint: 'paint.factory', livery: 'livery.none', wheels: 'wheels.factory', tyres: 'tyres.factory', bodykit: 'kit.stock',
  exhaust: 'exhaust.factory', glow: 'glow.factory', logo: 'logo.none', plate: 'plate.none', steering: 'steering.factory',
  engine: 'engine.stock',
};

// color: the preview colour, and the colour the part puts on the car; none = the car's own (Factory)
// swatch: CSS for the preview when one colour can't show it (metals, pearl, rainbow)
// finish (paint, wheels): how the surface takes the light, see carModel.js
// custom (paint): the player picks the colour (look.paintHex)
// kit (body kits): the pieces carModel.js adds
//   splitter: how far the front splitter reaches past the nose (m); skirts: 'paint' | 'carbon' | 'wide';
//   wing: 'gt' | 'duck' | 'ta', replacing the car's own; canards: dive planes per side; flares: bolt-on wheel arches;
//   valance: a carbon lip under the rear bumper
// livery (skins): a design drawn on the doors and hood (decals.js)
// tyre (tyres): wall: the colour of the stripe or letters on the sidewall; letters: lettering rather than a stripe;
//   slick: smooth race rubber; neon: the sidewall glows; smoke: the colour of the drift smoke ('rainbow' cycles)
// exhaust: layout: 'twin' | 'quad' | 'center' | 'big' (two wide pipes); tip: the tips' metal; flame: the nitro flame
// decal (logos): where the player's uploaded logo goes: 'hood', 'doors'
// plate: the number plate's style, on the tail; the player picks the number (look.plateText)
// wheel (steering): the steering wheel in the cockpit view (cockpit.js)
// engine: power: extra drive (0.1 = +10%); top, nitro: extra top speed without and with nitro (m/s); charge: faster
//   nitro charging (0.1 = +10%); sound: how it sounds (audio.js). The best adds about 15 to a car's rating: a car
//   climbs about one place in the order, never to the top
const METAL = {
  chrome: 'linear-gradient(135deg,#9aa3b5,#f4f6fa 45%,#8d95a6)',
  gold: 'linear-gradient(135deg,#a67c00,#ffe680 45%,#a67c00)',
  titanium: 'linear-gradient(135deg,#6a5acd,#d9a6ff 35%,#5ab0ff 60%,#c9cbdb)',
  carbon: 'repeating-linear-gradient(45deg,#15161f 0 4px,#2a2d38 4px 8px)',
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
  { id: 'paint.custom', name: 'Custom Colour', category: 'paint', price: 1000, custom: true, swatch: 'conic-gradient(#ff3b3b,#ffd23a,#b6ff3b,#36e2ff,#b48cff,#ff3da6,#ff3b3b)' },

  { id: 'livery.none', name: 'None', category: 'livery', price: 0 },
  { id: 'livery.stripes', name: 'Twin Stripes', category: 'livery', price: 300, livery: 'stripes' },
  { id: 'livery.checker', name: 'Checkered', category: 'livery', price: 450, livery: 'checker' },
  { id: 'livery.carbon', name: 'Carbon Hood', category: 'livery', price: 450, livery: 'carbon' },
  { id: 'livery.tiger', name: 'Tiger', category: 'livery', price: 600, livery: 'tiger' },
  { id: 'livery.flames', name: 'Hot Rod Flames', category: 'livery', price: 700, livery: 'flames' },
  { id: 'livery.camo', name: 'Digital Camo', category: 'livery', price: 800, livery: 'camo' },
  { id: 'livery.bolt', name: 'Lightning', category: 'livery', price: 900, livery: 'bolt' },
  { id: 'livery.sakura', name: 'Sakura', category: 'livery', price: 1000, livery: 'sakura' },
  { id: 'livery.splash', name: 'Neon Splash', category: 'livery', price: 1400, livery: 'splash' },

  { id: 'wheels.factory', name: 'Factory', category: 'wheels', price: 0 },
  { id: 'wheels.gunmetal', name: 'Gunmetal', category: 'wheels', price: 0, color: 0x3a3d52 },
  { id: 'wheels.silver', name: 'Silver', category: 'wheels', price: 0, color: 0xc9cbdb },
  { id: 'wheels.bronze', name: 'Bronze', category: 'wheels', price: 250, color: 0xb07a3a },
  { id: 'wheels.neon', name: 'Neon Cyan', category: 'wheels', price: 450, color: 0x36e2ff, finish: 'neon', earn: { unlock: 'neon', text: CHALLENGE } },
  { id: 'wheels.carbon', name: 'Carbon', category: 'wheels', price: 350, color: 0x15161f, finish: 'carbon' },
  { id: 'wheels.gold', name: 'Gold', category: 'wheels', price: 600, color: 0xe0b23a, finish: 'gold', swatch: METAL.gold },

  { id: 'tyres.factory', name: 'Factory', category: 'tyres', price: 0, color: 0x1b1b1d },
  { id: 'tyres.redline', name: 'Red Line', category: 'tyres', price: 250, color: 0xe53935, tyre: { wall: 0xe53935 } },
  { id: 'tyres.white-letter', name: 'White Letter', category: 'tyres', price: 400, color: 0xf4f1e8, tyre: { wall: 0xf4f1e8, letters: true } },
  { id: 'tyres.slick', name: 'Race Slicks', category: 'tyres', price: 550, color: 0xffd23a, tyre: { wall: 0xffd23a, letters: true, slick: true } },
  { id: 'tyres.pink-smoke', name: 'Pink Smoke', category: 'tyres', price: 700, color: 0xff3da6, tyre: { wall: 0xff3da6, smoke: 0xff7ac8 } },
  { id: 'tyres.blue-smoke', name: 'Blue Smoke', category: 'tyres', price: 700, color: 0x36a8ff, tyre: { wall: 0x36a8ff, smoke: 0x6cc0ff } },
  { id: 'tyres.neon', name: 'Neon Wall', category: 'tyres', price: 1100, color: 0x36e2ff, tyre: { wall: 0x36e2ff, neon: true, smoke: 0x7ff0ff } },
  { id: 'tyres.rainbow', name: 'Rainbow Smoke', category: 'tyres', price: 1500, color: 0xff3da6, swatch: 'linear-gradient(90deg,#ff3da6,#ffd23a,#36e2ff,#7cff6b)', tyre: { wall: 0xf4f1e8, smoke: 'rainbow' } },

  { id: 'kit.stock', name: 'Stock', category: 'bodykit', price: 0, color: 0x2a2d38 },
  { id: 'kit.street', name: 'Street Kit', category: 'bodykit', price: 500, color: 0x3b3f4d, kit: { splitter: 0.05, skirts: 'paint', valance: true } },
  { id: 'kit.gt-wing', name: 'GT Wing', category: 'bodykit', price: 700, color: 0x4a4f60, kit: { wing: 'gt' } },
  { id: 'kit.wide', name: 'Wide Body', category: 'bodykit', price: 1200, color: 0x5a6072, kit: { flares: true, skirts: 'wide', splitter: 0.07 } },
  { id: 'kit.drift', name: 'Drift Kit', category: 'bodykit', price: 800, color: 0x3b3f4d, kit: { splitter: 0.06, skirts: 'carbon', canards: 1, wing: 'duck' } },
  { id: 'kit.time-attack', name: 'Time Attack', category: 'bodykit', price: 1500, color: 0x6a7186, kit: { splitter: 0.16, skirts: 'carbon', canards: 2, wing: 'ta', valance: true } },

  { id: 'exhaust.factory', name: 'Factory', category: 'exhaust', price: 0, color: 0xc0c6d6, swatch: METAL.chrome },
  { id: 'exhaust.titanium', name: 'Titanium Twin', category: 'exhaust', price: 400, swatch: METAL.titanium, exhaust: { layout: 'twin', tip: 'titanium', flame: 0x9b6bff } },
  { id: 'exhaust.quad', name: 'Quad Sport', category: 'exhaust', price: 600, color: 0x202228, exhaust: { layout: 'quad', tip: 'black', flame: 0x3aa0ff } },
  { id: 'exhaust.center', name: 'Centre Exit', category: 'exhaust', price: 700, swatch: METAL.chrome, exhaust: { layout: 'center', tip: 'chrome', flame: 0xff7a1a } },
  { id: 'exhaust.straight', name: 'Straight Pipes', category: 'exhaust', price: 900, color: 0x6b4a2f, swatch: 'linear-gradient(135deg,#3a2a1f,#b0703a 45%,#5ab0ff 75%,#3a3d52)', exhaust: { layout: 'big', tip: 'burnt', flame: 0x7cff6b } },
  { id: 'exhaust.gold', name: 'Gold Quad', category: 'exhaust', price: 1300, swatch: METAL.gold, exhaust: { layout: 'quad', tip: 'gold', flame: 0xffd23a } },
  { id: 'exhaust.dragon', name: 'Dragon Fire', category: 'exhaust', price: 1600, color: 0xff2a1a, swatch: 'linear-gradient(0deg,#15161f,#ff2a1a 60%,#ffd23a)', exhaust: { layout: 'big', tip: 'black', flame: 0xff2a1a } },

  { id: 'glow.factory', name: 'Factory', category: 'glow', price: 0 },
  { id: 'glow.off', name: 'Off', category: 'glow', price: 0, color: 0x000000 },
  { id: 'glow.cyan', name: 'Cyan', category: 'glow', price: 0, color: 0x36e2ff },
  { id: 'glow.pink', name: 'Pink', category: 'glow', price: 300, color: 0xff3da6 },
  { id: 'glow.yellow', name: 'Yellow', category: 'glow', price: 300, color: 0xffd23a },
  { id: 'glow.green', name: 'Green', category: 'glow', price: 300, color: 0x7cff6b, earn: { unlock: 'green', text: CHALLENGE } },
  { id: 'glow.rainbow', name: 'Rainbow cycle', category: 'glow', price: 1000, color: 0xff3da6, rainbow: true, swatch: 'linear-gradient(90deg,#ff3da6,#ffd23a,#36e2ff,#7cff6b)' },

  { id: 'logo.none', name: 'None', category: 'logo', price: 0 },
  { id: 'logo.hood', name: 'Hood Logo', category: 'logo', price: 500, decal: ['hood'] },
  { id: 'logo.doors', name: 'Door Logos', category: 'logo', price: 700, decal: ['doors'] },
  { id: 'logo.full', name: 'Full Branding', category: 'logo', price: 1100, decal: ['hood', 'doors'] },

  { id: 'plate.none', name: 'None', category: 'plate', price: 0 },
  { id: 'plate.euro', name: 'Euro', category: 'plate', price: 300, plate: 'euro' },
  { id: 'plate.classic', name: 'Classic', category: 'plate', price: 300, plate: 'classic' },
  { id: 'plate.black', name: 'Blackout', category: 'plate', price: 450, plate: 'black' },
  { id: 'plate.gold', name: 'Gold', category: 'plate', price: 900, plate: 'gold' },
  { id: 'plate.neon', name: 'Neon', category: 'plate', price: 1200, plate: 'neon' },

  { id: 'steering.factory', name: 'Factory', category: 'steering', price: 0, wheel: 'factory' },
  { id: 'steering.sport', name: 'Sport Suede', category: 'steering', price: 350, wheel: 'sport' },
  { id: 'steering.wood', name: 'Classic Wood', category: 'steering', price: 500, wheel: 'wood' },
  { id: 'steering.carbon', name: 'Carbon Yoke', category: 'steering', price: 900, wheel: 'yoke' },
  { id: 'steering.neon', name: 'Neon Rim', category: 'steering', price: 1000, wheel: 'neon' },
  { id: 'steering.gold', name: 'Gold Rally', category: 'steering', price: 1200, wheel: 'gold' },

  { id: 'engine.stock', name: 'Stock', category: 'engine', price: 0 },
  { id: 'engine.street', name: 'Street Tune', category: 'engine', price: 600, engine: { power: 0.02, top: 0.4, nitro: 0, charge: 0, sound: 'stock' } },
  { id: 'engine.turbo', name: 'Twin Turbo', category: 'engine', price: 1400, engine: { power: 0.04, top: 0.8, nitro: 0.4, charge: 0, sound: 'turbo' } },
  { id: 'engine.v12', name: 'V12 Swap', category: 'engine', price: 2200, engine: { power: 0.02, top: 1.5, nitro: 1, charge: 0, sound: 'v12' } },
  { id: 'engine.electric', name: 'Electric', category: 'engine', price: 3000, engine: { power: 0.06, top: 0.3, nitro: 0.3, charge: 0.05, sound: 'electric' } },
  { id: 'engine.race', name: 'Race Spec', category: 'engine', price: 4200, engine: { power: 0.05, top: 1.5, nitro: 1, charge: 0.03, sound: 'race' } },
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
// The base rate is ₦100 for 500 tokens (₦0.20 a token); a pack's bonus is extra tokens on top of what its price buys.
export const PACKS = [
  { id: 'pit-stop', name: 'Pit Stop', tokens: 500, price_kobo: 10000, badge: '' }, // ₦100
  { id: 'podium', name: 'Podium', tokens: 1200, price_kobo: 20000, badge: 'Popular', bonus: '+20% bonus' }, // ₦200
  { id: 'champion', name: 'Champion', tokens: 3000, price_kobo: 40000, badge: 'Best value', bonus: '+50% bonus' }, // ₦400
  { id: 'legend', name: 'Legend', tokens: 8000, price_kobo: 100000, badge: '', bonus: '+60% bonus' }, // ₦1,000
];
// only for an account's first purchase: its tokens at the base rate, and the parts in `grants` on top
export const STARTER_PACK = { id: 'starter', name: 'Starter Pack', tokens: 1500, price_kobo: 30000, badge: 'One-time', grants: ['paint.gold-leaf'] }; // ₦300
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
