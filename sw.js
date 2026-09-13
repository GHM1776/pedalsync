// PedalSync Service Worker — enables offline telemetry
const CACHE_NAME = 'pedalsync-v17';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/css/pedalsync.css',
  '/js/state.js',
  '/js/diag-capture.js',
  '/js/pwa.js',
  '/js/ble.js',
  '/js/bike-dashboard.js',
  '/js/rower-dashboard.js',
  '/js/treadmill-dashboard.js',
  '/js/export.js',
  '/js/coach.js',
  '/js/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go to network for API calls
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Return cached version, but also update cache in background
      const fetchPromise = fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});