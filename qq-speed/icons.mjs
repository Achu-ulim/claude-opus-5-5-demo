// Renders the Driftbolt app icons in public/icons from the SVG logo below, using the locally installed Chrome.
// Run after changing the logo: node icons.mjs
import { chromium } from 'playwright-core';

// The bolt (also inlined as the menu logo in src/index.html), drawn on a 512×512 canvas
const BOLT = 'M318 64 156 290h94l-50 162 162-240h-94z';

// rounded: transparent corners (browser tabs, install prompts); otherwise full bleed for OS masks.
// scale shrinks the artwork into the mask's safe zone. simple drops the fine detail that turns to mush at favicon size.
function logo({ size, rounded = true, scale = 1, simple = false }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2148b8"/><stop offset=".55" stop-color="#0e1f5c"/><stop offset="1" stop-color="#060c26"/>
    </linearGradient>
    <radialGradient id="glow" cx=".5" cy=".58" r=".5">
      <stop offset="0" stop-color="#27c7ff" stop-opacity=".38"/><stop offset="1" stop-color="#27c7ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="bolt" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff6b0"/><stop offset=".35" stop-color="#ffd23a"/><stop offset="1" stop-color="#ff7a00"/>
    </linearGradient>
    <linearGradient id="trail" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#27c7ff" stop-opacity="0"/><stop offset=".6" stop-color="#27c7ff"/><stop offset="1" stop-color="#bff0ff"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="url(#bg)"/>
  <rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="url(#glow)"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -258)">
    <!-- drift arc: the skid line the bolt swings through -->
    <path d="M64 344C130 466 364 474 452 320" fill="none" stroke="url(#trail)" stroke-width="${simple ? 34 : 26}" stroke-linecap="round"/>
    ${simple ? '' : `<path d="M120 412C196 470 334 470 404 408" fill="none" stroke="url(#trail)" stroke-width="10" stroke-linecap="round" opacity=".55"/>
    <path d="M96 150H222M128 190H206" stroke="#ffffff" stroke-width="12" stroke-linecap="round" opacity=".5"/>`}
    <path d="${BOLT}" fill="#030817" opacity=".7" transform="translate(16 16)"/>
    <path d="${BOLT}" fill="url(#bolt)" stroke="#ffffff" stroke-width="${simple ? 14 : 8}" stroke-linejoin="round"/>
  </g>
</svg>`;
}

const ICONS = [
  ['icon-512.png', { size: 512 }],
  ['icon-192.png', { size: 192 }],
  ['maskable-512.png', { size: 512, rounded: false, scale: 0.78 }],
  ['apple-touch-icon.png', { size: 180, rounded: false, scale: 0.9 }],
  ['favicon-64.png', { size: 64, scale: 1.12, simple: true }],
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
