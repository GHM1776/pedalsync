// End-of-workout paths — run from the repo root: node test/test_reconnect.js
//
// Drives the real modules (state, pwa, ble, dashboards, export, coach, app) with
// a fake Web Bluetooth device whose gatt.connect() can succeed, fail fast (not
// advertising) or hang. Covers: the asleep-equipment tiebreaker, END WORKOUT during
// a retry, the hard-fail banner with its inactivity auto-end and tap reset, the
// last-workout card + export after a normal DISCONNECT, a pending SW update held
// while the card is showing, and ride_complete firing exactly once per workout.
const fs = require('fs');
const path = require('path');
const J = path.join(__dirname, '..', 'js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (n, c, d) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) { fail++; if (d !== undefined) console.log('   ' + JSON.stringify(d)); } };

// ---- browser stubs ----
const pulse = [];
global.window = global;
global.location = { origin: 'http://x', pathname: '/', hash: '' };
const store = () => ({ _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } });
global.sessionStorage = store(); global.localStorage = store();
function mkEl(id) {
  const cls = new Set();
  const el = { id, style: {}, disabled: false, value: '20', dataset: {}, href: '', children: [], _t: '',
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, f) => { (f === undefined ? !cls.has(c) : f) ? cls.add(c) : cls.delete(c); }, contains: c => cls.has(c) },
    appendChild(ch) { this.children.push(ch); }, removeChild() {}, click() {}, addEventListener() {}, closest() { return null; }, querySelector() { return null; } };
  Object.defineProperty(el, 'textContent', { get() { return this._t; }, set(v) { this._t = String(v); this.children = []; } });
  if (id === 'last-ride' || id === 'connect-trouble' || id === 'no-cadence-hint') cls.add('hidden');   // as in index.html
  return el;
}
const els = {};
const docListeners = {};
global.document = {
  getElementById: id => els[id] || (els[id] = mkEl(id)),
  querySelector: q => els[q] || (els[q] = mkEl(q)),
  querySelectorAll: q => [els[q] || (els[q] = mkEl(q))],
  createElement: () => mkEl('el'),
  addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
  dispatch: t => (docListeners[t] || []).forEach(fn => fn({})),
  body: { appendChild() {}, removeChild() {} },
  visibilityState: 'visible',
};
global.addEventListener = () => {};
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.__pulse = (e, v) => pulse.push(e + (v ? ':' + v : ''));
global.alert = () => {};
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// ---- fake Web Bluetooth ----
let connectMode = 'ok';      // 'ok' | 'failfast' | 'hang'
let pendingResolve = null;   // resolves a hung connect
let rdCalls = 0;
class FakeChar {
  constructor(uuid) { this.uuid = uuid; this.listeners = []; }
  async startNotifications() { return this; }
  addEventListener(t, fn) { if (t === 'characteristicvaluechanged') this.listeners.push(fn); }
  removeEventListener(t, fn) { this.listeners = this.listeners.filter(f => f !== fn); }
  async writeValue() {}
  emit(bytes) { const buf = Uint8Array.from(bytes); this.value = new DataView(buf.buffer); const ev = { target: this }; this.listeners.slice().forEach(fn => fn(ev)); }
}
class FakeGatt {
  constructor(device) { this.device = device; this.connected = false; }
  connect() {
    if (connectMode === 'ok') { this.connected = true; return Promise.resolve(this); }
    if (connectMode === 'failfast') { const e = new Error('Connection attempt failed.'); e.name = 'NetworkError'; return Promise.reject(e); }
    return new Promise(res => { pendingResolve = () => { this.connected = true; res(this); }; });   // hang
  }
  disconnect() { if (!this.connected) return; this.connected = false; this.device._fire('gattserverdisconnected'); }
  async getPrimaryService() { return this.device.service; }
}
class FakeDevice {
  constructor(name) {
    this.id = 'dev-1'; this.name = name; this.gatt = new FakeGatt(this); this._l = {};
    this.f2 = new FakeChar(PS.ECH_WRITE); this.f3 = new FakeChar(PS.ECH_NOTIFY1); this.f4 = new FakeChar(PS.ECH_DATA);
    const chars = { [PS.ECH_WRITE]: this.f2, [PS.ECH_NOTIFY1]: this.f3, [PS.ECH_DATA]: this.f4 };
    this.service = { getCharacteristic: async u => { if (!chars[u]) { const e = new Error('no char'); e.name = 'NotFoundError'; throw e; } return chars[u]; } };
  }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  removeEventListener(t, fn) { if (this._l[t]) this._l[t] = this._l[t].filter(f => f !== fn); }
  _fire(t) { (this._l[t] || []).slice().forEach(fn => fn({ target: this })); }
}
// Node 22 ships a built-in `navigator` accessor: replacing it is silently ignored, so mutate it
navigator.bluetooth = { requestDevice: async () => { rdCalls++; return device; } };

for (const f of ['state.js', 'pwa.js', 'ble.js', 'bike-dashboard.js', 'rower-dashboard.js', 'treadmill-dashboard.js', 'export.js', 'coach.js', 'app.js']) {
  eval(fs.readFileSync(path.join(J, f), 'utf8'));
}
const device = new FakeDevice('ECHEX-5-105626');
const s = PS.state;
PS.RECONNECT_DELAYS = [50, 50, 50, 50, 50];   // keep the test fast; the logic is delay-agnostic
const withCksum = b => { let t = 0; for (let i = 0; i < b.length - 1; i++) t += b[i]; b[b.length - 1] = t & 0xFF; return b; };
const D1 = (revs, cad) => withCksum([0xF0, 0xD1, 0x09, 0, 0, 0, 0, (revs >> 8) & 0xFF, revs & 0xFF, (cad >> 8) & 0xFF, cad & 0xFF, 0x00, 0]);
const evs = prefix => pulse.filter(e => e.startsWith(prefix));
const banner = () => document.querySelectorAll('.reconnect-banner')[0];
const buttons = () => banner().children.flatMap(c => c.children.length ? c.children.map(b => b.textContent) : [c.textContent]);   // buttons sit in a .banner-actions group
const status = () => els['connect-status'].textContent;
const cardShowing = () => PS.lastRideShowing();

async function connect() {
  connectMode = 'ok';
  setTimeout(() => device.f4.emit(D1(200, 80)), 30);   // resolves the unlock window (not locked)
  await connect_();
}
const connect_ = () => connectBike();
function rode(seconds) {
  s.rideElapsed = seconds; s.rideStart = Date.now() / 1000 - seconds;
  s.recordedPoints = [1, 2, 3].map(i => ({ time: new Date().toISOString(), elapsed: i * 5, equipmentType: 'bike', cadence: 70, power: 100, resistance: 10, distance: i * 10, calories: i }));
  s.powerSamples = [100, 120]; s.totalDistance = 5.2;
}

(async () => {
  // ---- A. equipment went to sleep: idle 40s at the drop, attempt 1 fails fast → done:asleep, no retries ----
  await connect();
  check('A. connected, last-workout card hidden on a new connection', device.gatt.connected && !cardShowing());
  rode(300);
  s.lastNonZeroCadenceTime = Date.now() / 1000 - 40;
  connectMode = 'failfast';
  pulse.length = 0;
  device.gatt.disconnect();
  await sleep(400);
  check('A. one disconnect event only: done:bike:EX-5:asleep (drop was held, never emitted)', JSON.stringify(evs('disconnect:')) === JSON.stringify(['disconnect:done:bike:EX-5:asleep']), evs('disconnect:'));
  check('A. no reconnect_failed, no attempts 2–5', evs('reconnect_failed').length === 0 && !banner()._t.includes('2 of 5'));
  check('A. exactly one ride_complete', evs('ride_complete').length === 1, evs('ride_complete'));
  check('A. connect screen with "Workout ended — equipment disconnected"', els['connect-screen'].style.display === 'flex' && status().startsWith('Workout ended — equipment disconnected'), status());
  check('A. last-workout card shown with the numbers', cardShowing() && /05:00/.test(els['last-ride-stats']._t) && /5\.2 km/.test(els['last-ride-stats']._t) && /avg 110 W/.test(els['last-ride-stats']._t) && /EX-5/.test(els['last-ride-name']._t), { stats: els['last-ride-stats']._t, name: els['last-ride-name']._t });

  // ---- B. END WORKOUT during attempt 1 (held drop; hung connect must not resurrect the session) ----
  await connect();
  check('B. card hidden again after reconnecting', !cardShowing());
  rode(300);
  s.lastNonZeroCadenceTime = Date.now() / 1000 - 40;
  connectMode = 'hang';
  pulse.length = 0;
  device.gatt.disconnect();
  await sleep(120);
  check('B. retry banner copy + END WORKOUT button (no RECONNECT yet)', banner()._t === 'EX-5 not responding — retrying (1 of 5)' && buttons().includes('END WORKOUT') && !buttons().includes('RECONNECT'), { text: banner()._t, buttons: buttons() });
  check('B. drop event held while attempt 1 is pending', evs('disconnect:').length === 0, evs('disconnect:'));
  endWorkoutFromBanner(false);
  await sleep(30);
  check('B. END WORKOUT → disconnect ended:bike:EX-5:attempt1, one ride_complete, connect screen', JSON.stringify(evs('disconnect:')) === JSON.stringify(['disconnect:ended:bike:EX-5:attempt1']) && evs('ride_complete').length === 1 && status() === 'Workout ended. Tap CONNECT to start another.', { d: evs('disconnect:'), rc: evs('ride_complete'), status: status() });
  check('B. card shown after END WORKOUT', cardShowing());
  pendingResolve();   // the hung connect finally succeeds — too late
  await sleep(60);
  check('B. late connect success is dropped quietly: no reconnect_ok, no extra disconnect event, gatt not connected', evs('reconnect_ok').length === 0 && evs('disconnect:').length === 1 && !device.gatt.connected, { d: evs('disconnect:'), ok: evs('reconnect_ok') });

  // ---- C. real drop while riding: 5 fast failures → hard fail → inactivity auto-end (tap resets it) ----
  await connect();
  rode(300);
  s.lastNonZeroCadenceTime = Date.now() / 1000;   // actively riding
  connectMode = 'failfast';
  PS.HARDFAIL_AUTO_END_MS = 400;
  pulse.length = 0;
  device.gatt.disconnect();
  let waited = 0; while (evs('reconnect_failed').length === 0 && waited < 3000) { await sleep(25); waited += 25; }
  const tHard = Date.now();
  check('C. drop emitted immediately (idle 0) and exactly once', JSON.stringify(evs('disconnect:')) === JSON.stringify(['disconnect:drop:bike:EX-5']), evs('disconnect:'));
  check('C. attempts capped at 5 inside the window → reconnect_failed:attempts:5', /^reconnect_failed:attempts:5:/.test(evs('reconnect_failed')[0] || ''), evs('reconnect_failed'));
  check('C. hard-fail banner: "Workout saved — EX-5 disconnected." with RECONNECT + END WORKOUT, dashboard still up', banner()._t.startsWith('Workout saved — EX-5 disconnected') && buttons().includes('RECONNECT') && buttons().includes('END WORKOUT') && els['dashboard'].style.display === 'flex', { text: banner()._t, buttons: buttons() });
  check('C. ride_complete emitted once at hard fail', evs('ride_complete').length === 1);
  await sleep(250);
  document.dispatch('pointerdown');   // user taps something → countdown restarts
  await sleep(250);                   // 500ms after hard fail: without the tap it would already have ended
  check('C. a tap resets the inactivity countdown (not ended yet at +500ms)', evs('disconnect:ended').length === 0, evs('disconnect:'));
  await sleep(300);                   // tap +550ms > 400ms timer
  check('C. untouched banner ends the workout: disconnect ended:bike:EX-5:auto, still ONE ride_complete, card shown', evs('disconnect:ended')[0] === 'disconnect:ended:bike:EX-5:auto' && evs('ride_complete').length === 1 && cardShowing() && els['connect-screen'].style.display === 'flex', { d: evs('disconnect:'), rc: evs('ride_complete') });

  // ---- D. normal DISCONNECT after a workout → card + export works from the connect screen ----
  await connect();
  rode(300);
  pulse.length = 0;
  disconnectBike();
  await sleep(30);
  check('D. DISCONNECT tap → disconnect user:bike:EX-5, card shown', evs('disconnect:')[0] === 'disconnect:user:bike:EX-5' && cardShowing(), evs('disconnect:'));
  exportWorkout();
  await sleep(30);
  check('D. EXPORT from the card produces the file (export:bike) with no dashboard visible', pulse.includes('export:bike') && els['dashboard'].style.display === 'none', pulse.filter(e => e.startsWith('export')));

  // ---- E. a service-worker update deferred mid-ride is held while the card shows, applied on the next CONNECT tap ----
  await connect();
  rode(300);
  let applied = 0;
  window.PSApplyPendingUpdate = () => { applied++; s.updatePending = false; return true; };
  window.PSCheckForUpdate = () => Promise.resolve();
  s.updatePending = true;
  disconnectBike();
  await sleep(30);
  check('E. cleanup with a pending update: card shown, reload NOT applied (samples would be lost)', cardShowing() && applied === 0 && s.updatePending === true);
  const rd0 = rdCalls;
  await connectBike();
  check('E. next CONNECT tap applies the update before the picker (no requestDevice call)', applied === 1 && rdCalls === rd0 && PS.connectInFlight() === false, { applied, rdCalls: rdCalls - rd0 });

  console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH', e); process.exit(2); });
