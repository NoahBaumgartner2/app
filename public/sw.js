// Minimal Service Worker — ermöglicht PWA-Installation auf Android/Chrome.
// iOS braucht keinen SW, aber er schadet nicht.
// Strategie: immer Netzwerk (kein Caching), damit Auth-Sessions niemals gecacht werden.
const CACHE = 'meditracker-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  // Nur GET-Requests, keine opaque Cross-Origin-Requests cachen
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
