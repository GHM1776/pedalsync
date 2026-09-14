// Version-poller decision table + the service worker's page probe.
// Run from the repo root:  node test/test_version.js
//
// A tab that never navigates only re-checks sw.js every ~24h, so one left open
// on Sep 11 was still running pre-rower-fix code on Sep 14. /api/version closes
// that gap. Two things must hold, and both are easy to get wrong:
//
//   1. A mismatch must NOT reload the page directly. The old cache-first worker
//      would serve the old assets straight back, the loop guard would see its
//      own build and pin the page there for good. It must force a worker update
//      and let controllerchange reload with the mid-workout guards.
//   2. An endpoint reporting an OLDER build (a rollback, a stale value) must do
//      nothing at all — never a reload, never a loop.
//
// The end-to-end chain (real worker swap, real reload) is covered by the
// headless sw-update-test; this pins the decisions.
const fs = require('fs');
const path = require('path');
const J = path.join(__dirname, '..', 'js');
let fail = 0;
const check = (n, c, d) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) { fail++; if (d !== undefined) console.log('   ' + JSON.stringify(d)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- browser stubs ----
const pulse = [];
global.window = global;
global.location = { origin: 'http://x', pathname: '/', hash: '', reload() { reloads++; } };
let reloads = 0;
const store = () => ({ _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } });
global.sessionStorage = store(); global.localStorage = store();
const el = () => ({ classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, style: {}, textContent: '', disabled: false });
const domListeners = {};
global.document = {
  visibilityState: 'visible',
  addEventListener: (t, fn) => { (domListeners[t] = domListeners[t] || []).push(fn); },
  getElementById: el, querySelector: el, querySelectorAll: () => [],
};
const winListeners = {};
global.addEventListener = (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); };
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.__pulse = (e, v) => pulse.push(e + (v ? ':' + v : ''));

// setInterval spy — the hourly poll must be registered, and only while visible
const intervals = [];
const realSetInterval = global.setInterval, realClearInterval = global.clearInterval;
global.setInterval = (fn, ms) => { const h = realSetInterval(() => {}, 1e9); intervals.push({ h, ms, fn }); return h; };
global.clearInterval = (h) => { const i = intervals.findIndex(x => x.h === h); if (i !== -1) intervals.splice(i, 1); realClearInterval(h); };

// ---- fake service worker registration + message channel ----
let updateCalls = 0;
const swListeners = {};
// Node 22 ships a built-in `navigator` accessor: replacing it is silently ignored, so mutate it
navigator.serviceWorker = {
  controller: {},
  register: async () => ({ update: async () => { updateCalls++; } }),
  addEventListener: (t, fn) => { (swListeners[t] = swListeners[t] || []).push(fn); },
};

// ---- fake /api/version ----
let serverBuild = null;      // null = the request fails
let status = 200;
global.fetch = async (url) => {
  if (String(url).indexOf('/api/version') === -1) throw new Error('unexpected fetch ' + url);
  if (serverBuild === null) throw new Error('offline');
  return { ok: status === 200, status, json: async () => ({ build: serverBuild }) };
};

eval(fs.readFileSync(path.join(J, 'state.js'), 'utf8'));
eval(fs.readFileSync(path.join(J, 'pwa.js'), 'utf8'));
const s = PS.state;

(async () => {
  (winListeners['DOMContentLoaded'] || []).forEach(fn => fn({}));
  await sleep(10);   // register() resolves

  check('hourly version poll registered on load, at PS.VERSION_POLL_MS',
    intervals.length === 1 && intervals[0].ms === PS.VERSION_POLL_MS, { n: intervals.length, ms: intervals[0] && intervals[0].ms });
  check('SW message + controllerchange listeners registered',
    (swListeners['message'] || []).length === 1 && (swListeners['controllerchange'] || []).length === 1);

  // ---- decision table ----
  async function decide(build, label, httpStatus) {
    serverBuild = build; status = httpStatus || 200;
    pulse.length = 0; updateCalls = 0; reloads = 0;
    await PSCheckVersion(true);
    await sleep(5);
    return { events: pulse.slice(), updates: updateCalls, reloads: reloads, label };
  }

  let r = await decide('v20', 'same build');
  check('same build → nothing at all', r.events.length === 0 && r.updates === 0 && r.reloads === 0, r);

  r = await decide('v21', 'newer build');
  check('newer build → version_mismatch event + forced worker update, and NO direct reload',
    r.events.length === 1 && r.events[0] === 'sw_update:version_mismatch:v20>v21' && r.updates === 1 && r.reloads === 0, r);

  r = await decide('v20-t4', 'same number, different string (test tag)');
  check('same number but a different build string → treated as an update', r.updates === 1 && r.reloads === 0, r);

  r = await decide('v19', 'older build');
  check('endpoint BEHIND this page (rollback/stale) → nothing, never a reload backwards',
    r.events.length === 0 && r.updates === 0 && r.reloads === 0, r);

  r = await decide('unknown', 'unknown');
  check('build "unknown" (missing value) → nothing', r.events.length === 0 && r.updates === 0 && r.reloads === 0, r);

  r = await decide('v21', 'http 500', 500);
  check('non-200 response → nothing', r.events.length === 0 && r.updates === 0 && r.reloads === 0, r);

  serverBuild = null;
  r = await decide(null, 'offline');
  check('offline / rejected fetch → nothing, no throw', r.events.length === 0 && r.updates === 0 && r.reloads === 0, r);

  // ---- throttle ----
  serverBuild = 'v21'; pulse.length = 0; updateCalls = 0;
  await PSCheckVersion();   // unforced, straight after the forced calls above
  await sleep(5);
  check('unforced call inside the 30-min window is throttled', updateCalls === 0 && pulse.length === 0, { updates: updateCalls, pulse });

  // ---- the worker's probe: answering is what marks a page as self-updating ----
  const onMessage = swListeners['message'][0];
  function ping(data) {
    const replies = [];
    onMessage({ data: data, ports: [{ postMessage: (m) => replies.push(m) }] });
    return replies;
  }
  let replies = ping({ ps: 'ping', build: 'pedalsync-v21' });
  check('ping answered with this page\'s build and its busy state',
    replies.length === 1 && replies[0].ps === 'pong' && replies[0].build === 'v20' && replies[0].busy === false, replies);

  check('a message that is not a ping is ignored', ping({ ps: 'something-else' }).length === 0);
  check('a ping with no reply port does not throw', (function() {
    try { onMessage({ data: { ps: 'ping' }, ports: [] }); return true; } catch (e) { return false; }
  })());

  s.bleDevice = { gatt: { connected: true } };
  replies = ping({ ps: 'ping' });
  check('mid-workout page answers busy:true (the worker must leave it alone)', replies[0].busy === true, replies);
  s.bleDevice = null;

  PS.lastRideShowing = () => true;
  replies = ping({ ps: 'ping' });
  check('un-exported workout on the connect screen also answers busy:true', replies[0].busy === true, replies);
  PS.lastRideShowing = () => false;

  PS.connectInFlight = () => true;
  replies = ping({ ps: 'ping' });
  check('mid-connect page answers busy:true (a reload would kill the picker)', replies[0].busy === true, replies);
  PS.connectInFlight = () => false;

  // ---- the poll follows visibility ----
  document.visibilityState = 'hidden';
  (domListeners['visibilitychange'] || []).forEach(fn => fn({}));
  check('poll stopped while the tab is hidden', intervals.length === 0, intervals.map(i => i.ms));
  document.visibilityState = 'visible';
  (domListeners['visibilitychange'] || []).forEach(fn => fn({}));
  check('poll restarted when the tab comes back', intervals.length === 1 && intervals[0].ms === PS.VERSION_POLL_MS);
  (domListeners['visibilitychange'] || []).forEach(fn => fn({}));
  check('a second visible event does not stack a second interval', intervals.length === 1);

  console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
