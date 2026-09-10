// ============================================================
// PedalSync — BLE Connection, Unlock, Telemetry, Auto-Reconnect
// ============================================================
(function() {
  var s = PS.state;
  var wakeLock = null;
  var intentionalDisconnect = false;
  var reconnecting = false;

  var RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000]; // backoff between attempts
  var RECONNECT_WINDOW_MS = 60000;  // wall-clock budget — hard-fail after this
  var reconnectDeadline = 0;
  var rideSummaryEmitted = false;   // one ride_complete per connection
  var connectInFlight = false;      // CONNECT double-tap guard
  var hiddenAt = 0;                 // visibilitychange bookkeeping

  // ---- Silent Debug Logging ----
  // Sends debug events to Pulse — invisible to the user, visible in session timeline
  function debug(msg, data) {
    console.log('[PS]', msg, data || '');
    if (window.__pulse) {
      var val = msg;
      if (data) val += ' | ' + (typeof data === 'string' ? data : JSON.stringify(data));
      window.__pulse('debug', val.substring(0, 200));
    }
  }

  // ---- Diagnostic Packet Tap ----
  // Separate always-on listener so EVERY notification reaches PSDiag —
  // including the unlock window, where earlyHandler removes itself before
  // onBLEData is attached and no app listener would otherwise see a
  // re-challenge E0 arriving right after the key write.
  function diagTap(event) {
    if (!window.PSDiag) return;
    try {
      PSDiag.packet(event.target.uuid, new Uint8Array(event.target.value.buffer));
    } catch(e) { /* diagnostics must never break telemetry */ }
  }

  // ---- Screen Wake Lock ----
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function() { wakeLock = null; });
    } catch(e) { /* user denied or not supported */ }
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
  }

  document.addEventListener('visibilitychange', function() {
    var connected = !!(s.bleDevice && s.bleDevice.gatt && s.bleDevice.gatt.connected);
    // Only report past the landing gate — bounces off the landing page aren't signal.
    // Packet gaps mid-ride are almost always the phone leaving the tab; this proves it.
    var gate = document.getElementById('gate');
    var pastGate = !!(gate && gate.style.display === 'none');
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      if (pastGate && window.__pulse) window.__pulse('visibility', 'hidden:' + (connected ? 'connected' : 'idle'));
    } else if (document.visibilityState === 'visible') {
      if (pastGate && window.__pulse) {
        var away = hiddenAt ? Math.round((Date.now() - hiddenAt) / 1000) : 0;
        window.__pulse('visibility', 'visible:' + away + 's:' + (connected ? 'connected' : 'idle'));
      }
      if (connected) acquireWakeLock();
    }
  });

  // ---- Optional A0 keepalive poll (only when PS.ECHELON_FULL_INIT) ----
  var a0PollTimer = null;
  var a0Counter = 0;
  function startA0Poll(writeChar) {
    stopA0Poll();
    a0Counter = 0;
    a0PollTimer = setInterval(function() {
      if (!s.bleDevice || !s.bleDevice.gatt || !s.bleDevice.gatt.connected) { stopA0Poll(); return; }
      var pkt = PS.cmdPollA0(a0Counter++);
      writeChar.writeValue(pkt).then(function() {
        // Log the first few and then one a minute — every 2s forever would bloat the diag snapshot
        if (window.PSDiag && (a0Counter <= 3 || a0Counter % 30 === 0)) PSDiag.write('poll_a0', pkt, true);
      }).catch(function(e) {
        debug('A0 poll write failed', e.message);
        stopA0Poll();
      });
    }, PS.A0_POLL_MS);
  }
  function stopA0Poll() {
    if (a0PollTimer) { clearInterval(a0PollTimer); a0PollTimer = null; }
  }

  // ---- "No pedal motion" hint (bike dashboard) ----
  function hideNoCadenceHint() {
    var el = document.getElementById('no-cadence-hint');
    if (el) el.classList.add('hidden');
  }
  window.hideNoCadenceHint = hideNoCadenceHint;

  // ---- Reconnect Banner ----
  function showReconnectBanner(msg, showRetry) {
    var banners = document.querySelectorAll('.reconnect-banner');
    banners.forEach(function(b) {
      b.textContent = msg || 'Reconnecting...';
      b.classList.toggle('settled', !!showRetry);
      if (showRetry) {
        var btn = document.createElement('button');
        btn.className = 'banner-btn';
        btn.textContent = 'RECONNECT';
        btn.onclick = window.manualReconnect;
        b.appendChild(btn);
      }
      b.classList.remove('hidden');
    });
  }

  function hideReconnectBanner() {
    var banners = document.querySelectorAll('.reconnect-banner');
    banners.forEach(function(b) { b.classList.add('hidden'); });
  }

  // ---- GATT Setup (shared between initial connect and reconnect) ----
  // Returns { writeChar, dataChar } or throws
  async function setupGATT(server, statusMsg) {
    debug('GATT setup starting');

    var service;
    try {
      service = await server.getPrimaryService(PS.ECH_SERVICE);
    } catch(e) {
      debug('Service discovery failed', e.message);
      throw e;
    }

    var writeChar;
    try {
      writeChar = await service.getCharacteristic(PS.ECH_WRITE);
    } catch(e) {
      debug('Write characteristic failed', e.message);
      throw e;
    }

    var dataChar;
    try {
      dataChar = await service.getCharacteristic(PS.ECH_DATA);
    } catch(e) {
      debug('Data characteristic failed', e.message);
      throw e;
    }

    try {
      await dataChar.startNotifications();
      debug('F4 notifications subscribed');
      // A previous leg on this same characteristic (double-tap, reconnect) must not
      // leave stacked listeners — that doubled distance/calories in the field
      dataChar.removeEventListener('characteristicvaluechanged', diagTap);
      dataChar.removeEventListener('characteristicvaluechanged', onBLEData);
      dataChar.addEventListener('characteristicvaluechanged', diagTap);
      if (window.PSDiag) PSDiag.phase('f4_subscribed');
    } catch(e) {
      debug('F4 notification subscribe failed', e.message);
      throw e;
    }

    // Unlock detection
    var unlocked = await detectAndUnlock(dataChar, writeChar, statusMsg);
    if (unlocked) {
      debug('Firmware unlock completed');
      if (window.__pulse) window.__pulse('unlock');
    }

    // Attach telemetry parser
    dataChar.addEventListener('characteristicvaluechanged', onBLEData);

    // Try secondary notify (F3)
    try {
      var notify1 = await service.getCharacteristic(PS.ECH_NOTIFY1);
      await notify1.startNotifications();
      notify1.removeEventListener('characteristicvaluechanged', diagTap);
      notify1.removeEventListener('characteristicvaluechanged', onBLEData);
      notify1.addEventListener('characteristicvaluechanged', diagTap);
      notify1.addEventListener('characteristicvaluechanged', onBLEData);
      debug('F3 notifications subscribed');
      if (window.PSDiag) PSDiag.phase('f3_subscribed');
    } catch(e) { debug('F3 not available (non-critical)'); }

    // Enable data streaming
    try {
      if (PS.ECHELON_FULL_INIT) {
        // Mirror the official app's init chatter (A1 x4, A3, A1, B0), 50ms apart.
        // B0 goes last so PSDiag's 'cmd_enable' write still arms the watchdog.
        var seq = [
          ['init_a1', PS.CMD_INIT_A1], ['init_a1', PS.CMD_INIT_A1],
          ['init_a1', PS.CMD_INIT_A1], ['init_a1', PS.CMD_INIT_A1],
          ['init_a3', PS.CMD_INIT_A3], ['init_a1', PS.CMD_INIT_A1],
          ['cmd_enable', PS.CMD_ENABLE],
        ];
        for (var wi = 0; wi < seq.length; wi++) {
          await writeChar.writeValue(seq[wi][1]);
          if (window.PSDiag) PSDiag.write(seq[wi][0], seq[wi][1], true);
          await new Promise(function(r) { setTimeout(r, 50); });
        }
        debug('Full init sequence sent (A1x4, A3, A1, B0)');
        startA0Poll(writeChar);
      } else {
        await writeChar.writeValue(PS.CMD_ENABLE);
        debug('CMD_ENABLE sent');
        if (window.PSDiag) PSDiag.write('cmd_enable', PS.CMD_ENABLE, true);
      }
    } catch(e) {
      debug('CMD_ENABLE write failed', e.message);
      if (window.PSDiag) PSDiag.write('cmd_enable', PS.CMD_ENABLE, false, e);
      throw e;
    }

    s.connectedAt = Date.now() / 1000;
    s.autoDisconnected = false;
    rideSummaryEmitted = false;  // new connection = a new ride to summarize
    s.lastRevCount = 0; s.revStaticSince = 0;
    s.d2Count = 0; s.lastD2Value = -1; s.d2ChangedSinceConnect = false; s.noCadenceFired = false;
    hideNoCadenceHint();

    return { writeChar: writeChar, dataChar: dataChar };
  }

  // ---- Connect (initial, user-initiated) ----
  window.connectBike = async function() {
    // A second tap during "connecting…" used to start an overlapping leg on the
    // same device: doubled listeners (2x distance), doubled disconnect events.
    if (connectInFlight) {
      if (window.__pulse) window.__pulse('connect_click', 'ignored:inflight');
      return;
    }
    connectInFlight = true;
    var btn = document.querySelector('.btn-connect');
    if (btn) btn.disabled = true;

    var statusEl = document.getElementById('connect-status');
    statusEl.textContent = 'Scanning for device...';
    intentionalDisconnect = false;
    if (window.__pulse) window.__pulse('connect_click');
    var pickerOpened = Date.now();

    try {
      s.bleDevice = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'ECH' },
          { namePrefix: 'ROW' },
          { namePrefix: 'STRIDE' },
          { namePrefix: 'stride' },
        ],
        optionalServices: [PS.ECH_SERVICE],
      });

      statusEl.textContent = 'Found ' + s.bleDevice.name + ', connecting...';
      debug('Device found', s.bleDevice.name);
      if (window.PSDiag) PSDiag.begin(s.bleDevice.name);

      s.bleDevice.removeEventListener('gattserverdisconnected', onDisconnect);
      s.bleDevice.addEventListener('gattserverdisconnected', onDisconnect);

      var server = await s.bleDevice.gatt.connect();
      debug('GATT connected');
      if (window.PSDiag) PSDiag.phase('gatt_connected');

      var chars = await setupGATT(server, statusEl);
      s.writeChar = chars.writeChar;

      // Detect model and route to correct dashboard
      var model = PS.detectModel(s.bleDevice.name);
      s.bikeModel = model.name;
      s.maxResistance = model.maxR;
      s.equipmentType = model.type;
      debug('Model detected', { name: model.name, type: model.type, maxR: model.maxR });
      if (window.PSDiag) PSDiag.phase('model_detected', { name: model.name, type: model.type });
      if (window.initSupportUI) initSupportUI();  // support mailto now knows the equipment

      document.getElementById('connect-screen').style.display = 'none';

      if (s.equipmentType === 'rower') {
        document.getElementById('rower-dashboard').style.display = 'flex';
        document.getElementById('rower-name').textContent = model.name + ' — ' + s.bleDevice.name;
        document.getElementById('rower-resistance-max').textContent = '/ ' + s.maxResistance;
        location.hash = 'rower';
        maybeShowSupportBanner();
      } else if (s.equipmentType === 'treadmill') {
        document.getElementById('treadmill-dashboard').style.display = 'flex';
        document.getElementById('tread-name').textContent = model.name + ' — ' + s.bleDevice.name;
        document.getElementById('tread-incline-max').textContent = '/ ' + s.maxResistance;
        location.hash = 'treadmill';
        maybeShowSupportBanner();
      } else {
        document.getElementById('dashboard').style.display = 'flex';
        document.getElementById('bike-name').textContent = model.name + ' — ' + s.bleDevice.name;
        document.getElementById('resistance-max').textContent = '/ ' + s.maxResistance;
        location.hash = 'bike';
        maybeShowSupportBanner();
      }

      // Start display loop (only if not already running)
      if (!s.telemetryInterval) {
        s.telemetryInterval = setInterval(window.updateDisplay, 200);
      }
      if (!s.rideStartDate) s.rideStartDate = new Date();
      acquireWakeLock();

      // Track connect event in Pulse — include raw BLE name for unknown models
      if (window.__pulse) window.__pulse('connect', s.equipmentType + ':' + s.bikeModel + ':' + s.bleDevice.name);
      if (window.clearConnectTrouble) clearConnectTrouble();

    } catch(err) {
      if (err.name === 'NotFoundError') {
        // Same error for "user closed picker" and "nothing ever appeared" —
        // time in the picker is the tell: a long wait means no device showed
        var pickerSec = Math.round((Date.now() - pickerOpened) / 1000);
        if (pickerSec >= 8) {
          statusEl.textContent = 'No device found. Make sure the equipment is powered on and awake, and no other app or tablet is connected to it.';
          if (window.__pulse) window.__pulse('picker_empty', pickerSec + 's');
        } else {
          statusEl.textContent = 'No device selected. Tap CONNECT to try again.';
          if (window.__pulse) window.__pulse('picker_cancel', pickerSec + 's');
        }
      } else {
        statusEl.textContent = 'Error: ' + err.message;
        debug('Connect error', err.message);
      }
      console.error('BLE error:', err);
    } finally {
      connectInFlight = false;
      if (btn) btn.disabled = false;
    }
  };

  // ---- Firmware Unlock ----
  function detectAndUnlock(dataChar, writeChar, statusEl) {
    return new Promise(function(resolve) {
      var resolved = false;
      var timeout = setTimeout(function() {
        if (!resolved) {
          resolved = true;
          if (window.PSDiag) PSDiag.phase('unlock_window_timeout');
          resolve(false);
        }
      }, 5000);

      function earlyHandler(event) {
        if (resolved) return;
        var data = new Uint8Array(event.target.value.buffer);

        if (data.length === 8 && data[0] === 0xF0 && data[1] === 0xE0) {
          resolved = true;
          clearTimeout(timeout);
          dataChar.removeEventListener('characteristicvaluechanged', earlyHandler);

          if (statusEl && statusEl.textContent !== undefined) {
            statusEl.textContent = 'Locked firmware detected, unlocking...';
          }
          debug('E0 challenge detected');
          if (window.PSDiag) PSDiag.unlockRequest(data);

          var b64Challenge = btoa(String.fromCharCode.apply(null, data));
          var unlockBody = { challenge: b64Challenge };
          if (window.PSDiag) Object.assign(unlockBody, PSDiag.unlockBody());
          var unlockStatus = 0;

          fetch(PS.API_BASE + '/api/unlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(unlockBody),
          })
          .then(function(r) {
            unlockStatus = r.status;
            if (!r.ok) {
              debug('Unlock API HTTP error', { status: r.status });
              if (window.__pulse) window.__pulse('debug', 'Unlock HTTP ' + r.status);
            }
            return r.json();
          })
          .then(async function(result) {
            if (window.PSDiag) PSDiag.unlockResponse(result, unlockStatus);
            if (!result.key) throw new Error(result.error || 'No unlock key');

            var keyBytes = Uint8Array.from(atob(result.key), function(c) { return c.charCodeAt(0); });
            var toWrite;

            if (keyBytes.length === 8) {
              var framed = new Uint8Array(8);
              framed[0] = 0xF0;
              framed[1] = 0xE0;
              for (var i = 2; i < 7; i++) framed[i] = keyBytes[i];
              var sum = 0;
              for (var j = 0; j < 7; j++) sum += framed[j];
              framed[7] = sum & 0xFF;
              toWrite = framed;
            } else {
              toWrite = keyBytes;
            }

            try {
              await writeChar.writeValue(toWrite);
              if (window.PSDiag) PSDiag.write('key', toWrite, true);
            } catch(werr) {
              if (window.PSDiag) PSDiag.write('key', toWrite, false, werr);
              throw werr;
            }

            debug('Unlock key written');
            await new Promise(function(r) { setTimeout(r, 500); });
            resolve(true);
          })
          .catch(function(err) {
            debug('Unlock failed', err.message);
            if (window.__pulse) window.__pulse('debug', 'Unlock failed: ' + (err.message || 'unknown'));
            if (window.PSDiag) PSDiag.unlockError(err, unlockStatus);
            resolve(false);
          });

        } else if (data.length >= 4 && data[0] === 0xF0 && (data[1] === 0xD1 || data[1] === 0xD2)) {
          resolved = true;
          clearTimeout(timeout);
          dataChar.removeEventListener('characteristicvaluechanged', earlyHandler);
          debug('Device not locked, telemetry already flowing');
          if (window.PSDiag) PSDiag.phase('not_locked');
          resolve(false);
        }
      }

      dataChar.addEventListener('characteristicvaluechanged', earlyHandler);
    });
  }

  // ---- Disconnect Handler ----
  // Was an unintentional drop "the rider finished" or a real connection loss?
  // A rider who ended a workout and walked away (bike sleeps ~30s later) used to
  // get 60s of reconnect attempts and a wake lock held on a dark screen.
  function classifyDrop() {
    var now = Date.now() / 1000;
    var sinceWorkoutEnd = s.workoutEndedAt > 0 ? now - s.workoutEndedAt : null;
    var idleFor = s.lastNonZeroCadenceTime > 0 ? now - s.lastNonZeroCadenceTime
                                               : (s.connectedAt > 0 ? now - s.connectedAt : 0);
    var kind = 'drop';
    if (s.workoutActive) kind = 'drop';                                                    // mid-workout — always reconnect
    else if (sinceWorkoutEnd !== null && sinceWorkoutEnd <= PS.DONE_GRACE_AFTER_WORKOUT) kind = 'done';
    else if (idleFor >= PS.DONE_IDLE_BEFORE_DROP) kind = 'done';
    return { kind: kind, idle_s: Math.round(idleFor), sinceWorkoutEnd_s: sinceWorkoutEnd === null ? null : Math.round(sinceWorkoutEnd) };
  }

  function onDisconnect() {
    stopA0Poll();
    var cls = classifyDrop();   // before telemetry is zeroed
    debug('BLE disconnected', {
      intentional: intentionalDisconnect,
      kind: intentionalDisconnect ? 'intentional' : cls.kind,
      equipmentType: s.equipmentType,
      idle_s: cls.idle_s,
      sinceWorkoutEnd_s: cls.sinceWorkoutEnd_s,
    });
    if (window.PSDiag) PSDiag.disconnected(intentionalDisconnect ? 'user' : 'gatt');

    // Zero out live telemetry (but preserve ride totals, workout state, etc.)
    s.cadence = 0;
    s.power = 0;
    s.rowerSPM = 0;
    s.rowerPower = 0;
    s.rowerD1Buffer = null;
    s.treadSpeed = 0;
    s.treadIncline = 0;

    // If user explicitly disconnected, do full cleanup
    if (intentionalDisconnect) {
      debug('Intentional disconnect, cleaning up');
      if (window.__pulse) window.__pulse('disconnect', (s.autoDisconnected ? 'auto:' : 'user:') + s.equipmentType + ':' + s.bikeModel);
      fullDisconnectCleanup();
      return;
    }

    // Rider finished (post-workout grace, or idle before the drop) — no reconnect loop
    if (cls.kind === 'done') {
      if (window.__pulse) window.__pulse('disconnect', 'done:' + s.equipmentType + ':' + s.bikeModel);
      fullDisconnectCleanup('Ride ended — equipment disconnected. Tap CONNECT to ride again.');
      return;
    }

    // Unexpected disconnect — try to reconnect inside a fixed wall-clock window
    debug('Unexpected disconnect, attempting reconnect');
    if (window.__pulse) window.__pulse('disconnect', 'drop:' + s.equipmentType + ':' + s.bikeModel);
    reconnectDeadline = Date.now() + RECONNECT_WINDOW_MS;
    attemptReconnect(0);
  }

  // ---- Auto-Reconnect ----
  // gatt.connect() itself can hang for 30s+, so a raw attempt counter gives no
  // bound on total time. Race each attempt against the remaining window instead.
  function connectWithTimeout(ms) {
    return new Promise(function(resolve, reject) {
      var done = false;
      var t = setTimeout(function() {
        if (done) return;
        done = true;
        try { s.bleDevice.gatt.disconnect(); } catch(e) {} // cancels the pending connect
        reject(new Error('connect timed out'));
      }, Math.max(ms, 1000));
      s.bleDevice.gatt.connect().then(
        function(server) {
          if (done) { try { s.bleDevice.gatt.disconnect(); } catch(e) {} return; }
          done = true; clearTimeout(t); resolve(server);
        },
        function(err) {
          if (done) return;
          done = true; clearTimeout(t); reject(err);
        }
      );
    });
  }

  function hardFailReconnect(attempts) {
    reconnecting = false;
    var elapsed = Math.round((RECONNECT_WINDOW_MS - (reconnectDeadline - Date.now())) / 1000);
    debug('Reconnect hard fail', { attempts: attempts, elapsed_s: elapsed });
    if (window.__pulse) window.__pulse('reconnect_failed', 'attempts:' + attempts + ':elapsed:' + elapsed + 's');
    // The ride is over for summary purposes, and the screen must not stay awake on a dead link
    emitRideComplete();
    releaseWakeLock();
    // Stay on the dashboard with a manual retry — don't silently dump to the connect screen
    showReconnectBanner('Connection lost — couldn\'t reconnect. ', true);
  }

  window.manualReconnect = function() {
    if (reconnecting || intentionalDisconnect) return;
    reconnectDeadline = Date.now() + RECONNECT_WINDOW_MS;
    showReconnectBanner('Reconnecting...');
    attemptReconnect(0);
  };

  async function attemptReconnect(attempt) {
    if (intentionalDisconnect) return;
    if (Date.now() >= reconnectDeadline) { hardFailReconnect(attempt); return; }

    reconnecting = true;
    var remaining = reconnectDeadline - Date.now();
    var delay = Math.min(RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)],
                         Math.max(remaining - 5000, 500));
    showReconnectBanner('Reconnecting' + '.'.repeat((attempt % 3) + 1) + ' (attempt ' + (attempt + 1) + ')');
    debug('Reconnect attempt ' + (attempt + 1), { delay: delay, remaining_ms: remaining });

    // Wait before retry
    await new Promise(function(r) { setTimeout(r, delay); });

    // Check if user disconnected while we were waiting
    if (intentionalDisconnect) { reconnecting = false; return; }
    if (Date.now() >= reconnectDeadline) { hardFailReconnect(attempt + 1); return; }

    try {
      if (!s.bleDevice) throw new Error('No device reference');

      var server = await connectWithTimeout(reconnectDeadline - Date.now());
      debug('GATT reconnected on attempt ' + (attempt + 1));
      // New capture leg — the previous one ended at PSDiag.disconnected()
      if (window.PSDiag) {
        PSDiag.begin(s.bleDevice.name);
        PSDiag.phase('reconnect_leg', { attempt: attempt + 1 });
        PSDiag.phase('gatt_connected');
      }

      // Re-setup GATT (re-subscribe, re-unlock if needed, re-enable)
      var chars = await setupGATT(server, { textContent: '' });
      s.writeChar = chars.writeChar;

      // Success — hide banner, log it
      hideReconnectBanner();
      reconnecting = false;
      acquireWakeLock();

      debug('Reconnect successful', { attempt: attempt + 1 });
      if (window.__pulse) window.__pulse('reconnect_ok', 'attempt:' + (attempt + 1));

    } catch(err) {
      debug('Reconnect attempt ' + (attempt + 1) + ' failed', err.message);
      if (Date.now() >= reconnectDeadline) { hardFailReconnect(attempt + 1); return; }
      attemptReconnect(attempt + 1);
    }
  }

  // ---- Ride Summary (non-coach rides; coach workouts emit workout_end) ----
  function avgOf(arr) {
    if (!arr || !arr.length) return 0;
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += arr[i];
    return t / arr.length;
  }

  function emitRideComplete() {
    if (rideSummaryEmitted) return;
    if (s.workoutActive || s.rideElapsed < 120) return;
    var dur = Math.round(s.rideElapsed);
    var v;
    if (s.equipmentType === 'rower') {
      v = 'rower:' + dur + 's:avgSPM:' + Math.round(avgOf(s.rowerSPMSamples));
    } else if (s.equipmentType === 'treadmill') {
      v = 'treadmill:' + dur + 's:avgMPH:' + (Math.round(avgOf(s.treadSpeedSamples) * 10) / 10);
    } else {
      v = 'bike:' + dur + 's:avgW:' + Math.round(avgOf(s.powerSamples));
    }
    if (window.__pulse) window.__pulse('ride_complete', v);
    rideSummaryEmitted = true;
  }
  // resetRide() starts a new ride on the same connection — allow another summary
  PS.resetRideSummaryFlag = function() { rideSummaryEmitted = false; };

  // ---- Full Cleanup (only on intentional disconnect or failed reconnect) ----
  // msg: optional connect-status text (callers that pass nothing keep the old copy)
  function fullDisconnectCleanup(msg) {
    reconnecting = false;
    stopA0Poll();
    releaseWakeLock();
    hideReconnectBanner();
    hideNoCadenceHint();
    // A plan request still in flight must not start a workout on the connect screen
    if (window.abortPendingPlan) abortPendingPlan();

    emitRideComplete();
    s.rideActive = false;

    if (s.telemetryInterval) {
      clearInterval(s.telemetryInterval);
      s.telemetryInterval = null;
    }

    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('rower-dashboard').style.display = 'none';
    document.getElementById('treadmill-dashboard').style.display = 'none';
    document.getElementById('connect-screen').style.display = 'flex';
    document.getElementById('connect-status').textContent = msg ? msg : (s.autoDisconnected
      ? 'Auto-disconnected after ' + Math.round(PS.IDLE_TIMEOUT_DISCONNECT / 60) + ' minutes of inactivity to save battery. Tap CONNECT to resume.'
      : 'Disconnected — power on your device and reconnect.');
    location.hash = 'connect';
    if (window.armConnectTrouble) armConnectTrouble();
  }

  // ---- Voluntary Disconnect (user-initiated) ----
  window.disconnectBike = function() {
    intentionalDisconnect = true;
    reconnecting = false;
    if (s.bleDevice && s.bleDevice.gatt.connected) {
      s.bleDevice.gatt.disconnect();
    } else {
      // Already disconnected (maybe during reconnect attempts), just clean up
      fullDisconnectCleanup();
    }
  };

  // ---- BLE Data Parsing ----
  // Packet health tracking
  var packetStats = { total: 0, good: 0, badChecksum: 0, unknown: 0, lastPacketTime: 0, gaps: 0 };
  var PACKET_GAP_THRESHOLD = 3; // seconds — flag if no packets for this long
  var lastHealthLog = 0;

  function verifyChecksum(data) {
    if (data.length < 3) return true; // too short to verify
    var sum = 0;
    for (var i = 0; i < data.length - 1; i++) sum += data[i];
    return (sum & 0xFF) === data[data.length - 1];
  }

  function onBLEData(event) {
    var data = new Uint8Array(event.target.value.buffer);
    if (data.length < 2) return;

    var now = Date.now() / 1000;
    var dt = s.lastUpdateTime > 0 ? now - s.lastUpdateTime : 0;
    s.lastUpdateTime = now;

    // Track packet health
    packetStats.total++;
    if (packetStats.lastPacketTime > 0 && (now - packetStats.lastPacketTime) > PACKET_GAP_THRESHOLD) {
      packetStats.gaps++;
      debug('Packet gap', { gapSec: Math.round(now - packetStats.lastPacketTime), totalGaps: packetStats.gaps });
    }
    packetStats.lastPacketTime = now;

    // Checksum verification (F0-prefixed packets)
    if (data[0] === 0xF0 && data.length >= 4) {
      if (!verifyChecksum(data)) {
        packetStats.badChecksum++;
        debug('Bad checksum', { len: data.length, type: data[1].toString(16), bad: packetStats.badChecksum, total: packetStats.total });
        return; // Drop corrupted packets
      }
      packetStats.good++;
    }

    // Log packet health every 5 minutes
    if (now - lastHealthLog > 300) {
      lastHealthLog = now;
      if (packetStats.total > 0) {
        debug('Packet health', {
          total: packetStats.total,
          good: packetStats.good,
          badCksum: packetStats.badChecksum,
          unknown: packetStats.unknown,
          gaps: packetStats.gaps,
          errRate: packetStats.badChecksum > 0 ? Math.round(packetStats.badChecksum / packetStats.total * 100) + '%' : '0%'
        });
      }
    }

    // ---- ROWER ----
    if (s.equipmentType === 'rower') {
      parseRowerPacket(data, now, dt);
      return;
    }

    // ---- TREADMILL ---- UNVERIFIED byte map
    if (s.equipmentType === 'treadmill') {
      parseTreadmillPacket(data, now, dt);
      return;
    }

    // ---- BIKE ----
    if (data.length < 4) return;

    if (data[1] === 0xD1 && data.length >= 11) {
      s.cadence = (data[9] << 8) | data[10];

      // Revolution counter (bytes 7-8). A bike streaming D1 with this stuck at 0
      // while the rider interacts is reporting "no pedal motion" — updateBikeDisplay
      // turns that into a hint + no_cadence event.
      var revs = (data[7] << 8) | data[8];
      if (s.revStaticSince === 0 || revs !== s.lastRevCount) {
        s.lastRevCount = revs;
        s.revStaticSince = now;
      }

      // Anomaly detection — flag impossible values (firmware change?)
      if (s.cadence > 200) {
        debug('Anomaly: cadence ' + s.cadence, { raw9: data[9], raw10: data[10] });
        s.cadence = 0; // don't show garbage to user
      }

      s.power = PS.calcPower(s.cadence, s.resistance);

      if (s.cadence > 0) {
        if (!s.rideActive) {
          s.rideActive = true;
          if (s.rideStart === 0) s.rideStart = now;
        }
        s.lastCadenceTime = now;
        s.lastNonZeroCadenceTime = now;

        if (dt > 0 && dt < 5) {
          s.totalDistance += (s.cadence * 1.7) / (60 * 1000) * dt;
          if (s.power > 0) s.totalCalories += s.power * (dt / 3600) * 0.86;
        }
      } else {
        if (s.rideActive && now - s.lastCadenceTime > 3) s.rideActive = false;
      }

      if (s.cadence > 0) {
        s.powerSamples.push(s.power);
        s.cadenceSamples.push(s.cadence);
      }

    } else if (data[1] === 0xD2 && data.length >= 4) {
      var newR = data[3];
      // A D2 carrying a different value than the previous D2 = the knob was turned
      if (s.d2Count > 0 && newR !== s.lastD2Value) s.d2ChangedSinceConnect = true;
      s.d2Count++;
      s.lastD2Value = newR;
      if (newR > 50) {
        debug('Anomaly: resistance ' + newR);
      } else {
        s.resistance = newR;
      }
      s.power = PS.calcPower(s.cadence, s.resistance);
    } else if (data[0] === 0xF0 && data[1] !== 0xD0 && data[1] !== 0xD5) {
      // Unknown packet type (D0 = ack, D5 = heartbeat — expected, don't log)
      packetStats.unknown++;
      if (packetStats.unknown <= 5) {
        debug('Unknown packet', { type: '0x' + data[1].toString(16), len: data.length });
      }
    }
  }

  // ---- Rower Packet Routing ----
  function parseRowerPacket(data, now, dt) {
    if (data[0] === 0xF0 && data[1] === 0xD1 && data.length >= 10) {
      var payloadLen = data[2];
      var totalLen = payloadLen + 4;
      s.rowerD1Buffer = new Uint8Array(totalLen);
      s.rowerD1Buffer.set(data.subarray(0, Math.min(data.length, totalLen)));
      s.rowerD1Expected = totalLen;
      return;
    }

    if (s.rowerD1Buffer && data[0] !== 0xF0) {
      var firstLen = 10;
      var remaining = s.rowerD1Expected - firstLen;
      if (data.length >= remaining) {
        for (var i = 0; i < remaining && (firstLen + i) < s.rowerD1Buffer.length; i++) {
          s.rowerD1Buffer[firstLen + i] = data[i];
        }
        parseRowerD1(s.rowerD1Buffer, now, dt);
        s.rowerD1Buffer = null;
        s.rowerD1Expected = 0;
      }
      return;
    }

    if (data[0] === 0xF0 && data[1] === 0xD2 && data.length >= 4) {
      s.resistance = data[3];
      return;
    }

    if (data[0] === 0xF0 && data[1] === 0xD3 && data.length >= 4) {
      s.rowerPower = data[3];
      return;
    }
  }

  // ---- Rower D1 Parse (21 bytes reassembled) ----
  function parseRowerD1(pkt, now, dt) {
    if (pkt.length < 21) return;

    s.rowerStrokes  = (pkt[10] << 8) | pkt[9];
    s.rowerSPM      = pkt[11];
    s.rowerSplitSec = (pkt[13] << 8) | pkt[14];
    s.rowerDistance  = (pkt[18] << 8) | pkt[17];
    s.rowerCalories  = pkt[19];

    if (s.rowerSPM > 0) {
      if (!s.rideActive) {
        s.rideActive = true;
        if (s.rideStart === 0) s.rideStart = now;
      }
      s.lastCadenceTime = now;
      s.lastNonZeroCadenceTime = now;
      s.rowerSPMSamples.push(s.rowerSPM);
      s.spmSamples.push(s.rowerSPM);
      if (s.rowerSplitSec > 0 && s.rowerSplitSec < 600) {
        s.rowerSplitSamples.push(s.rowerSplitSec);
      }
    } else {
      if (s.rideActive && now - s.lastCadenceTime > 3) s.rideActive = false;
    }
  }

  // ---- Treadmill Packet Routing ----
  function parseTreadmillPacket(data, now, dt) {
    if (data[0] === 0xF0 && data[1] === 0xD1 && data.length >= 11) {
      var rawSpeed = (data[9] << 8) | data[10];
      s.treadSpeed = rawSpeed / 10;

      if (data.length >= 9) {
        s.treadSteps = data[8];
      }

      if (s.treadSpeed > 0) {
        if (!s.rideActive) {
          s.rideActive = true;
          if (s.rideStart === 0) s.rideStart = now;
        }
        s.lastCadenceTime = now;
        s.lastNonZeroCadenceTime = now;
        s.treadSpeedSamples.push(s.treadSpeed);

        if (dt > 0 && dt < 5) {
          s.totalDistance += s.treadSpeed * (dt / 3600);
          s.totalCalories += (s.treadSpeed * 0.035) * dt;
        }
      } else {
        if (s.rideActive && now - s.lastCadenceTime > 3) s.rideActive = false;
      }
      return;
    }

    if (data[0] === 0xF0 && data[1] === 0xD2 && data.length >= 4) {
      s.treadIncline = data[3];
      return;
    }
  }
})();