// PedalSync Service Worker — enables offline telemetry
const CACHE_NAME = 'pedalsync-v21';
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

// ---- Legacy-page census ----
// Pages loaded before the update-pickup code shipped (v13, Sep 11) have no
// controllerchange handler and no version poller: the code that picks up a
// deploy is itself inside the deploy they never received, so nothing in the page
// can be called into. WindowClient.navigate() is the only lever left, and it is
// not safe to pull. Chrome strips the fragment from WindowClient.url — measured
// here: a page sitting on '#bike' reports plain '/', and so does one navigated
// straight to '/#rower' — so this worker cannot tell a page mid-workout from an
// idle one, and navigating one mid-row would destroy the ride it is recording.
//
// So it only counts them. Modern pages answer a ping; silence is a page that
// cannot update itself. The numbers say how large that population is and when it
// has drained. Reaching one is a tab close, or a note to a user we can email.
//
// Deliberately not awaited in waitUntil: holding activation blocks every fetch
// from controlled pages. A worker shut down before the delay elapses simply
// counts again on the next activation.
const LEGACY_PROBE_DELAY_MS = 20000;   // let modern pages finish their own reload and re-register first
const LEGACY_PONG_MS = 3000;
let legacyProbeStarted = false;

function swPulse(event, value) {
  const url = 'https://pulse.intrepidend.com/e?s=pedalsync&p=/sw&i=sw'
    + '&e=' + encodeURIComponent(event)
    + (value == null ? '' : '&v=' + encodeURIComponent(String(value)));
  try { fetch(url, { keepalive: true, mode: 'no-cors' }).catch(() => {}); } catch (e) { /* give up quietly */ }
}

// Resolves true if the page answered — i.e. it has its own update path
function answersPing(client) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(false), LEGACY_PONG_MS);
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => finish(true);
      client.postMessage({ ps: 'ping', build: CACHE_NAME }, [ch.port2]);
    } catch (e) { finish(false); }
  });
}

async function countLegacyPages() {
  if (legacyProbeStarted) return;
  legacyProbeStarted = true;
  await new Promise((r) => setTimeout(r, LEGACY_PROBE_DELAY_MS));
  const windows = await self.clients.matchAll({ type: 'window' });
  for (const c of windows) {
    if (await answersPing(c)) continue;                  // has its own update path — nothing to report
    swPulse('sw_legacy_page', c.visibilityState || 'unknown');
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const upgrade = keys.some((k) => k !== CACHE_NAME);   // false on a first install
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
    if (upgrade) countLegacyPages().catch(() => {});      // not awaited: see above
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go to network for API calls
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Scoped to THIS build's cache on purpose. caches.match() searches every
  // cache in the origin, so while a deploy is mid-cleanup a reload could be
  // answered out of the previous build's cache — the page comes back on the old
  // code, the loop guard sees its own build, and it is pinned there. Reading
  // only CACHE_NAME makes a new worker incapable of serving old assets.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => cache.match(event.request)).then((cached) => {
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