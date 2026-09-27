// Deliberately does no caching at all - this is a live financial dashboard, and a cached
// stale response for /api/cashflow or /api/pnl would be actively misleading, not a
// convenience. Its only job is to exist and handle fetch, which is what lets Chrome/Edge
// treat the site as installable (the manifest.json + icons + meta tags in index.html are
// what actually make an install look/feel like an app - this file just satisfies the
// "has a registered service worker" half of that criteria).
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
