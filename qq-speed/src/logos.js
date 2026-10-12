// Players' own logos (the Garage's Logo parts). A picture the player picks is fitted into a small square here, on
// their device, then kept by its key (the first 16 bytes of its SHA-256, in hex): a guest's only on this device,
// an account's on the server too (POST /wallet/logo), which serves it to everyone at GET /logo/<key>. So other
// players see a logo once it's on an account; a guest's shows only to them.
import * as THREE from 'three';
import { LOGO_KEY_RE } from './netproto.js';

export const LOGO_SIZE = 256; // px, square
export const LOGO_MAX = 48 * 1024; // bytes; the server takes no more
const STORE = 'driftbolt.logos.v1'; // { [key]: data URL }, the newest last
const KEEP = 6;

let base = '';
let hideOthers = false;
// the game server (http…), where logos on accounts are served from
export function setServer(b) { base = b || ''; }
// a setting: other players' logos aren't drawn (their cars show without them)
export function setHideOthers(on) { hideOthers = !!on; }
export const othersHidden = () => hideOthers;

const read = () => { try { const o = JSON.parse(localStorage.getItem(STORE)); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
function remember(key, url) {
  const o = read();
  delete o[key];
  o[key] = url;
  const keys = Object.keys(o);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete o[k];
  try { localStorage.setItem(STORE, JSON.stringify(o)); } catch { /* full or off: this visit only */ }
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function logoKey(bytes) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16)); }
const blobOf = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));
const dataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

// A picture file the player picked → { key, bytes, type, url }: fitted into a LOGO_SIZE square (transparent around
// it), as WebP (PNG where the browser can't make WebP), small enough for LOGO_MAX. Throws 'type' or 'size'.
export async function prepareLogo(file) {
  if (!file || !/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) throw new Error('type');
  if (file.size > 10 * 1024 * 1024) throw new Error('size');
  let img;
  try { img = await createImageBitmap(file); } catch { throw new Error('type'); }
  for (const [size, q] of [[LOGO_SIZE, 0.9], [LOGO_SIZE, 0.75], [192, 0.75], [160, 0.6], [128, 0.55]]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const k = Math.min(size / img.width, size / img.height), w = img.width * k, h = img.height * k;
    c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    let blob = await blobOf(c, 'image/webp', q);
    if (!blob || blob.type !== 'image/webp') blob = await blobOf(c, 'image/png');
    if (blob && blob.size <= LOGO_MAX) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { key: await logoKey(bytes), bytes, type: blob.type, url: await dataUrl(blob) };
    }
  }
  img.close?.();
  throw new Error('size');
}

// keep a logo on this device (every logo the player makes is kept here, so it shows even before or without the server)
export function keepLocal(key, url) { remember(key, url); refresh(key, url); }

// this device's copy of a logo (a data URL), to upload; '' if it was made elsewhere
export const localData = (key) => read()[key] || '';
// the logo made last on this device
export function latestLocal() { const k = Object.keys(read()); return k[k.length - 1] || ''; }

// where to load a logo from: this device's copy, else the server's
export function logoUrl(key) {
  if (!LOGO_KEY_RE.test(key || '')) return '';
  return read()[key] || (base ? `${base}/logo/${key}` : '');
}

// ---------- Textures ----------
// One texture per logo, shared by every car that carries it. It starts empty (see-through) and fills in when the
// picture arrives; a logo that can't be loaded stays see-through.
const textures = new Map();
const blank = () => { const c = document.createElement('canvas'); c.width = c.height = 1; return c; };
export function logoTexture(key) {
  if (!LOGO_KEY_RE.test(key || '')) return null;
  let t = textures.get(key);
  if (t) return t;
  t = new THREE.Texture(blank());
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  textures.set(key, t);
  load(key, logoUrl(key));
  return t;
}
function load(key, url) {
  if (!url) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = () => {
    const t = textures.get(key);
    if (!t) return;
    t.image = img;
    t.needsUpdate = true;
  };
  img.src = url;
}
// a logo just made: any texture already waiting for it fills in
function refresh(key, url) { if (textures.has(key)) load(key, url); }
