// Offensive words, for text players choose that others see: usernames (server/src/names.js) and number plates
// (netproto.js cleanLook). A starting list, meant to grow: long roots match anywhere in the text, short words only on
// their own (split at spaces, _, digits and camelCase), so Cassidy and Cockpit stay allowed; innocent words that hide
// a root are taken out first (Therapist, Scunthorpe). Imported by the game and the server: no browser code here.
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' };
const ROOTS = [
  'fuck', 'fuk', 'shit', 'cunt', 'nigg', 'niga', 'faggot', 'fagot', 'bitch', 'whore', 'slut', 'rapist', 'raping', 'pussy',
  'penis', 'vagina', 'porn', 'hentai', 'nazi', 'hitler', 'retard', 'asshole', 'bastard', 'molest', 'pedophile', 'paedo',
  'wetback', 'tranny', 'jizz', 'dildo', 'twat', 'wank', 'killyourself', 'kkk', 'chink', 'kike', 'spick', 'beaner',
];
const SAFE = /therapist|scunthorpe|penistone|shitake|matsushita/g;
const WORDS = ['ass', 'arse', 'cum', 'cock', 'dick', 'fag', 'sex', 'rape', 'anal', 'coon', 'spic', 'pedo', 'tits', 'boobs', 'kys', 'nonce', 'gook'];

export function offensive(text) {
  const spaced = String(text).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[0134578]/g, (d) => LEET[d]);
  const flat = spaced.replace(/[^a-z]/g, '').replace(SAFE, '');
  const words = spaced.split(/[^a-z]+/).filter(Boolean);
  return ROOTS.some((r) => flat.includes(r)) || WORDS.some((w) => words.includes(w) || flat === w);
}
