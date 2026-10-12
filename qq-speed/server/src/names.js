// Which usernames can be registered: the shape (netproto.js), then names that would pass for the game or its staff,
// and offensive ones (src/words.js, shared with number plates).
import { USERNAME_RE } from '../../src/netproto.js';
import { offensive } from '../../src/words.js';

const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'sysadmin', 'mod', 'moderator', 'staff', 'support', 'help', 'helpdesk',
  'official', 'team', 'server', 'bot', 'robot', 'cpu', 'guest', 'player', 'driver', 'anonymous', 'anon', 'unknown',
  'null', 'undefined', 'none', 'nobody', 'everyone', 'all', 'here', 'you', 'host', 'owner', 'security', 'abuse',
  'postmaster', 'webmaster', 'noreply', 'no_reply', 'info', 'contact', 'billing', 'account', 'accounts', 'login', 'signup',
]);
// anywhere in the name
const RESERVED_PARTS = ['driftbolt', 'admin', 'moderator', 'official'];

// null when the name can be registered; otherwise 'format' or 'not_allowed'
export function nameProblem(name) {
  if (typeof name !== 'string' || !USERNAME_RE.test(name)) return 'format';
  const lower = name.toLowerCase();
  if (RESERVED.has(lower) || RESERVED_PARTS.some((p) => lower.includes(p))) return 'not_allowed';
  if (offensive(name)) return 'not_allowed';
  return null;
}
