/* Service worker — required for the app to count as installable, and it makes
   the app work with no network once it has been opened once. */
const CACHE = 'digital-clay-v1';
const SHELL = [
  './', './index.html', './clay.js', './manifest.webmanifest',
  './vendor/three.module.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Never touch the export POST or the live-reload stream.
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).pathname === '/live') return;

  // Network first, cache as fallback. Cache-first would happily serve you
  // yesterday's code while you wonder why your edit did nothing.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
