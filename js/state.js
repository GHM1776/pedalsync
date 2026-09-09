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

// ---- Timeouts ----
PS.IDLE_TIMEOUT_WORKOUT = 300;  // 5 min — auto-stop workout
PS.IDLE_TIMEOUT_RIDE    = 180;  // 3 min — pause ride tracking

// ---- Mutable State ----
PS.state = {
  // BLE
  bleDevice: null,
  writeChar: null,

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
  rowerD1Buffer: null,
  rowerD1Expected: 0,
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