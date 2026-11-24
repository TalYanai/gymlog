// Step 2e — service worker: offline copy of the app shell. It caches only the app's own files
// (listed in precache.json by scripts/build-dist.mjs) and never touches localStorage or user data.
// Version: the ?v= of the registration URL, which must equal precache.json's version.
const VERSION = new URL(self.location.href).searchParams.get('v') || 'none';
const CACHE = `gymlog-${VERSION}`;
const NETWORK_ONLY = ['precache.json']; // always fresh: the page learns of updates from it

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const res = await fetch('precache.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`precache.json ${res.status}`);
    const list = await res.json();
    if (list.version !== VERSION) throw new Error(`version mismatch ${list.version} ≠ ${VERSION}`); // a deploy raced: do not mix versions
    const cache = await caches.open(CACHE);
    await cache.addAll(list.files.map((f) => new Request(f, { cache: 'reload' })));
    // No skipWaiting here: the page activates an update only after the user agrees and pending
    // input has been flushed (src/ui/pwa.js).
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('gymlog-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (NETWORK_ONLY.includes(path) || path.startsWith('sw.js') || path.startsWith('api/')) return; // sync calls always go to the network
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match(new URL('./', self.registration.scope).href);
      if (shell) return shell;
    }
    return fetch(req);
  })());
});
