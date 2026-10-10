// Offline support. The whole game is one HTML file, so caching it (plus the manifest and icons) is enough to play offline.
// The version token below is replaced at build time with a hash of the build, so every deploy gets a fresh cache.
const CACHE = 'speed3d-__VERSION__';
// "./" rather than "./index.html": the host redirects /index.html to /, and navigations can't be answered with a redirect
const CORE = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-64.png'];

// Every device switches to a new version by itself: it takes over as soon as it has downloaded, without waiting for
// the old version's pages to close
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => {
        const old = keys.filter((k) => k.startsWith('speed3d-') && k !== CACHE);
        return Promise.all(old.map((k) => caches.delete(k))).then(() => self.clients.claim()).then(() => old.length > 0);
      })
      // not waited for: fetches wait until activation ends
      .then((replaced) => { if (replaced) reloadPages(); }),
  );
});

// Game pages still running the version this one replaced. A page that answers 'updated' reloads itself at a quiet
// moment (in the menu, not in a race, a room or a payment: setupPWA in main.js); pages from before that existed don't
// answer and are reloaded now.
const ANSWER_WITHIN = 4000;
async function reloadPages() {
  const pages = (await self.clients.matchAll({ type: 'window' })).filter((p) => /^\/(index\.html)?$/.test(new URL(p.url).pathname));
  await Promise.all(pages.map(async (page) => {
    const answered = await new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve(true);
      setTimeout(() => resolve(false), ANSWER_WITHIN);
      page.postMessage('updated', [ch.port2]);
    });
    if (!answered && page.navigate) await page.navigate(page.url).catch(() => {});
  }));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // the game's own files only: the online server's answers (accounts, wallet, payments, leagues, health) always come
  // from the network
  if (req.method !== 'GET' || url.origin !== self.location.origin || /^\/(auth|wallet|pay|paystack|league|ws|health)(\/|$)/.test(url.pathname)) return;
  // cache first: instant start, works offline; updates arrive through a new service worker version. Only the game is
  // one page: other pages (terms, refunds) are themselves.
  if (req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    e.respondWith(caches.match('./').then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
