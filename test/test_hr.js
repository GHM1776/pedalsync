// Heart rate — run from the repo root:  node test/test_hr.js
//
// The strap is an optional accessory on a second GATT connection, and the two
// things that would make it worse than not having it are:
//   1. a stale or frozen reading reaching the export, so the file carries a
//      flatline the dashboard never showed; and
//   2. anything about the strap disturbing the equipment link, including being
//      torn down by a control that was never meant to end the session.
// Both are what most of this file is about. The rest pins 0x2A37 parsing, which
// is variable-length and easy to read wrongly.
const fs = require('fs');
const path = require('path');
const J = path.join(__dirname, '..', 'js');
let fail = 0;
const check = (n, c, d) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) { fail++; if (d !== undefined) console.log('   ' + JSON.stringify(d)); } };
const sleep = ms => new Promise(r => realSetTimeout(r, ms));

// ---- mocked clock ----
const realNow = Date.now;
const realSetTimeout = global.setTimeout;
let skew = 0;
Date.now = () => realNow() + skew;
const advance = sec => { skew += sec * 1000; };

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
  if (id === 'last-ride' || id === 'connect-trouble' || id === 'no-cadence-hint') cls.add('hidden');
  return el;
}
const els = {};
global.document = {
  getElementById: id => els[id] || (els[id] = mkEl(id)),
  querySelector: q => els[q] || (els[q] = mkEl(q)),
  querySelectorAll: q => [els[q] || (els[q] = mkEl(q))],
  createElement: () => mkEl('a'),
  addEventListener() {},
  body: { appendChild() {}, removeChild() {} },
  visibilityState: 'visible',
};
global.addEventListener = () => {};
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.__pulse = (e, v) => pulse.push(e + (v ? ':' + v : ''));
global.alert = () => {};
let lastFetchBody = null;
global.fetch = async (url, opts) => {
  if (opts && opts.body) { try { lastFetchBody = JSON.parse(opts.body); } catch (e) { lastFetchBody = null; } }
  return { ok: true, status: 200, json: async () => ({ coaching: 'ok' }) };
};
global.navigator.sendBeacon = () => true;
// Capture the exported file instead of downloading it
let exported = null;
global.Blob = function(parts) { exported = parts.join(''); this.parts = parts; };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };

// ---- fake heart-rate peripheral ----
class FakeHrChar {
  constructor() { this.listeners = []; this.notifying = false; }
  async startNotifications() { this.notifying = true; return this; }
  addEventListener(t, fn) { if (t === 'characteristicvaluechanged') this.listeners.push(fn); }
  removeEventListener(t, fn) { this.listeners = this.listeners.filter(f => f !== fn); }
  emit(bytes) {
    const b = Uint8Array.from(bytes);
    this.value = new DataView(b.buffer);
    this.listeners.slice().forEach(fn => fn({ target: this }));
  }
}
class FakeHrDevice {
  constructor(name, id) {
    this.name = name; this.id = id; this._l = {}; this.char = new FakeHrChar();
    const self = this;
    this.gatt = {
      connected: false,
      connect: async () => {
        self.gatt.connected = true;
        return { getPrimaryService: async () => ({ getCharacteristic: async () => self.char }) };
      },
      disconnect: () => { if (!self.gatt.connected) return; self.gatt.connected = false; self._fire('gattserverdisconnected'); },
    };
  }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  removeEventListener(t, fn) { if (this._l[t]) this._l[t] = this._l[t].filter(f => f !== fn); }
  _fire(t) { (this._l[t] || []).slice().forEach(fn => fn({ target: this })); }
}

// ---- fake Echelon equipment (same shape as test_reconnect.js) ----
let hrToOffer = null;
let equipDevice = null;
navigator.bluetooth = {
  requestDevice: async (opts) => {
    const wantsHr = JSON.stringify(opts || {}).indexOf('heart_rate') !== -1;
    if (wantsHr) { if (!hrToOffer) { const e = new Error('cancelled'); e.name = 'NotFoundError'; throw e; } return hrToOffer; }
    return equipDevice;
  },
};

for (const f of ['state.js', 'diag-capture.js', 'pwa.js', 'ble.js', 'hr.js', 'bike-dashboard.js', 'rower-dashboard.js', 'treadmill-dashboard.js', 'export.js', 'coach.js', 'app.js']) {
  eval(fs.readFileSync(path.join(J, f), 'utf8'));
}
const s = PS.state;

class FakeChar {
  constructor(uuid) { this.uuid = uuid; this.listeners = []; }
  async startNotifications() { return this; }
  addEventListener(t, fn) { if (t === 'characteristicvaluechanged') this.listeners.push(fn); }
  removeEventListener(t, fn) { this.listeners = this.listeners.filter(f => f !== fn); }
  async writeValue() {}
  emit(bytes) { const b = Uint8Array.from(bytes); this.value = new DataView(b.buffer); this.listeners.slice().forEach(fn => fn({ target: this })); }
}
class FakeEquip {
  constructor(name) {
    this.id = 'equip-1'; this.name = name; this._l = {};
    const self = this;
    this.gatt = {
      connected: false,
      connect: () => { self.gatt.connected = true; return Promise.resolve(self.gatt); },
      disconnect: () => { if (!self.gatt.connected) return; self.gatt.connected = false; self._fire('gattserverdisconnected'); },
      getPrimaryService: async () => self.service,
    };
    this.f2 = new FakeChar(PS.ECH_WRITE); this.f3 = new FakeChar(PS.ECH_NOTIFY1); this.f4 = new FakeChar(PS.ECH_DATA);
    const chars = { [PS.ECH_WRITE]: this.f2, [PS.ECH_NOTIFY1]: this.f3, [PS.ECH_DATA]: this.f4 };
    this.service = { getCharacteristic: async u => chars[u] };
  }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  removeEventListener(t, fn) { if (this._l[t]) this._l[t] = this._l[t].filter(f => f !== fn); }
  _fire(t) { (this._l[t] || []).slice().forEach(fn => fn({ target: this })); }
}
equipDevice = new FakeEquip('ECHEX-5-105626');

const cks = b => { let t = 0; for (let i = 0; i < b.length - 1; i++) t += b[i]; b[b.length - 1] = t & 0xFF; return b; };
const bikeD1 = (revs, cad) => cks([0xF0, 0xD1, 0x09, 0, 0, 0, 0, (revs >> 8) & 0xFF, revs & 0xFF, (cad >> 8) & 0xFF, cad & 0xFF, 0x00, 0]);
const dv = bytes => new DataView(Uint8Array.from(bytes).buffer);
// 0x2A37 payloads
const hr8 = bpm => [0x00, bpm];                                       // uint8, no contact bits
const hr16 = bpm => [0x01, bpm & 0xFF, (bpm >> 8) & 0xFF];            // uint16 LE
const hrContact = bpm => [0x06, bpm];                                 // contact supported + detected
const hrNoContact = bpm => [0x04, bpm];                               // supported, NOT detected
const hrEnergy = bpm => [0x08, bpm, 0x10, 0x00];                      // energy expended present
const hrRR = bpm => [0x10, bpm, 0x00, 0x04, 0x10, 0x04];              // RR intervals present

async function connectHr(device) {
  hrToOffer = device;
  await PS.hr.connect();
}

(async () => {
  // ================= parsing =================
  check('uint8 format read from byte 1', PS.hrParse(dv(hr8(72))).bpm === 72);
  check('uint16 format read little-endian', PS.hrParse(dv(hr16(300))).bpm === 300, PS.hrParse(dv(hr16(300))));
  check('contact supported AND detected is not stale', PS.hrParse(dv(hrContact(80))).stale === false);
  check('contact supported but NOT detected is stale', PS.hrParse(dv(hrNoContact(80))).stale === true);
  check('contact bits absent are not treated as lost contact', PS.hrParse(dv(hr8(80))).stale === false);
  check('energy-expended payload (4 bytes) still parses byte 1', PS.hrParse(dv(hrEnergy(65))).bpm === 65);
  check('RR-interval payload (6 bytes) still parses byte 1', PS.hrParse(dv(hrRR(99))).bpm === 99);
  check('a 1-byte payload is rejected, not read past the end', PS.hrParse(dv([0x00])) === null);
  check('a uint16 flag with only 2 bytes is rejected', PS.hrParse(dv([0x01, 0x50])) === null);

  // ================= connect + readings =================
  const strapA = new FakeHrDevice('Polar H10 ABC', 'hr-A');
  await connectHr(strapA);
  check('strap connects and reports its name', PS.hr.isConnected() && s.hrDeviceName === 'Polar H10 ABC', s.hrDeviceName);
  check('device id remembered for a later silent re-attach', localStorage.getItem('ps_hr_device') === 'hr-A');
  check('no reading yet, so current() is 0', PS.hr.current() === 0);

  strapA.char.emit(hrContact(142));
  check('a valid reading lands in state and in current()', s.heartRate === 142 && PS.hr.current() === 142);
  check('...and is sampled with a timestamp', s.hrSamples.length === 1 && s.hrSamples[0].bpm === 142 && typeof s.hrSamples[0].ts === 'number', s.hrSamples[0]);

  strapA.char.emit(hr8(20)); strapA.char.emit(hr8(250));
  check('out-of-range values discarded silently', s.heartRate === 142 && s.hrSamples.length === 1, { hr: s.heartRate, n: s.hrSamples.length });

  // ================= the two ways a reading goes bad =================
  strapA.char.emit(hrNoContact(142));
  check('contact lost → current() is 0 even though the strap keeps sending 142',
    s.hrStale === true && PS.hr.current() === 0 && s.heartRate === 142, { stale: s.hrStale, hr: s.heartRate });
  check('...and the stale value is not sampled', s.hrSamples.length === 1);
  strapA.char.emit(hrContact(138));
  check('contact restored → readings resume', PS.hr.current() === 138 && s.hrStale === false);

  advance(PS.HR_STALE_AFTER_S + 1);
  check('strap stops notifying (dead battery) → current() is 0 within the timeout', PS.hr.current() === 0);
  PS.hr.render();
  check('...and render zeroes the held value so nothing can read it', s.heartRate === 0);
  strapA.char.emit(hrContact(140));
  check('a fresh reading recovers from the timeout', PS.hr.current() === 140);

  // ================= export =================
  s.equipmentType = 'bike';
  s.rideActive = true;
  s.rideStartDate = new Date('2026-09-15T12:00:00Z');
  s.rideElapsed = 300;
  s.totalDistance = 8.4;
  s.totalCalories = 210;
  s.cadence = 84; s.power = 155; s.resistance = 12;
  s.recordedPoints = [];
  s.lastRecordTime = 0;
  s.hrSamples = [];
  // three points with heart rate, recorded through the real path
  for (const bpm of [120, 150, 171]) {
    strapA.char.emit(hrContact(bpm));
    s.lastRecordTime = 0;
    recordDataPoint();
  }
  check('recorded points carry heart rate', s.recordedPoints.length === 3 && s.recordedPoints.every(p => p.heartRate > 0),
    s.recordedPoints.map(p => p.heartRate));

  exported = null;
  exportWorkout();
  const xml = exported || '';
  check('root element declares xmlns:xsi', /<TrainingCenterDatabase[^>]*xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/.test(xml));
  check('all three trackpoints carry HeartRateBpm', (xml.match(/<HeartRateBpm/g) || []).length === 3, (xml.match(/<HeartRateBpm/g) || []).length);
  // Trackpoint_t: Time, ..., DistanceMeters, HeartRateBpm, Cadence, Extensions
  const tp = xml.substring(xml.indexOf('<Trackpoint>'), xml.indexOf('</Trackpoint>'));
  const order = ['<Time>', '<DistanceMeters>', '<HeartRateBpm', '<Cadence>', '<Extensions>'].map(t => tp.indexOf(t));
  check('trackpoint element order is Time, Distance, HeartRate, Cadence, Extensions',
    order.every((v, i) => v !== -1 && (i === 0 || v > order[i - 1])), order);
  // ActivityLap_t: ...Calories, AverageHeartRateBpm, MaximumHeartRateBpm, Intensity...
  const lap = xml.substring(xml.indexOf('<Lap '), xml.indexOf('<Track>'));
  const lapOrder = ['<Calories>', '<AverageHeartRateBpm', '<MaximumHeartRateBpm', '<Intensity>'].map(t => lap.indexOf(t));
  check('lap averages sit after Calories and before Intensity',
    lapOrder.every((v, i) => v !== -1 && (i === 0 || v > lapOrder[i - 1])), lapOrder);
  check('lap maximum is the highest sampled beat (171)', /<MaximumHeartRateBpm[^>]*><Value>171<\/Value>/.test(lap), lap.match(/<MaximumHeartRateBpm.*/));
  check('lap average is the mean of the samples (147)', /<AverageHeartRateBpm[^>]*><Value>147<\/Value>/.test(lap), lap.match(/<AverageHeartRateBpm.*/));
  check('every heart-rate value is a whole number', !/<Value>\d+\.\d+<\/Value>/.test(xml));

  // ---- a ride with no strap must produce the v21 file, apart from the namespace ----
  PS.hr.disconnect();
  s.hrSamples = []; s.heartRate = 0; s.lastHrTime = 0;
  s.recordedPoints = [];
  s.lastRecordTime = 0;
  for (let i = 0; i < 3; i++) { s.lastRecordTime = 0; recordDataPoint(); }
  check('with no strap, no point carries heart rate', s.recordedPoints.every(p => p.heartRate === undefined));
  exported = null;
  advance(4);                 // clear the 3s export debounce
  exportWorkout();
  const v22NoHr = exported || '';
  check('no-strap file has no heart-rate elements at all', !/HeartRate/.test(v22NoHr));
  // run the v21 builder over the very same recorded points
  const v21Src = require('child_process').execSync('git show 5a6531f:js/export.js', {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  exported = null;
  eval(v21Src);               // replaces window.exportWorkout / recordDataPoint with v21's
  exportWorkout();
  const v21Out = exported || '';
  const strip = x => x.replace(' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"', '');
  check('no-strap output is byte-identical to v21 once the root xmlns:xsi is normalised out',
    strip(v22NoHr) === v21Out && v22NoHr !== '', {
      v22: strip(v22NoHr).length, v21: v21Out.length,
      firstDiff: (() => { const a = strip(v22NoHr), b = v21Out; for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i + ': ' + JSON.stringify(a.substr(i, 60)) + ' vs ' + JSON.stringify(b.substr(i, 60)); return 'none'; })(),
    });
  // restore v22's builders for the rest of the run
  eval(fs.readFileSync(path.join(J, 'export.js'), 'utf8'));

  // ================= coach payload =================
  await connectHr(strapA);
  s.hrSamples = [];
  // a 2-second notifier over three minutes: slice(-60) would be a two-minute
  // window, so only a timestamp filter gives the intended sixty seconds
  const nowS = Date.now() / 1000;
  for (let t = 180; t > 0; t -= 2) s.hrSamples.push({ bpm: t > 60 ? 100 : 160, ts: nowS - t });
  s.heartRate = 160; s.hrStale = false; s.lastHrTime = nowS;
  s.equipmentType = 'bike';
  s.workoutPlan = [{ name: 'steady state', duration_sec: 600, target_resistance_min: 8, target_resistance_max: 14, target_cadence_min: 70, target_cadence_max: 95, coaching_text: 'go' }];
  s.currentSegIdx = 0; s.workoutActive = true; s.planPending = false;
  s.workoutStartTime = nowS - 120; s.segStartTime = nowS; s.lastAdaptiveCall = 0;
  s.powerSamples = [150]; s.cadenceSamples = [85];
  lastFetchBody = null;
  checkCoachProgress();
  await sleep(30);
  check('adaptive request carries actual_hr', !!lastFetchBody && lastFetchBody.actual_hr === 160, lastFetchBody && lastFetchBody.actual_hr);
  check('avg_hr covers the last 60 seconds only, not the last 60 samples',
    !!lastFetchBody && lastFetchBody.avg_hr === 160, lastFetchBody && lastFetchBody.avg_hr);

  // stale strap must not send a frozen number to the coach
  s.hrStale = true;
  s.lastAdaptiveCall = 0; lastFetchBody = null;
  checkCoachProgress();
  await sleep(30);
  check('a stale strap sends actual_hr null, not the frozen value', !!lastFetchBody && lastFetchBody.actual_hr === null, lastFetchBody && lastFetchBody.actual_hr);
  s.hrStale = false;

  // no strap at all → both null
  PS.hr.disconnect();
  s.hrSamples = []; s.heartRate = 0; s.lastHrTime = 0;
  s.lastAdaptiveCall = 0; lastFetchBody = null;
  checkCoachProgress();
  await sleep(30);
  check('with no strap both HR fields are null', !!lastFetchBody && lastFetchBody.actual_hr === null && lastFetchBody.avg_hr === null,
    lastFetchBody && { a: lastFetchBody.actual_hr, b: lastFetchBody.avg_hr });
  s.workoutActive = false;

  // ================= retry cancellation by generation =================
  const strapB = new FakeHrDevice('Wahoo Tickr XYZ', 'hr-B');
  await connectHr(strapA);
  check('reconnected strap A', PS.hr.isConnected());
  // capture the retry timers instead of waiting 5 and 15 seconds
  const scheduled = [];
  global.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
  global.clearTimeout = () => {};
  strapA.gatt.disconnect();
  check('an unexpected drop zeroes the reading and beacons it',
    PS.hr.current() === 0 && pulse.filter(e => e === 'hr:dropped').length === 1, pulse.slice(-3));
  check('two retries scheduled at 5s and 15s, no ladder',
    scheduled.length === 2 && scheduled[0].ms === 5000 && scheduled[1].ms === 15000, scheduled.map(x => x.ms));

  PS.hr.disconnect();                       // the rider taps it off during the retry window
  scheduled.forEach(x => x.fn());
  await sleep(20);
  check('a retry scheduled before the rider disconnected does not fire', !PS.hr.isConnected());

  // switching straps must not resurrect the old one
  scheduled.length = 0;
  global.setTimeout = realSetTimeout;
  await connectHr(strapA);
  global.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
  strapA.gatt.disconnect();
  global.setTimeout = realSetTimeout;
  await connectHr(strapB);                  // rider pairs a different strap
  check('second strap connected', PS.hr.isConnected() && s.hrDeviceName === 'Wahoo Tickr XYZ', s.hrDeviceName);
  scheduled.forEach(x => x.fn());
  await sleep(20);
  check('the first strap\'s pending retry does not steal the connection back',
    s.hrDeviceName === 'Wahoo Tickr XYZ' && strapA.gatt.connected === false, { name: s.hrDeviceName, aConnected: strapA.gatt.connected });

  // ================= which controls may tear the strap down =================
  // stopWorkout ends a coached session and leaves the rider on the bike
  s.workoutActive = true; s.workoutStartTime = Date.now() / 1000 - 600;
  s.powerSamples = [100];
  stopWorkout();
  check('ending a coached workout leaves the strap connected', PS.hr.isConnected());

  // an equipment drop the app classifies as "done" keeps the strap for next time
  await connectBike();
  equipDevice.f4.emit(bikeD1(10, 80));
  check('equipment connected with the strap still attached', equipDevice.gatt.connected && PS.hr.isConnected());
  s.lastNonZeroCadenceTime = Date.now() / 1000 - 70;   // idle long enough to read as finished
  s.rideElapsed = 300;
  equipDevice.gatt.disconnect();
  await sleep(40);
  check('equipment finished/asleep → strap stays connected, no re-pair next ride', PS.hr.isConnected());

  // explicit teardown does take it down
  await connectBike();
  equipDevice.f4.emit(bikeD1(20, 80));
  check('reconnected for the explicit-disconnect case', equipDevice.gatt.connected && PS.hr.isConnected());
  disconnectBike();
  await sleep(40);
  check('explicit DISCONNECT tears the strap down too', !PS.hr.isConnected());

  // and so does the banner's END WORKOUT
  await connectHr(strapB);
  await connectBike();
  equipDevice.f4.emit(bikeD1(30, 80));
  endWorkoutFromBanner(false);
  await sleep(40);
  check('the reconnect banner\'s END WORKOUT tears the strap down', !PS.hr.isConnected());

  // ================= resetRide clears readings, keeps the device =================
  await connectHr(strapB);
  strapB.char.emit(hrContact(133));
  check('reading present before reset', s.hrSamples.length === 1 && s.heartRate === 133);
  resetRide();
  check('resetRide clears the HR readings', s.hrSamples.length === 0 && s.heartRate === 0 && s.hrStale === false && s.lastHrTime === 0,
    { n: s.hrSamples.length, hr: s.heartRate });
  check('...but the strap stays connected and still names the tile', PS.hr.isConnected() && s.hrDeviceName === 'Wahoo Tickr XYZ', s.hrDeviceName);

  console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
