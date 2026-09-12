// ============================================================
// PedalSync — Shared State, Constants & Utilities
// ============================================================
window.PS = window.PS || {};

// ---- BLE UUIDs ----
PS.ECH_SERVICE = '0bf669f1-45f2-11e7-9598-0800200c9a66';
PS.ECH_WRITE   = '0bf669f2-45f2-11e7-9598-0800200c9a66';
PS.ECH_NOTIFY1 = '0bf669f3-45f2-11e7-9598-0800200c9a66';
PS.ECH_DATA    = '0bf669f4-45f2-11e7-9598-0800200c9a66';
PS.CMD_ENABLE  = new Uint8Array([0xF0, 0xB0, 0x01, 0x01, 0xA2]);

PS.API_BASE = location.origin;

// Build tag — keep equal to CACHE_NAME in sw.js (test/test_frames.js checks).
// Used only by the service-worker reload loop guard (sessionStorage.ps_reloaded).
PS.BUILD = 'v16';

// ---- Timeouts ----
PS.IDLE_TIMEOUT_WORKOUT    = 300;   // 5 min — auto-stop workout
PS.IDLE_TIMEOUT_RIDE       = 180;   // 3 min — pause ride tracking
PS.IDLE_TIMEOUT_DISCONNECT = 1800;  // 30 min — auto-disconnect BLE to save battery
PS.DONE_GRACE_AFTER_WORKOUT = 120;  // sec — drop within this window after workout end = user is done
PS.DONE_IDLE_BEFORE_DROP    = 60;   // sec — no pedal/stroke/step for this long before a drop = user is done
PS.DONE_IDLE_FAST_FAIL      = 30;   // sec — idle ≥ this at the drop and reconnect attempt 1 fails fast = equipment asleep, done
PS.RECONNECT_MAX_ATTEMPTS   = 5;    // attempts inside the 60s reconnect window ("retrying N of 5")
PS.RECONNECT_DELAYS         = [1000, 2000, 4000, 8000, 15000];  // ms backoff between attempts
PS.HARDFAIL_AUTO_END_MS     = 5 * 60 * 1000;  // an untouched hard-fail banner ends the workout after this
PS.PLAN_TIMEOUT_MS          = 45000; // coach plan / adaptive fetch abort — 45-min plans took >20s
PS.NO_CADENCE_AFTER_S       = 60;   // bike streaming D1 with revolutions stuck at 0 this long = "no pedal motion"

// ---- Optional: mirror the official app's BLE init chatter (ship OFF) ----
// From a snoop of the Echelon app: A1 x4, A3, A1, B0, then an A0 poll every 2s.
// B0 alone streams fine on every bike seen so far; this exists to test whether
// the Connect Sport's "no motion" state is something the app's chatter avoids.
PS.ECHELON_FULL_INIT = false;
PS.CMD_INIT_A1 = new Uint8Array([0xF0, 0xA1, 0x00, 0x91]);
PS.CMD_INIT_A3 = new Uint8Array([0xF0, 0xA3, 0x00, 0x93]);
PS.A0_POLL_MS  = 2000;
PS.cmdPollA0 = function(counter) {
  var c = counter & 0xFF;
  return new Uint8Array([0xF0, 0xA0, 0x01, c, (0xF0 + 0xA0 + 0x01 + c) & 0xFF]);
};

// ---- Mutable State ----
PS.state = {
  // BLE
  bleDevice: null,
  writeChar: null,
  connectedAt: 0,          // unix sec of last successful GATT setup (idle-disconnect basis)
  autoDisconnected: false, // set when the 30-min idle auto-disconnect fired
  updatePending: false,    // a new service worker took control mid-ride; reload after cleanup

  // Bike "no pedal motion" detection (D1 revolution counter, bytes 7-8)
  lastRevCount: 0,
  revStaticSince: 0,           // unix sec the rev count last changed (or was first seen)
  d2Count: 0,                  // D2 packets this connection
  lastD2Value: -1,
  d2ChangedSinceConnect: false, // a D2 arrived with a different value than the previous one = knob turned
  noCadenceFired: false,       // hint + event fired once this connection

  // Telemetry (bike)
  cadence: 0,
  resistance: 0,
  power: 0,

  // Ride tracking
  rideStart: 0,
  rideElapsed: 0,
  rideActive: false,
  lastCadenceTime: 0,
  totalDistance: 0,
  totalCalories: 0,
  lastUpdateTime: 0,
  lastNonZeroCadenceTime: 0,

  // Equipment info
  maxResistance: 32,
  bikeModel: '',
  equipmentType: 'bike',  // 'bike' | 'rower' | 'treadmill'

  // Display
  telemetryInterval: null,

  // Rower telemetry
  rowerSPM: 0,
  rowerStrokes: 0,
  rowerSplitSec: 0,
  rowerDistance: 0,
  rowerCalories: 0,
  rowerPower: 0,
  rowerSPMSamples: [],
  rowerSplitSamples: [],

  // Treadmill telemetry — UNVERIFIED, byte map estimated
  treadSpeed: 0,          // mph (parsed from BLE, may need unit correction)
  treadIncline: 0,        // incline level from D2 (may need % conversion)
  treadSteps: 0,          // step/stride count if available
  treadDistanceDevice: 0, // distance from device if available (miles)
  treadCaloriesDevice: 0, // calories from device if available
  treadSpeedSamples: [],  // for averaging

  // Workout / coach
  workoutActive: false,
  planPending: false,     // plan request in flight — not yet a workout
  workoutEndedAt: 0,      // unix sec stopWorkout() last ran (0 = never)
  workoutId: '',
  selectedDifficulty: 'easy',
  workoutPlan: [],
  currentSegIdx: 0,
  segStartTime: 0,
  workoutStartTime: 0,
  lastAdaptiveCall: 0,
  powerSamples: [],
  cadenceSamples: [],
  spmSamples: [],       // for rower adaptive coaching

  // Ride completion tracking
  rideTracked: false,
  rideCadenceStart: 0,

  // Workout recording (for export)
  recordedPoints: [],     // array of {time, cadence, power, resistance, distance, calories, spm, split, rowerPower, speed, incline}
  lastRecordTime: 0,      // timestamp of last recorded point
  rideStartDate: null,    // Date object for TCX export
};

// ---- Model Detection ----
PS.detectModel = function(bleName) {
  var n = (bleName || '').toUpperCase();
  var models = {
    'ECHEX-3':     { name: 'EX-3',          maxR: 32, type: 'bike' },
    'ECHEX-4':     { name: 'EX-4',          maxR: 32, type: 'bike' },
    'ECHEX-5S':    { name: 'EX-5S',         maxR: 32, type: 'bike' },
    'ECHEX-5':     { name: 'EX-5',          maxR: 32, type: 'bike' },
    'ECHEX-7':     { name: 'EX-7S',         maxR: 32, type: 'bike' },
    'ECH-GT':      { name: 'GT+',           maxR: 32, type: 'bike' },
    // Connect / Connect Sport ship with locked firmware (E0 challenge) — the
    // unlock proxy handles them. ECH-SPORTS is a newer BLE-name variant.
    'ECH-SPORTS':  { name: 'Connect Sport', maxR: 32, type: 'bike' },
    'ECH-SPORT':   { name: 'Connect Sport', maxR: 32, type: 'bike' },
    'ECH-CONNECT': { name: 'Connect',       maxR: 32, type: 'bike' },
    'ROW-7S':      { name: 'Row-7S',        maxR: 32, type: 'rower' },
    'ROW-4S':      { name: 'Row-4S',        maxR: 32, type: 'rower' },
    'ROW-SPORT':   { name: 'Row Sport',     maxR: 32, type: 'rower' },
    'ROW-SPT':     { name: 'Row Sport 2',   maxR: 32, type: 'rower' },
    'ROW-S':       { name: 'Row-S',         maxR: 32, type: 'rower' },
    'ROW-':        { name: 'Row',           maxR: 32, type: 'rower' },
    'ECHROW':      { name: 'Row',           maxR: 32, type: 'rower' },
    'STRIDE-8S':   { name: 'Stride-8S',    maxR: 20, type: 'treadmill' },
    'STRIDE-5S':   { name: 'Stride-5S',    maxR: 20, type: 'treadmill' },
    'STRIDE-4S':   { name: 'Stride-4S',    maxR: 20, type: 'treadmill' },
    'STRIDE-':     { name: 'Stride',        maxR: 20, type: 'treadmill' },
    'STRIDE':      { name: 'Stride',        maxR: 20, type: 'treadmill' },
    'ECHSTRIDE':   { name: 'Stride',        maxR: 20, type: 'treadmill' },
  };
  var keys = Object.keys(models).sort(function(a, b) { return b.length - a.length; });
  for (var i = 0; i < keys.length; i++) {
    if (n.startsWith(keys[i])) return models[keys[i]];
  }
  return { name: 'Echelon', maxR: 32, type: 'bike' };
};

// ---- Utility Functions ----
PS.calcPower = function(cad, res) {
  if (cad <= 0 || res <= 0) return 0;
  return Math.pow(1.090112, res) * Math.pow(1.015343, cad) * 7.228958;
};

PS.formatSplit = function(totalSec) {
  if (!totalSec || totalSec <= 0 || totalSec > 999) return '--:--';
  var mins = Math.floor(totalSec / 60);
  var secs = totalSec % 60;
  return mins + ':' + String(secs).padStart(2, '0');
};

PS.formatTime = function(totalSec) {
  var secs = Math.floor(totalSec);
  return String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
};

// Pace: minutes per mile from mph
PS.formatPace = function(mph) {
  if (!mph || mph <= 0) return '--:--';
  var totalSec = Math.round(3600 / mph); // seconds per mile
  var mins = Math.floor(totalSec / 60);
  var secs = totalSec % 60;
  if (mins > 99) return '--:--';
  return mins + ':' + String(secs).padStart(2, '0');
};