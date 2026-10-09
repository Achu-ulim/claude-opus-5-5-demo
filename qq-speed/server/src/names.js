// Which usernames can be registered: the shape (netproto.js), then names that would pass for the game or its staff,
// and offensive ones. A starting list, meant to grow: long roots match anywhere in the name, short words only on their
// own (split at _, digits and camelCase), so Cassidy and Cockpit stay allowed; innocent words that hide a root are
// taken out first (Therapist, Scunthorpe).
import { USERNAME_RE } from '../../src/netproto.js';

const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'sysadmin', 'mod', 'moderator', 'staff', 'support', 'help', 'helpdesk',
  'official', 'team', 'server', 'bot', 'robot', 'cpu', 'guest', 'player', 'driver', 'anonymous', 'anon', 'unknown',
  'null', 'undefined', 'none', 'nobody', 'everyone', 'all', 'here', 'you', 'host', 'owner', 'security', 'abuse',
  'postmaster', 'webmaster', 'noreply', 'no_reply', 'info', 'contact', 'billing', 'account', 'accounts', 'login', 'signup',
]);
// anywhere in the name
const RESERVED_PARTS = ['driftbolt', 'admin', 'moderator', 'official'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' };
const ROOTS = [
  'fuck', 'fuk', 'shit', 'cunt', 'nigg', 'niga', 'faggot', 'fagot', 'bitch', 'whore', 'slut', 'rapist', 'raping', 'pussy',
  'penis', 'vagina', 'porn', 'hentai', 'nazi', 'hitler', 'retard', 'asshole', 'bastard', 'molest', 'pedophile', 'paedo',
  'wetback', 'tranny', 'jizz', 'dildo', 'twat', 'wank', 'killyourself', 'kkk', 'chink', 'kike', 'spick', 'beaner',
];
const SAFE = /therapist|scunthorpe|penistone|shitake|matsushita/g;
const WORDS = ['ass', 'arse', 'cum', 'cock', 'dick', 'fag', 'sex', 'rape', 'anal', 'coon', 'spic', 'pedo', 'tits', 'boobs', 'kys', 'nonce', 'gook'];

// null when the name can be registered; otherwise 'format' or 'not_allowed'
export function nameProblem(name) {
  if (typeof name !== 'string' || !USERNAME_RE.test(name)) return 'format';
  const lower = name.toLowerCase();
  if (RESERVED.has(lower) || RESERVED_PARTS.some((p) => lower.includes(p))) return 'not_allowed';
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[0134578]/g, (d) => LEET[d]);
  const flat = spaced.replace(/[^a-z]/g, '').replace(SAFE, '');
  const words = spaced.split(/[^a-z]+/).filter(Boolean);
  if (ROOTS.some((r) => flat.includes(r)) || WORDS.some((w) => words.includes(w) || flat === w)) return 'not_allowed';
  return null;
}
