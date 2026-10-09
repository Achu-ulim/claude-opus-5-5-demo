// Renders the Driftbolt app icons in public/icons from the SVG logo below, using the locally installed Chrome.
// Run after changing the logo: node icons.mjs
import { chromium } from 'playwright-core';

// The bolt with two speed lines on a near-black tile, drawn on a 512×512 canvas.
// (The menu logo inlined in src/index.html is the older gradient bolt.)
const BOLT = 'M346 80h37l-59 140h80L258 429l40-154h-73z';

// rounded: transparent corners and a hairline rim (browser tabs, install prompts); otherwise full bleed for OS masks.
// scale shrinks the artwork into the mask's safe zone. simple drops the rim, which turns to mush at favicon size.
function logo({ size, rounded = true, scale = 1, simple = false }) {
  const r = rounded ? 108 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${r}" fill="#07080f"/>
  ${rounded && !simple ? `<rect x="2" y="2" width="508" height="508" rx="${r - 2}" fill="none" stroke="#292a34" stroke-width="4"/>` : ''}
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <rect x="70" y="197" width="160" height="20" rx="10" fill="#36e2ff"/>
    <rect x="100" y="260" width="104" height="21" rx="10.5" fill="#238b9f"/>
    <path d="${BOLT}" fill="#ffd23a"/>
  </g>
</svg>`;
}

const ICONS = [
  ['icon-512.png', { size: 512 }],
  ['icon-192.png', { size: 192 }],
  ['maskable-512.png', { size: 512, rounded: false, scale: 0.78 }],
  ['apple-touch-icon.png', { size: 180, rounded: false, scale: 0.9 }],
  ['favicon-64.png', { size: 64, scale: 1.1, simple: true }],
];

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
for (const [file, opts] of ICONS) {
  await page.setViewportSize({ width: opts.size, height: opts.size });
  await page.setContent(`<body style="margin:0;background:transparent">${logo(opts)}</body>`);
  await page.locator('svg').screenshot({ path: `public/icons/${file}`, omitBackground: true });
  console.log('public/icons/' + file);
}
await browser.close();
