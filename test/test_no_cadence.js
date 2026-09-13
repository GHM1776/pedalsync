// Fix 9 — no-cadence hint for a revolution counter that never moves OR freezes mid-ride.
// Runs the real state/ble/bike-dashboard/diag-capture modules in Node against a
// fake Web Bluetooth device and a mocked clock. Run from the repo root:
//   node test/test_no_cadence.js
//
// Scenarios:
//   A. counter froze mid-ride, knob turned after the freeze → hint + no_cadence mid:<model>:<revs>:<n>s,
//      diag verdict bike:no_cadence mode=mid with revs_final / revs_static_s in the head; × dismiss holds
//   B. counter moves again → hint hidden, re-armed; a second freeze fires again
//   C. rest with nothing touched (last knob turn was BEFORE this freeze) → no hint, diag stays ok
//   D. workout running is enough on its own (no knob)
//   E. new connection whose counter never leaves 0 → no_cadence never:<model>:<n>s, diag mode=never
const fs = require('fs');
const path = require('path');
const J = path.join(__dirname, '..', 'js');
let fail = 0;
const check = (n, c, d) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) { fail++; if (d !== undefined) console.log('   ' + JSON.stringify(d)); } };

// ---- mocked clock: everything in the app reads Date.now() ----
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const advance = sec => { skew += sec * 1000; };

// ---- browser stubs (same shape as test_reconnect.js) ----
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
global.document = {
  getElementById: id => els[id] || (els[id] = mkEl(id)),
  querySelector: q => els[q] || (els[q] = mkEl(q)),
  querySelectorAll: q => [els[q] || (els[q] = mkEl(q))],
  createElement: () => mkEl('el'),
  addEventListener() {},
  body: { appendChild() {}, removeChild() {} },
  visibilityState: 'visible',
};
global.addEventListener = () => {};
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.__pulse = (e, v) => pulse.push(e + (v ? ':' + v : ''));
global.alert = () => {};
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
global.navigator.sendBeacon = () => true;

// ---- fake Web Bluetooth ----
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
  connect() { this.connected = true; return Promise.resolve(this); }
  disconnect() { if (!this.connected) return; this.connected = false; this.device._fire('gattserverdisconnected'); }
  async getPrimaryService() { return this.device.service; }
}
class FakeDevice {
  constructor(name) {
    this.id = 'dev-1'; this.name = name; this.gatt = new FakeGatt(this); this._l = {};
    this.f2 = new FakeChar(PS.ECH_WRITE); this.f3 = new FakeChar(PS.ECH_NOTIFY1); this.f4 = new FakeChar(PS.ECH_DATA);
    const chars = { [PS.ECH_WRITE]: this.f2, [PS.ECH_NOTIFY1]: this.f3, [PS.ECH_DATA]: this.f4 };
    this.service = { getCharacteristic: async u => chars[u] };
  }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  removeEventListener(t, fn) { if (this._l[t]) this._l[t] = this._l[t].filter(f => f !== fn); }
  _fire(t) { (this._l[t] || []).slice().forEach(fn => fn({ target: this })); }
}
// Node 22 ships a built-in `navigator` accessor: replacing it is silently ignored, so mutate it
navigator.bluetooth = { requestDevice: async () => device };

for (const f of ['state.js', 'diag-capture.js', 'pwa.js', 'ble.js', 'bike-dashboard.js', 'rower-dashboard.js', 'treadmill-dashboard.js', 'export.js', 'coach.js', 'app.js']) {
  eval(fs.readFileSync(path.join(J, f), 'utf8'));
}
const device = new FakeDevice('ECHEX-5-105626');
const s = PS.state;
const withCksum = b => { let t = 0; for (let i = 0; i < b.length - 1; i++) t += b[i]; b[b.length - 1] = t & 0xFF; return b; };
const D1 = (revs, cad) => withCksum([0xF0, 0xD1, 0x09, 0, 0, 0, 0, (revs >> 8) & 0xFF, revs & 0xFF, (cad >> 8) & 0xFF, cad & 0xFF, 0x00, 0]);
const D2 = r => withCksum([0xF0, 0xD2, 0x01, r, 0]);
const hint = () => els['no-cadence-hint'];
const hintShown = () => !hint().classList.contains('hidden');
const events = () => pulse.filter(e => e.startsWith('no_cadence'));
const verdict = () => PSDiag.snapshot(false).verdict;
// One simulated second: one D1 (the bike's ~1 Hz stream), clock forward, display tick
function tick(revs, cad, seconds) {
  for (let i = 0; i < seconds; i++) { advance(1); device.f4.emit(D1(revs, cad)); updateBikeDisplay(); }
}
async function connect(firstRevs, firstCad) {
  setTimeout(() => device.f4.emit(D1(firstRevs, firstCad)), 30);   // first D1 resolves the unlock window (not locked)
  await connectBike();
}

(async () => {
  // ---- A. froze mid-ride, knob turned after the freeze ----
  await connect(1, 75);
  check('A. connected, hint hidden', device.gatt.connected && !hintShown());
  device.f4.emit(D2(10));                       // baseline resistance (first D2 is never a "change")
  for (let r = 2; r <= 40; r++) tick(r, 75, 1); // 40 s of honest counting
  check('A. counting: hint hidden, no event', !hintShown() && events().length === 0);
  tick(138, 0, 1);                              // counter lands on 138 and dies — this packet starts the static clock
  tick(138, 0, 20);
  check('A. 20 s frozen, nothing touched: hint hidden', !hintShown() && events().length === 0);
  device.f4.emit(D2(14));                       // knob turned AFTER the freeze
  tick(138, 0, 40);                             // 60 s static in total (fires on the tick that reaches 60)
  check('A. 60 s frozen + knob turned → hint shown once, no_cadence mid:EX-5:138:60s',
    hintShown() && events().length === 1 && events()[0] === 'no_cadence:mid:EX-5:138:60s', events());
  const snapA = PSDiag.snapshot(false);
  check('A. diag verdict bike:no_cadence mode=mid, revs 138',
    snapA.verdict.side === 'bike' && snapA.verdict.code === 'no_cadence' && snapA.verdict.mode === 'mid' && snapA.verdict.revs === 138 && snapA.verdict.d2_changes === 1, snapA.verdict);
  check('A. head carries revs_final=138, revs_static_s>=60, d2_changes=1',
    snapA.revs_final === 138 && snapA.revs_static_s >= 60 && snapA.d2_changes === 1, { revs_final: snapA.revs_final, revs_static_s: snapA.revs_static_s, d2_changes: snapA.d2_changes });
  hideNoCadenceHint();                          // rider taps ×
  tick(138, 0, 30);
  check('A. dismissed hint stays hidden for the same freeze, still one event', !hintShown() && events().length === 1, events());

  // ---- B. counter moves again → hidden + re-armed; second freeze fires again ----
  tick(139, 70, 1);
  check('B. counter moved: hint hidden, re-armed', !hintShown() && s.noCadenceFired === false);
  for (let r = 140; r <= 150; r++) tick(r, 70, 1);
  tick(150, 0, 5);
  device.f4.emit(D2(18));
  tick(150, 0, 56);
  check('B. second freeze + knob → fires again with the new counter value (mid:EX-5:150:60s)',
    hintShown() && events().length === 2 && events()[1] === 'no_cadence:mid:EX-5:150:60s', events());

  // ---- C. a rest with nothing touched: the last knob turn was before THIS freeze ----
  for (let r = 151; r <= 160; r++) tick(r, 70, 1);   // pedals again (hint clears)
  check('C. pedalling again clears the hint', !hintShown());
  s.workoutActive = false;
  tick(160, 0, 120);                             // two minutes of rest, no knob
  check('C. 120 s rest, nothing touched → no hint, no new event', !hintShown() && events().length === 2, events());
  check('C. diag verdict is ok (knob change predates this freeze)', verdict().side === 'ok', verdict());

  // ---- D. a running workout is enough on its own ----
  s.workoutActive = true;
  for (let r = 161; r <= 165; r++) tick(r, 70, 1);
  tick(165, 0, 60);
  check('D. workout active + 60 s frozen, no knob → hint + mid:EX-5:165:60s',
    hintShown() && events().length === 3 && events()[2] === 'no_cadence:mid:EX-5:165:60s', events());
  s.workoutActive = false;

  // ---- E. fresh connection, counter never leaves 0 ----
  disconnectBike();
  await new Promise(r => setTimeout(r, 50));
  pulse.length = 0;
  await connect(0, 0);
  check('E. reconnected, hint hidden, per-connection state reset', device.gatt.connected && !hintShown() && s.lastRevCount === 0 && s.noCadenceFired === false && s.lastD2ChangeTime === 0);
  device.f4.emit(D2(10));
  tick(0, 0, 30);
  device.f4.emit(D2(12));                        // knob turned, still nothing counted
  tick(0, 0, 31);
  check('E. never counted + knob → hint + no_cadence never:EX-5:60s',
    hintShown() && events().length === 1 && events()[0] === 'no_cadence:never:EX-5:60s', events());
  const snapE = PSDiag.snapshot(false);
  check('E. diag verdict bike:no_cadence mode=never over >=30 D1',
    snapE.verdict.code === 'no_cadence' && snapE.verdict.mode === 'never' && snapE.verdict.d1 >= 30 && snapE.revs_final === 0, snapE.verdict);

  console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
