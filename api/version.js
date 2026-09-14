// /api/version.js — the build string this deployment is serving.
//
// Why this exists: the service worker is cache-first and the browser only
// re-checks sw.js on navigation or every ~24h. A tab that never navigates —
// or an installed PWA left open — can therefore run last week's JavaScript
// indefinitely. A rower user opened PedalSync on Sep 11, kept the tab open,
// and was still running pre-rower-fix code on Sep 14: the code that picks up a
// deploy shipped inside the deploy that page never received. js/pwa.js polls
// this hourly and, on a mismatch, forces a worker update; controllerchange
// then does the reload (or defers it to the end of the workout).
//
// BUILD must equal CACHE_NAME in sw.js and PS.BUILD in js/state.js.
// It lives here rather than in an env var so it cannot silently drift from
// them, and test/test_frames.js fails if the three ever disagree.
const BUILD = 'v20';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');   // a static build string, no user data
  res.status(200).json({ build: BUILD });
}
