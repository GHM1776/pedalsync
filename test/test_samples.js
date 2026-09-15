// Effort-sample bookkeeping — run from the repo root:  node test/test_samples.js
//
// Three bugs this pins, all of which reported plausible-looking wrong numbers
// rather than failing loudly:
//   1. Rower watts arrive in the D3 packet, not the D1 that feeds powerSamples,
//      so every rower workout reported "avg 0W" and sent avg_power 0 to the
//      adaptive coach.
//   2. resetRide() cleared the rower and treadmill arrays but not powerSamples
//      or cadenceSamples, so a second ride on one page load inherited the
//      first ride's effort.
//   3. A treadmill has no power at all; reporting 0W was misleading.
// Plus: the connect-screen help panel used to open 60s after a *successful*
// workout and ask whether the rider's Bluetooth was off.
const fs = require('fs');
const path = require('path');
const J = path.join(__dirname, '..', 'js');
let fail = 0;
const check = (n, c, d) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) { fail++; if (d !== undefined) console.log('   ' + JSON.stringify(d)); } };

// ---- browser stubs (same shape as test_no_cadence.js) ----
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
let lastFetchBody = null;
global.fetch = async (url, opts) => {
  if (opts && opts.body) { try { lastFetchBody = JSON.parse(opts.body); } catch (e) { lastFetchBody = null; } }
  return { ok: true, status: 200, json: async () => ({ coaching: 'keep going' }) };
};
global.navigator.sendBeacon = () => true;
global.navigator.bluetooth = { requestDevice: async () => { throw new Error('unused'); } };

for (const f of ['state.js', 'diag-capture.js', 'pwa.js', 'ble.js', 'bike-dashboard.js', 'rower-dashboard.js', 'treadmill-dashboard.js', 'export.js', 'coach.js', 'app.js']) {
  eval(fs.readFileSync(path.join(J, f), 'utf8'));
}
const F = PS._frames;
const s = PS.state;
const cks = b => { let t = 0; for (let i = 0; i < b.length - 1; i++) t += b[i]; b[b.length - 1] = t & 0xFF; return Uint8Array.from(b); };
const ev = (bytes, uuid) => ({ target: { uuid: uuid || PS.ECH_DATA, value: new DataView(Uint8Array.from(bytes).buffer) } });
// Rower power: F0 D3 01 <watts> <cksum>.  Bike telemetry: 13-byte D1.
const rowerD3 = w => cks([0xF0, 0xD3, 0x01, w, 0]);
const bikeD1 = (revs, cad) => cks([0xF0, 0xD1, 0x09, 0, 0, 0, 0, (revs >> 8) & 0xFF, revs & 0xFF, (cad >> 8) & 0xFF, cad & 0xFF, 0x00, 0]);
const endValue = () => (pulse.filter(e => e.indexOf('workout_end:') === 0).pop() || '').replace('workout_end:', '');

(async () => {
  // ---- 1. rower watts reach their own array ----
  s.equipmentType = 'rower';
  F.resetStats();
  s.rowerPowerSamples = []; s.powerSamples = [];
  [120, 150, 180].forEach(w => F.onBLEData(ev(rowerD3(w))));
  check('rower D3 fills rowerPowerSamples', JSON.stringify(s.rowerPowerSamples) === '[120,150,180]', s.rowerPowerSamples);
  check('rower D3 does NOT touch the bike array', s.powerSamples.length === 0, s.powerSamples);
  check('live s.rowerPower still tracks the last packet', s.rowerPower === 180, s.rowerPower);
  F.onBLEData(ev(rowerD3(0)));
  check('a zero-watt D3 is not sampled (coasting between strokes)', s.rowerPowerSamples.length === 3, s.rowerPowerSamples);

  // ---- 2. bike is unchanged by all of this ----
  s.equipmentType = 'bike';
  s.powerSamples = []; s.cadenceSamples = []; s.rowerPowerSamples = [];
  s.resistance = 10;
  F.onBLEData(ev(bikeD1(10, 80)));
  check('bike D1 still fills powerSamples and cadenceSamples', s.powerSamples.length === 1 && s.cadenceSamples.length === 1, { p: s.powerSamples, c: s.cadenceSamples });
  check('bike D1 does not touch the rower array', s.rowerPowerSamples.length === 0);

  // ---- 3. the workout summary reads the right array per equipment ----
  function finishWorkout(type, setup) {
    pulse.length = 0;
    s.equipmentType = type;
    s.powerSamples = []; s.rowerPowerSamples = []; s.treadSpeedSamples = [];
    setup();
    s.workoutActive = true; s.planPending = false;
    s.workoutStartTime = Date.now() / 1000 - 1200;   // 20 minutes
    stopWorkout();
    return endValue();
  }
  let v = finishWorkout('rower', () => { s.rowerPowerSamples = [100, 150, 200]; });
  check('rower workout_end reports its own average, not 0W (' + v + ')', v === '20min:150W', v);
  v = finishWorkout('bike', () => { s.powerSamples = [80, 100, 120]; });
  check('bike workout_end unchanged (' + v + ')', v === '20min:100W', v);
  v = finishWorkout('treadmill', () => { s.treadSpeedSamples = [3.0, 3.5, 4.0]; });
  check('treadmill workout_end reports mph, not a misleading 0W (' + v + ')', v === '20min:3.5mph', v);
  v = finishWorkout('rower', () => { /* no samples at all */ });
  check('a workout with no samples still summarises cleanly (' + v + ')', v === '20min:0W', v);

  // ---- 4. the adaptive coach receives a real average ----
  s.equipmentType = 'rower';
  s.rowerPowerSamples = [100, 200]; s.powerSamples = [];
  s.rowerSPM = 24; s.spmSamples = [24, 26];
  s.workoutPlan = [{ name: 'steady state', duration_sec: 600, target_resistance_min: 3, target_resistance_max: 6, target_spm_min: 22, target_spm_max: 28, coaching_text: 'row' }];
  s.currentSegIdx = 0;
  s.workoutActive = true; s.planPending = false;
  s.workoutStartTime = Date.now() / 1000 - 120;
  s.segStartTime = Date.now() / 1000;
  s.lastAdaptiveCall = 0;
  lastFetchBody = null;
  checkCoachProgress();
  await new Promise(r => setTimeout(r, 30));
  check('adaptive request carries a non-zero rower avg_power',
    !!lastFetchBody && lastFetchBody.equipment_type === 'rower' && lastFetchBody.avg_power === 150,
    lastFetchBody && { type: lastFetchBody.equipment_type, avg_power: lastFetchBody.avg_power });
  s.workoutActive = false;

  // ---- 5. a second ride must not inherit the first ride's effort ----
  s.equipmentType = 'bike';
  s.powerSamples = [200, 220, 240];
  s.cadenceSamples = [95, 98];
  s.rowerPowerSamples = [180, 190];
  s.recordedPoints = [1, 2, 3];
  resetRide();
  check('resetRide clears bike power and cadence history',
    s.powerSamples.length === 0 && s.cadenceSamples.length === 0, { p: s.powerSamples, c: s.cadenceSamples });
  check('resetRide clears rower power history', s.rowerPowerSamples.length === 0, s.rowerPowerSamples);
  check('resetRide still clears what it always did', s.recordedPoints.length === 0 && s.rowerSPMSamples.length === 0);

  // ---- 6. starting a coached workout also starts its averages from scratch ----
  s.powerSamples = [1]; s.cadenceSamples = [1]; s.rowerPowerSamples = [1]; s.treadSpeedSamples = [1];
  // startWorkout() does a network round trip; assert the same clearing contract
  // the file applies, without the fetch: these are the arrays it resets.
  ['powerSamples', 'cadenceSamples', 'spmSamples', 'rowerPowerSamples', 'treadSpeedSamples'].forEach(k => { s[k] = []; });
  check('the arrays a coached workout resets include the rower and treadmill ones',
    /s\.rowerPowerSamples = \[\];/.test(fs.readFileSync(path.join(J, 'coach.js'), 'utf8')) &&
    /s\.treadSpeedSamples = \[\];/.test(fs.readFileSync(path.join(J, 'coach.js'), 'utf8')));

  // ---- 7. the help panel must not open on a rider who just finished ----
  // armConnectTrouble waits 60s; drive its timer directly rather than waiting.
  const realSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
  global.clearTimeout = () => {};
  els['connect-screen'] = mkEl('connect-screen');
  els['connect-screen'].style.display = 'flex';
  const panel = () => !els['connect-trouble'].classList.contains('hidden');

  s.rideCompletedAt = Date.now() / 1000;          // the workout ended just now
  pulse.length = 0;
  armConnectTrouble();
  check('help panel is armed for 60s as before', scheduled.length === 1 && scheduled[0].ms === 60000, scheduled.map(x => x.ms));
  scheduled.shift().fn();                          // 60s later
  check('a rider who just finished a workout is not asked about their Bluetooth',
    !panel() && pulse.filter(e => e.indexOf('connect_trouble_shown') === 0).length === 0, pulse);
  check('...it re-checks after the suppression window instead of giving up',
    scheduled.length === 1 && scheduled[0].ms > 0 && scheduled[0].ms <= PS.TROUBLE_AFTER_RIDE_S * 1000, scheduled.map(x => x.ms));

  s.rideCompletedAt = Date.now() / 1000 - (PS.TROUBLE_AFTER_RIDE_S + 30);   // and later, still stuck
  scheduled.shift().fn();
  check('someone still on the connect screen after the window does get help',
    panel() && pulse.some(e => e.indexOf('connect_trouble_shown') === 0), pulse);

  // a page load with no completed ride behaves exactly as before
  els['connect-trouble'].classList.add('hidden');
  s.rideCompletedAt = 0;
  pulse.length = 0;
  scheduled.length = 0;
  armConnectTrouble();
  scheduled.shift().fn();
  check('with no ride behind it, the panel opens at 60s as it always did',
    panel() && pulse.some(e => e.indexOf('connect_trouble_shown') === 0), pulse);
  global.setTimeout = realSetTimeout;

  console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
