// Frame assembler regression test — run from the repo root: node test/test_frames.js
//
// The rower D1 is a 21-byte frame delivered as two BLE notifications (10 + 11).
// For weeks the checksum gate in onBLEData ran on the 10-byte head, failed, and
// dropped it — "Bad checksum | len:10, type:d1" once a second, every rower stat
// stuck at zero, exports empty. This test pins the assembler so that can't
// regress silently again. Loads the real state.js + ble.js with a minimal DOM stub.
const fs = require('fs');
const path = require('path');
const J = path.join(__dirname, '..', 'js');

global.window = global;
global.location = { origin: 'http://x' };
global.navigator = {};
const el = () => ({ classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, style: {}, textContent: '', disabled: false });
global.document = { addEventListener() {}, getElementById: el, querySelector: el, querySelectorAll: () => [] };
console.log = (() => { const orig = console.log; return (...a) => { if (a[0] !== '[PS]') orig(...a); }; })();  // mute ble.js debug chatter

eval(fs.readFileSync(path.join(J, 'state.js'), 'utf8'));
eval(fs.readFileSync(path.join(J, 'ble.js'), 'utf8'));

const F = PS._frames;
const s = PS.state;
let fail = 0;
const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) fail++; };
const cks = b => { let t = 0; for (let i = 0; i < b.length - 1; i++) t += b[i]; b[b.length - 1] = t & 0xFF; return Uint8Array.from(b); };
const ev = (bytes, uuid) => ({ target: { uuid: uuid || PS.ECH_DATA, value: new DataView(Uint8Array.from(bytes).buffer) } });

// 21-byte rower D1: F0 D1 11 … strokes(9-10 LE) spm(11) split(13-14 BE) dist(17-18 LE) cal(19) cksum(20)
function rowerD1(strokes, spm, split, dist, cal) {
  const f = new Array(21).fill(0);
  f[0] = 0xF0; f[1] = 0xD1; f[2] = 17;
  f[9] = strokes & 0xFF; f[10] = strokes >> 8; f[11] = spm;
  f[13] = split >> 8; f[14] = split & 0xFF;
  f[17] = dist & 0xFF; f[18] = dist >> 8; f[19] = cal;
  return cks(f);
}

// ---- 1. assembler primitives: [10, 11] ----
const frame = rowerD1(42, 26, 130, 500, 12);
F.fragReset();
check('10-byte rower head is a fragment head', F.isFragmentHead(frame.subarray(0, 10)));
F.fragStart(frame.subarray(0, 10));
let out = F.fragAppend(frame.subarray(10, 21));
check('[10, 11] reassembles to one 21-byte frame', !!out && out.length === 21);
check('reassembled frame passes verifyChecksum', !!out && F.verifyChecksum(out));
check('reassembled bytes identical to the original', !!out && Buffer.compare(Buffer.from(out), Buffer.from(frame)) === 0);

// ---- 2. [10, 10, 1] ----
F.fragReset();
F.fragStart(frame.subarray(0, 10));
check('[10, 10, 1]: second fragment is still partial', F.fragAppend(frame.subarray(10, 20)) === null);
out = F.fragAppend(frame.subarray(20, 21));
check('[10, 10, 1]: third fragment completes and verifies', !!out && out.length === 21 && F.verifyChecksum(out));

// ---- 3. things that must NOT be treated as fragments ----
const bikeD1 = cks([0xF0, 0xD1, 0x09, 0, 0, 0, 0, 0x00, 0x78, 0x00, 0x47, 0x00, 0]);   // 13 bytes, revs 120, cadence 71
check('13-byte bike D1 is a complete frame, not a head', !F.isFragmentHead(bikeD1) && F.verifyChecksum(bikeD1));
check('E0 challenge (random byte 2) is never a fragment head', !F.isFragmentHead(cks([0xF0, 0xE0, 0x5F, 1, 2, 3, 4, 0])));
check('D2 / D0 single-notification packets are not heads', !F.isFragmentHead(cks([0xF0, 0xD2, 0x01, 7, 0])) && !F.isFragmentHead(cks([0xF0, 0xD0, 0x01, 1, 0])));
F.fragReset();
check('continuation with nothing pending → dropped (null)', F.fragAppend(Uint8Array.from([1, 2, 3])) === null);

// ---- 4. end to end through onBLEData as a rower ----
s.equipmentType = 'rower';
const b0 = F.stats.badChecksum, g0 = F.stats.good, r0 = F.stats.framesReassembled;
F.onBLEData(ev(frame.subarray(0, 10)));
F.onBLEData(ev(frame.subarray(10, 21)));
check('rower D1 via onBLEData: zero bad checksum, one good, one reassembled', F.stats.badChecksum === b0 && F.stats.good === g0 + 1 && F.stats.framesReassembled === r0 + 1);
check('rower stats populated (strokes 42, spm 26, split 130, dist 500, cal 12)', s.rowerStrokes === 42 && s.rowerSPM === 26 && s.rowerSplitSec === 130 && s.rowerDistance === 500 && s.rowerCalories === 12);
F.onBLEData(ev(cks([0xF0, 0xD2, 0x01, 7, 0])));
F.onBLEData(ev(cks([0xF0, 0xD3, 0x01, 55, 0])));
check('rower D2 / D3 still parse (resistance 7, power 55)', s.resistance === 7 && s.rowerPower === 55);
F.onBLEData(ev(frame.subarray(0, 10)));
F.onBLEData(ev(frame.subarray(0, 10)));
check('a new head while one is pending counts one abandoned frame', F.stats.framesAbandoned === 1);
F.onBLEData(ev(frame.subarray(10, 21)));
check('…and the newer head still completes', F.stats.framesReassembled === r0 + 2 && F.stats.badChecksum === b0);

// ---- 5. bike path unchanged, unknown types keep their bytes ----
s.equipmentType = 'bike';
F.fragReset();
F.onBLEData(ev(bikeD1));
check('13-byte bike D1 parses directly (cadence 71)', s.cadence === 71);
const u0 = F.stats.unknown;
F.onBLEData(ev(cks([0xF0, 0x8B, 0x02, 0xAA, 0xBB, 0]), PS.ECH_NOTIFY1));
check('unknown 0x8b counted per type', F.stats.unknown === u0 + 1 && F.stats.unknownTypes['0x8b'] === 1);

// ---- 6. per-connection reset (stats used to carry across connections) ----
F.resetStats();
check('resetStats zeroes every counter, the gap clock and unknown types',
  F.stats.total === 0 && F.stats.good === 0 && F.stats.badChecksum === 0 && F.stats.unknown === 0 &&
  F.stats.gaps === 0 && F.stats.framesReassembled === 0 && F.stats.framesAbandoned === 0 &&
  F.stats.lastPacketTime === 0 && Object.keys(F.stats.unknownTypes).length === 0);
F.onBLEData(ev(bikeD1));
check('first packet after reset counts from 1 with no gap', F.stats.total === 1 && F.stats.gaps === 0);

// ---- 7. one build string, three files ----
// PS.BUILD drives the reload loop guard, CACHE_NAME drives the worker swap, and
// api/version.js is what open tabs poll to learn a deploy happened. If they
// drift, stale tabs either never update or reload in a circle.
const swSrc = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const cacheName = (swSrc.match(/CACHE_NAME = 'pedalsync-(v\d+)'/) || [])[1];
check('PS.BUILD equals sw.js CACHE_NAME (' + cacheName + ')', !!cacheName && PS.BUILD === cacheName);
const verSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'version.js'), 'utf8');
const apiBuild = (verSrc.match(/const BUILD = '(v\d+)'/) || [])[1];
check('api/version.js BUILD equals PS.BUILD (' + apiBuild + ')', !!apiBuild && apiBuild === PS.BUILD);

// ---- 8. A0/A1/A3 are our own writes echoed back, not anomalies ----
// With ECHELON_FULL_INIT on, an EX-5S echoed 60 A0 keepalives in 81 seconds —
// 42% of the stream. Counted as "unknown" they exhaust the 10-line log cap and
// the 20-slot diag ring buffer, fire unknown_packet for nothing, and dilute the
// checksum error rate.
F.resetStats();
s.equipmentType = 'bike';
const echoA0 = () => cks([0xF0, 0xA0, 0x01, 0x2B, 0]);                                  // our keepalive, counter 0x2B
const echoA1 = () => cks([0xF0, 0xA1, 0x06, 0x01, 0x0B, 0x00, 0x33, 0x0C, 0x03, 0]);    // status/config frame
const echoA3 = () => cks([0xF0, 0xA3, 0x02, 0x20, 0x01, 0]);
[echoA0(), echoA0(), echoA1(), echoA3()].forEach((p) => F.onBLEData(ev(p, PS.ECH_NOTIFY1)));
check('A0/A1/A3 land in the echo bucket, never in unknown', F.stats.echo === 4 && F.stats.unknown === 0,
  { echo: F.stats.echo, unknown: F.stats.unknown });
check('echo counted per type', F.stats.echoTypes['0xa0'] === 2 && F.stats.echoTypes['0xa1'] === 1 && F.stats.echoTypes['0xa3'] === 1, F.stats.echoTypes);
check('echoes are still valid frames (good, no bad checksums)', F.stats.good === 4 && F.stats.badChecksum === 0,
  { good: F.stats.good, bad: F.stats.badChecksum });
check('a genuinely unknown type still reports', (function() {
  F.onBLEData(ev(cks([0xF0, 0x8B, 0x02, 0xAA, 0xBB, 0]), PS.ECH_NOTIFY1));
  return F.stats.unknown === 1 && F.stats.echo === 4;
})(), { unknown: F.stats.unknown, echo: F.stats.echo });
F.resetStats();
check('resetStats clears the echo bucket too', F.stats.echo === 0 && Object.keys(F.stats.echoTypes).length === 0);

console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS');
process.exit(fail ? 1 : 0);
