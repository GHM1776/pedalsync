// ============================================================
// PedalSync — App Init, Main Loop & Router
// ============================================================
(function() {
  var s = PS.state;

  // ---- Connect-Screen Trouble Timer ----
  // People stall silently on the connect screen — after 60s without a
  // connection, surface help and record that it happened.
  var troubleTimer = null;

  // EX-5S/EX-7S/GT+/Stride have a built-in screen whose Echelon app holds the
  // BLE link — one Hermosillo user burned three connect attempts on it in four
  // minutes. Lead with that when the equipment has a screen, or once any connect
  // attempt has failed (the same symptom on a model we don't recognise yet).
  window.updateTroubleLead = function() {
    var lead = document.getElementById('connect-trouble-tablet');
    if (!lead) return;
    var name = (s.bleDevice && s.bleDevice.name) || '';
    if (!name) { try { name = localStorage.getItem('ps_last_device') || ''; } catch(e) { /* private mode */ } }
    var hasScreen = /EX-5S|EX-7S|GT\+|STRIDE/i.test(name);
    var show = hasScreen || s.connectFailures > 0;
    lead.classList.toggle('hidden', !show);
    // The lead says this better — don't repeat it as a dimmer bullet below
    var li = document.getElementById('trouble-li-tablet');
    if (li) li.classList.toggle('hidden', show);
  };

  window.armConnectTrouble = function() {
    if (troubleTimer) clearTimeout(troubleTimer);
    var el = document.getElementById('connect-trouble');
    if (el) el.classList.add('hidden');
    troubleTimer = setTimeout(function fire() {
      troubleTimer = null;
      var screen = document.getElementById('connect-screen');
      if (!el || !screen || screen.style.display === 'none' || screen.style.display === '') return;
      // Finishing a workout lands you on this screen, and 60s later the panel
      // was asking a rower who had just rowed 21 minutes whether their
      // Bluetooth was off. Wait the window out, then reconsider — someone still
      // stuck after that really is stuck.
      var sinceRide = s.rideCompletedAt ? (Date.now() / 1000 - s.rideCompletedAt) : Infinity;
      if (sinceRide < PS.TROUBLE_AFTER_RIDE_S) {
        troubleTimer = setTimeout(fire, (PS.TROUBLE_AFTER_RIDE_S - sinceRide) * 1000);
        return;
      }
      updateTroubleLead();
      el.classList.remove('hidden');
      if (window.__pulse) window.__pulse('connect_trouble_shown', navigator.bluetooth ? 'ble_ok' : 'no_ble');
    }, 60000);
  };

  window.clearConnectTrouble = function() {
    if (troubleTimer) { clearTimeout(troubleTimer); troubleTimer = null; }
    var el = document.getElementById('connect-trouble');
    if (el) el.classList.add('hidden');
  };

  // ---- View Router ----
  window.showConnectScreen = function() {
    document.getElementById('gate').style.display = 'none';
    document.getElementById('connect-screen').style.display = 'flex';
    location.hash = 'connect';
    armConnectTrouble();
    // The pv /#connect moment: look for a newer service worker now, not on the
    // CONNECT tap (nothing may delay requestDevice())
    if (window.PSCheckForUpdate) PSCheckForUpdate();
    if (window.PSCheckVersion) PSCheckVersion();

    // Check Web Bluetooth support
    if (!navigator.bluetooth) {
      document.getElementById('ble-warning').textContent =
        'This browser can\'t connect — iPhone/iPad, Safari, and Firefox don\'t support Web Bluetooth. ' +
        'Use Chrome or Edge on Android, Windows, Mac, or ChromeOS.';
      document.querySelector('.btn-connect').disabled = true;
    }

    // Show install button if prompt is available
    if (PS.hasInstallPrompt()) {
      document.getElementById('btn-install').classList.remove('hidden');
    }
  };

  // ---- Main Display Loop (200ms) ----
  window.updateDisplay = function() {
    if (s.rideActive && s.rideStart > 0) {
      s.rideElapsed = Date.now() / 1000 - s.rideStart;
    }

    if (s.equipmentType === 'rower') {
      updateRowerDisplay();
    } else if (s.equipmentType === 'treadmill') {
      updateTreadmillDisplay();
    } else {
      updateBikeDisplay();
    }

    // One renderer for every HR tile; also applies the staleness timeout
    if (PS.hr && PS.hr.render) PS.hr.render();

    // Track ride completion
    checkRideCompletion();

    // Record data for export
    recordDataPoint();

    // Check coach progress (both bike and rower now)
    if (s.workoutActive) checkCoachProgress();

    // Idle timeout — auto-stop workout if no activity for 5 min
    if (s.lastNonZeroCadenceTime > 0) {
      var idleTime = Date.now() / 1000 - s.lastNonZeroCadenceTime;
      if (s.workoutActive && idleTime >= PS.IDLE_TIMEOUT_WORKOUT) {
        stopWorkout();
        showCoaching('Workout auto-stopped — no activity for 5 minutes.', 'TIMEOUT', 100);
      }
      if (s.rideActive && idleTime >= PS.IDLE_TIMEOUT_RIDE) {
        s.rideActive = false;
      }
    }

    // Auto-disconnect after 30 min with no activity — a connected phone holds a
    // wake lock and streams BLE, which drains a battery flat overnight.
    // Basis is last pedal/stroke/step, or connect time if they never moved.
    if (s.bleDevice && s.bleDevice.gatt && s.bleDevice.gatt.connected && !s.autoDisconnected) {
      var idleSince = s.lastNonZeroCadenceTime > 0 ? s.lastNonZeroCadenceTime : s.connectedAt;
      if (idleSince > 0 && (Date.now() / 1000 - idleSince) >= PS.IDLE_TIMEOUT_DISCONNECT) {
        s.autoDisconnected = true;
        if (window.__pulse) window.__pulse('auto_disconnect', 'idle:' + Math.round(PS.IDLE_TIMEOUT_DISCONNECT / 60) + 'min:' + s.equipmentType);
        disconnectBike();
      }
    }
  };

  // ---- Last-workout card (connect screen) ----
  // After a workout ends the samples are still in memory but the dashboard — and
  // its EXPORT button — is gone. Show the summary and the export on the connect screen.
  function avg(arr) {
    if (!arr || !arr.length) return 0;
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += arr[i];
    return t / arr.length;
  }

  window.showLastRideCard = function() {
    var el = document.getElementById('last-ride');
    if (!el) return false;
    if (!s.recordedPoints || s.recordedPoints.length < 2) { el.classList.add('hidden'); return false; }
    var stats;
    if (s.equipmentType === 'rower') {
      stats = PS.formatTime(s.rideElapsed) + ' · ' + Math.round(s.rowerDistance) + ' m · avg split ' + PS.formatSplit(Math.round(avg(s.rowerSplitSamples)));
    } else if (s.equipmentType === 'treadmill') {
      stats = PS.formatTime(s.rideElapsed) + ' · ' + s.totalDistance.toFixed(2) + ' mi · avg ' + (Math.round(avg(s.treadSpeedSamples) * 10) / 10) + ' mph';
    } else {
      stats = PS.formatTime(s.rideElapsed) + ' · ' + s.totalDistance.toFixed(1) + ' km · avg ' + Math.round(avg(s.powerSamples)) + ' W';
    }
    document.getElementById('last-ride-name').textContent =
      (s.bikeModel || 'Equipment') + (s.bleDevice && s.bleDevice.name ? ' — ' + s.bleDevice.name : '');
    document.getElementById('last-ride-stats').textContent = stats;
    el.classList.remove('hidden');
    return true;
  };

  window.hideLastRideCard = function() {
    var el = document.getElementById('last-ride');
    if (el) el.classList.add('hidden');
  };

  PS.lastRideShowing = function() {
    var el = document.getElementById('last-ride');
    return !!(el && !el.classList.contains('hidden'));
  };

  // ---- Reset Ride ----
  window.resetRide = function() {
    if (PS.resetRideSummaryFlag) PS.resetRideSummaryFlag();
    if (window.hideLastRideCard) hideLastRideCard();
    s.rideStart = 0;
    s.rideElapsed = 0;
    s.rideActive = false;
    s.totalDistance = 0;
    s.totalCalories = 0;
    s.lastNonZeroCadenceTime = 0;
    s.rideTracked = false;
    s.rideCadenceStart = 0;
    // Rower reset
    s.rowerSPM = 0;
    s.rowerStrokes = 0;
    s.rowerSplitSec = 0;
    s.rowerDistance = 0;
    s.rowerCalories = 0;
    s.rowerPower = 0;
    s.rowerSPMSamples = [];
    s.rowerSplitSamples = [];
    s.rowerPowerSamples = [];
    s.spmSamples = [];
    // Treadmill reset
    s.treadSpeed = 0;
    s.treadIncline = 0;
    s.treadSteps = 0;
    s.treadDistanceDevice = 0;
    s.treadCaloriesDevice = 0;
    s.treadSpeedSamples = [];
    // Bike effort history. Left behind, a second ride on the same page load
    // inherited the first one's power and cadence, inflating ride_complete's
    // avgW and the coach's avg_power. (coach.js clears these on startWorkout,
    // so this only ever bit un-coached rides — which is most of them.)
    s.powerSamples = [];
    s.cadenceSamples = [];
    // Heart-rate READING state only. hrDeviceName is not reading state — the
    // strap is still connected and still labels the tile.
    if (PS.hrClearReadings) PS.hrClearReadings();
    // Recording reset
    s.recordedPoints = [];
    s.lastRecordTime = 0;
    s.rideStartDate = null;
  };

  // ---- Demo Mode ----
  // Usage: ?demo=bike | ?demo=rower | ?demo=treadmill
  // Shows dashboard with simulated data for layout/styling testing
  function checkDemoMode() {
    var params = new URLSearchParams(window.location.search);
    var demo = (params.get('demo') || '').toLowerCase();
    if (!demo) return false;

    var validTypes = { bike: 'bike', rower: 'rower', treadmill: 'treadmill', tread: 'treadmill' };
    var type = validTypes[demo];
    if (!type) return false;

    s.equipmentType = type;
    s.rideActive = true;
    s.rideStart = Date.now() / 1000;
    s.rideStartDate = new Date();
    s.lastNonZeroCadenceTime = Date.now() / 1000;

    // Hide gate, show correct dashboard
    document.getElementById('gate').style.display = 'none';
    document.getElementById('connect-screen').style.display = 'none';

    if (type === 'rower') {
      document.getElementById('rower-dashboard').style.display = 'flex';
      document.getElementById('rower-name').textContent = 'Row-S — DEMO MODE';
      s.resistance = 5;
      location.hash = 'rower';
    } else if (type === 'treadmill') {
      document.getElementById('treadmill-dashboard').style.display = 'flex';
      document.getElementById('tread-name').textContent = 'Stride — DEMO MODE';
      s.treadIncline = 3;
      location.hash = 'treadmill';
    } else {
      document.getElementById('dashboard').style.display = 'flex';
      document.getElementById('bike-name').textContent = 'EX-5 — DEMO MODE';
      s.resistance = 14;
      location.hash = 'bike';
    }

    // Simulate live data every 200ms
    s.telemetryInterval = setInterval(function() {
      var t = (Date.now() / 1000 - s.rideStart);
      var wave = Math.sin(t / 8);        // slow oscillation
      var jitter = (Math.random() - 0.5) * 2;

      if (type === 'bike') {
        s.cadence = Math.round(75 + wave * 15 + jitter);
        s.resistance = Math.round(14 + Math.sin(t / 20) * 6);
        s.power = PS.calcPower(s.cadence, s.resistance);
        s.totalDistance += (s.cadence * 1.7) / (60 * 1000) * 0.2;
        s.totalCalories += s.power * (0.2 / 3600) * 0.86;
        s.powerSamples.push(s.power);
        s.cadenceSamples.push(s.cadence);
      } else if (type === 'rower') {
        s.rowerSPM = Math.round(24 + wave * 6 + jitter);
        s.rowerPower = Math.round(45 + wave * 20 + jitter * 3);
        s.rowerSplitSec = Math.round(200 - wave * 30);
        s.rowerStrokes = Math.round(t * 0.4);
        s.rowerDistance = Math.round(t * 2.5);
        s.rowerCalories = Math.round(t * 0.12);
        s.resistance = Math.round(5 + Math.sin(t / 25) * 3);
        s.rowerSPMSamples.push(s.rowerSPM);
        s.rowerSplitSamples.push(s.rowerSplitSec);
      } else if (type === 'treadmill') {
        s.treadSpeed = Math.round((6.5 + wave * 2 + jitter * 0.1) * 10) / 10;
        s.treadIncline = Math.round(3 + Math.sin(t / 25) * 3);
        s.treadSteps = Math.round(t * 2.6);
        s.totalDistance += s.treadSpeed * (0.2 / 3600);
        s.totalCalories += (s.treadSpeed * 0.035) * 0.2;
        s.treadSpeedSamples.push(s.treadSpeed);
      }

      s.lastNonZeroCadenceTime = Date.now() / 1000;
    }, 200);

    // Start display loop
    setInterval(window.updateDisplay, 200);
    return true;
  }

  // ---- Browser Support Note + Support Mail Prefill ----
  // Also called from connectBike() after model detection so the equipment line fills in.
  window.initSupportUI = function() {
    // Landing note under CONNECT reflects whether THIS browser can actually connect.
    // The always-visible BROWSER & DEVICE SUPPORT cards carry the general rule.
    var note = document.getElementById('gate-note');
    if (note) {
      if (navigator.bluetooth) {
        note.textContent = '✓ This browser supports Bluetooth — you\'re good to go.';
        note.classList.add('ok');
      } else {
        note.textContent = '✕ This browser can\'t connect — iPhone/iPad, Safari, and Firefox don\'t support ' +
          'Web Bluetooth. Use Chrome or Edge on Android, Windows, Mac, or ChromeOS.';
        note.classList.add('no');
      }
    }

    // Prefill every support mailto with the questions we need answered, plus the
    // ids that join a report to its debug capture. The Pulse session id rotates
    // per tab/PWA launch; ps_uid in localStorage is the stable one.
    var sid = '';
    try { sid = sessionStorage.getItem('__p') || ''; } catch (e) { /* private mode */ }
    var uid = '';
    try { uid = localStorage.getItem('ps_uid') || ''; } catch (e) { /* private mode */ }
    var equip = (s.bleDevice && s.bleDevice.name)
      ? 'Last equipment: ' + s.bleDevice.name + ' (' + (s.bikeModel || 'unknown model') + ')\n'
      : '';
    var body = 'Equipment model (e.g. EX-5S):\n\n' +
      'What the status line said after you tapped CONNECT:\n\n' +
      'Did you see "unlocking..." (yes / no):\n\n' +
      'What happened next:\n\n' +
      '--\n' +
      'Device: ' + uid + '\n' +
      equip +
      'Session: ' + sid + '  (please leave these lines — they link your report to the debug log)';
    var href = 'mailto:updates@pedalsync.app' +
      '?subject=' + encodeURIComponent('PedalSync problem report') +
      '&body=' + encodeURIComponent(body);
    document.querySelectorAll('a.support-mail').forEach(function(a) {
      a.href = href;
      if (!a.dataset.psClick) {
        a.dataset.psClick = '1';
        a.addEventListener('click', function() {
          if (window.__pulse) window.__pulse('support_click', a.closest('#connect-trouble') ? 'trouble' : 'banner');
        });
      }
    });
  };

  // ---- Init ----
  window.addEventListener('DOMContentLoaded', function() {
    getUserId();
    // Which build this session is actually running. Without it there is no way
    // to see how much of the fleet is stuck on an old one, or whether the
    // version poller is draining it.
    if (window.__pulse) window.__pulse('build', PS.BUILD);
    maybeShowSupportBanner();
    initSupportUI();
    checkDemoMode();
  });
})();