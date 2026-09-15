// ============================================================
// PedalSync — BLE Connection, Unlock, Telemetry, Auto-Reconnect
// ============================================================
(function() {
  var s = PS.state;
  var wakeLock = null;
  var intentionalDisconnect = false;
  var reconnecting = false;

  var RECONNECT_WINDOW_MS = 60000;  // wall-clock budget — hard-fail after this
  var reconnectDeadline = 0;
  var reconnectGen = 0;             // bumped whenever a reconnect loop must die (END WORKOUT, cleanup)
  var currentAttempt = 0;           // 1-based attempt number shown in the banner
  var dropIdleS = 0;                // idle seconds at the moment of the drop (asleep tiebreaker)
  var dropEmitted = false;          // one `disconnect` event per drop: drop | done:asleep
  var ignoreDisconnects = false;    // a late gattserverdisconnected after the session was closed
  var hardFailTimer = null;         // inactivity auto-end after a hard fail
  var rideSummaryEmitted = false;   // one ride_complete per connection
  var connectInFlight = false;      // CONNECT double-tap guard; also gates SW-update reloads
  PS.connectInFlight = function() { return connectInFlight; };
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
  // opts.retry → RECONNECT button (hard fail); opts.endWorkout → END WORKOUT button
  function showReconnectBanner(msg, opts) {
    opts = opts || {};
    var banners = document.querySelectorAll('.reconnect-banner');
    banners.forEach(function(b) {
      b.textContent = msg || 'Reconnecting...';
      b.classList.toggle('settled', !!opts.retry);
      if (opts.retry || opts.endWorkout) {
        var actions = document.createElement('div');
        actions.className = 'banner-actions';
        if (opts.retry) actions.appendChild(bannerButton('RECONNECT', window.manualReconnect));
        if (opts.endWorkout) actions.appendChild(bannerButton('END WORKOUT', function() { window.endWorkoutFromBanner(false); }));
        b.appendChild(actions);
      }
      b.classList.remove('hidden');
    });
  }
  function bannerButton(label, onclick) {
    var btn = document.createElement('button');
    btn.className = 'banner-btn';
    btn.textContent = label;
    btn.onclick = onclick;
    return btn;
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
    s.d2Count = 0; s.lastD2Value = -1; s.lastD2ChangeTime = 0; s.noCadenceFired = false;
    hideNoCadenceHint();
    resetPacketStats();

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
    // An update held back while the last-workout card was showing applies now —
    // this tap reloads the page (one extra tap; the samples were about to be superseded)
    if (s.updatePending && window.PSApplyPendingUpdate) {
      if (window.__pulse) window.__pulse('connect_click', 'applying_update');
      if (PSApplyPendingUpdate()) return;
    }
    connectInFlight = true;
    var btn = document.querySelector('.btn-connect');
    if (btn) btn.disabled = true;

    var statusEl = document.getElementById('connect-status');
    statusEl.textContent = 'Scanning for device...';
    intentionalDisconnect = false;
    ignoreDisconnects = false;   // new session
    if (window.__pulse) window.__pulse('connect_click');
    // No awaits between here and requestDevice(): the picker needs the tap's
    // transient user activation, which Chrome expires after ~5s
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
      // Remembered for the built-in-tablet hint on a later visit ("the last
      // device name seen"); set here so a failed GATT connect still counts.
      try { localStorage.setItem('ps_last_device', s.bleDevice.name || ''); } catch(e) { /* private mode */ }
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
      s.connectFailures = 0;
      if (window.clearConnectTrouble) clearConnectTrouble();
      if (window.hideLastRideCard) hideLastRideCard();
      // Re-attach a known heart-rate strap, but only now that equipment
      // telemetry is flowing — never a second GATT attempt in parallel with
      // the first, which is where budget Android BLE stacks fall over.
      if (PS.hr && PS.hr.autoReconnect) setTimeout(function() { PS.hr.autoReconnect(); }, 2000);

    } catch(err) {
      if (err.name === 'NotFoundError') {
        // Same error for "user closed picker" and "nothing ever appeared" —
        // time in the picker is the tell: a long wait means no device showed
        var pickerSec = Math.round((Date.now() - pickerOpened) / 1000);
        if (pickerSec >= 8) {
          statusEl.textContent = 'No device found. Make sure the equipment is powered on and awake, and no other app or tablet is connected to it.';
          if (window.__pulse) window.__pulse('picker_empty', pickerSec + 's');
          s.connectFailures++;   // nothing advertised: a tablet holding the link looks exactly like this
        } else {
          statusEl.textContent = 'No device selected. Tap CONNECT to try again.';
          if (window.__pulse) window.__pulse('picker_cancel', pickerSec + 's');   // the user closed the picker — not a failure
        }
      } else {
        statusEl.textContent = 'Error: ' + err.message;
        debug('Connect error', err.message);
        s.connectFailures++;
      }
      if (window.updateTroubleLead) updateTroubleLead();
      console.error('BLE error:', err);
    } finally {
      connectInFlight = false;
      if (btn) btn.disabled = false;
      // An update deferred during the picker/setup is safe to apply if we ended up unconnected
      var connectedNow = !!(s.bleDevice && s.bleDevice.gatt && s.bleDevice.gatt.connected);
      var cardShowing = !!(PS.lastRideShowing && PS.lastRideShowing());
      if (s.updatePending && !connectedNow && !cardShowing && window.PSApplyPendingUpdate) PSApplyPendingUpdate();
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
    if (ignoreDisconnects) { debug('Late disconnect event after the session ended — ignored'); return; }
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
    fragReset();
    s.treadSpeed = 0;
    s.treadIncline = 0;

    // If user explicitly disconnected, do full cleanup
    if (intentionalDisconnect) {
      debug('Intentional disconnect, cleaning up');
      if (window.__pulse) window.__pulse('disconnect', (s.autoDisconnected ? 'auto:' : 'user:') + s.equipmentType + ':' + s.bikeModel);
      fullDisconnectCleanup(null, { disconnectHR: true });
      return;
    }

    // Rider finished (post-workout grace, or idle before the drop) — no reconnect loop
    if (cls.kind === 'done') {
      if (window.__pulse) window.__pulse('disconnect', 'done:' + s.equipmentType + ':' + s.bikeModel);
      fullDisconnectCleanup('Workout ended — equipment disconnected. Tap CONNECT to start another.');
      return;
    }

    // Unexpected disconnect — try to reconnect inside a fixed wall-clock window.
    // If the rider had been idle a while the equipment may simply have gone to
    // sleep: hold the drop event until attempt 1 tells us, so one disconnect
    // produces one event (drop, or done:asleep).
    debug('Unexpected disconnect, attempting reconnect');
    dropIdleS = cls.idle_s;
    dropEmitted = false;
    if (cls.idle_s < PS.DONE_IDLE_FAST_FAIL) emitDrop();
    startReconnectLoop();
  }

  function emitDrop() {
    if (dropEmitted) return;
    dropEmitted = true;
    if (window.__pulse) window.__pulse('disconnect', 'drop:' + s.equipmentType + ':' + s.bikeModel);
  }

  function startReconnectLoop() {
    reconnectDeadline = Date.now() + RECONNECT_WINDOW_MS;
    clearHardFailTimer();
    ignoreDisconnects = false;
    reconnectGen++;
    attemptReconnect(0, reconnectGen);
  }

  // Equipment not advertising: Chrome desktop says "Connection attempt failed",
  // other platforms just a NetworkError — either way it comes back fast
  function isNotAdvertising(err) {
    var m = (err && err.message) || '';
    return (err && err.name === 'NetworkError') || /connection attempt failed/i.test(m);
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
    emitDrop();
    var elapsed = Math.round((RECONNECT_WINDOW_MS - (reconnectDeadline - Date.now())) / 1000);
    debug('Reconnect hard fail', { attempts: attempts, elapsed_s: elapsed });
    if (window.__pulse) window.__pulse('reconnect_failed', 'attempts:' + attempts + ':elapsed:' + elapsed + 's');
    // The ride is over for summary purposes, and the screen must not stay awake on a dead link
    emitRideComplete();
    releaseWakeLock();
    // Stay on the dashboard with a manual retry — the export lives here. Left
    // untouched, the banner ends the workout on its own (the 30-min idle timer
    // only runs while connected, so this state had no exit before).
    showReconnectBanner('Workout saved — ' + (s.bikeModel || 'equipment') + ' disconnected. ', { retry: true, endWorkout: true });
    startHardFailTimer();
  }

  // ---- Hard-fail inactivity timer ----
  function startHardFailTimer() {
    clearHardFailTimer();
    hardFailTimer = setTimeout(function() {
      hardFailTimer = null;
      window.endWorkoutFromBanner(true);
    }, PS.HARDFAIL_AUTO_END_MS);
  }
  function clearHardFailTimer() {
    if (hardFailTimer) { clearTimeout(hardFailTimer); hardFailTimer = null; }
  }
  // Any tap on the page restarts the countdown
  document.addEventListener('pointerdown', function() { if (hardFailTimer) startHardFailTimer(); }, true);

  window.manualReconnect = function() {
    if (reconnecting || intentionalDisconnect) return;
    startReconnectLoop();
  };

  // END WORKOUT from the reconnect / hard-fail banner (auto = inactivity timer)
  window.endWorkoutFromBanner = function(auto) {
    var tag = auto ? 'auto' : 'attempt' + (currentAttempt || 1);
    reconnectGen++;               // an in-flight attempt bails at its next check
    intentionalDisconnect = true; // and the wait-phase check
    reconnecting = false;
    clearHardFailTimer();
    if (window.__pulse) window.__pulse('disconnect', 'ended:' + s.equipmentType + ':' + s.bikeModel + ':' + tag);
    dropEmitted = true;           // a still-held drop is accounted for by this event
    fullDisconnectCleanup('Workout ended. Tap CONNECT to start another.', { disconnectHR: true });
  };

  async function attemptReconnect(attempt, gen) {
    if (gen !== reconnectGen || intentionalDisconnect) return;
    if (attempt >= PS.RECONNECT_MAX_ATTEMPTS || Date.now() >= reconnectDeadline) { hardFailReconnect(attempt); return; }
    currentAttempt = attempt + 1;

    reconnecting = true;
    var remaining = reconnectDeadline - Date.now();
    var delays = PS.RECONNECT_DELAYS;
    var delay = Math.min(delays[Math.min(attempt, delays.length - 1)],
                         Math.max(remaining - 5000, 500));
    showReconnectBanner((s.bikeModel || 'Equipment') + ' not responding — retrying (' + (attempt + 1) + ' of ' + PS.RECONNECT_MAX_ATTEMPTS + ')', { endWorkout: true });
    debug('Reconnect attempt ' + (attempt + 1), { delay: delay, remaining_ms: remaining });

    // Wait before retry
    await new Promise(function(r) { setTimeout(r, delay); });

    // The loop may have been ended (END WORKOUT / cleanup) or the user disconnected while we waited
    if (gen !== reconnectGen || intentionalDisconnect) { reconnecting = false; return; }
    if (Date.now() >= reconnectDeadline) { hardFailReconnect(attempt + 1); return; }

    var started = Date.now();
    try {
      if (!s.bleDevice) throw new Error('No device reference');

      var server = await connectWithTimeout(reconnectDeadline - Date.now());
      if (gen !== reconnectGen) {
        // END WORKOUT won the race — let go of the link we just made, quietly
        try { s.bleDevice.gatt.disconnect(); } catch(e) {}
        return;
      }
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
      emitDrop();              // a held drop that recovered still counts as a drop
      clearHardFailTimer();
      hideReconnectBanner();
      reconnecting = false;
      acquireWakeLock();

      debug('Reconnect successful', { attempt: attempt + 1 });
      if (window.__pulse) window.__pulse('reconnect_ok', 'attempt:' + (attempt + 1));

    } catch(err) {
      if (gen !== reconnectGen) return;
      var took = Date.now() - started;
      debug('Reconnect attempt ' + (attempt + 1) + ' failed', { err: err.message, took_ms: took });
      // Asleep-equipment tiebreaker: the rider was idle when the link dropped and
      // the device isn't advertising — it went to sleep. That's a finished workout,
      // not a connection problem, and nobody should watch five retries for it.
      if (attempt === 0 && dropIdleS >= PS.DONE_IDLE_FAST_FAIL && took <= 3000 && isNotAdvertising(err)) {
        reconnecting = false;
        dropEmitted = true;
        if (window.__pulse) window.__pulse('disconnect', 'done:' + s.equipmentType + ':' + s.bikeModel + ':asleep');
        fullDisconnectCleanup('Workout ended — equipment disconnected. Tap CONNECT to start another.');
        return;
      }
      emitDrop();   // the loop goes on: this is a real drop
      if (attempt + 1 >= PS.RECONNECT_MAX_ATTEMPTS || Date.now() >= reconnectDeadline) { hardFailReconnect(attempt + 1); return; }
      attemptReconnect(attempt + 1, gen);
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
    s.rideCompletedAt = Date.now() / 1000;   // the connect screen's help panel waits this out
  }
  // resetRide() starts a new ride on the same connection — allow another summary
  PS.resetRideSummaryFlag = function() { rideSummaryEmitted = false; };

  // ---- Full Cleanup (only on intentional disconnect or failed reconnect) ----
  // msg: optional connect-status text (callers that pass nothing keep the old copy)
  // opts.disconnectHR: tear the heart-rate strap down too. Only the three paths
  // that mean "this session is over by choice" pass it — the DISCONNECT control,
  // the banner's END WORKOUT, and a page teardown. The done/asleep paths leave
  // the strap connected so the next ride needs no re-pair, and stopWorkout()
  // never comes through here at all: ending a coached workout leaves the rider
  // on the bike with both the equipment and the strap still streaming.
  function fullDisconnectCleanup(msg, opts) {
    reconnecting = false;
    reconnectGen++;            // any reconnect loop still running dies at its next check
    clearHardFailTimer();
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
    ignoreDisconnects = true;  // the session is closed; a late GATT event must not re-run this
    // The workout's samples are still in memory but the dashboard (and its EXPORT)
    // is gone — offer the summary + export on the connect screen instead
    var cardShown = !!(window.showLastRideCard && showLastRideCard());
    // An update that arrived mid-ride was deferred to here (ride_complete already
    // beaconed). A reload would wipe the samples behind the card, so while it's
    // showing the update waits for the next CONNECT tap. Otherwise the connect
    // screen is back — a good moment to look for one.
    if (opts && opts.disconnectHR && PS.hr && PS.hr.equipmentTeardown) PS.hr.equipmentTeardown();
    var reloading = !cardShown && !!(window.PSApplyPendingUpdate && PSApplyPendingUpdate());
    if (!reloading && window.PSCheckForUpdate) PSCheckForUpdate();
    if (!reloading && window.PSCheckVersion) PSCheckVersion();
  }

  // ---- Voluntary Disconnect (user-initiated) ----
  window.disconnectBike = function() {
    intentionalDisconnect = true;
    reconnecting = false;
    if (s.bleDevice && s.bleDevice.gatt.connected) {
      s.bleDevice.gatt.disconnect();
    } else {
      // Already disconnected (maybe during reconnect attempts), just clean up
      fullDisconnectCleanup(null, { disconnectHR: true });
    }
  };

  // ---- BLE Data Parsing ----
  // Packet health tracking
  var packetStats = { total: 0, good: 0, badChecksum: 0, unknown: 0, echo: 0, lastPacketTime: 0, gaps: 0,
                      framesReassembled: 0, framesAbandoned: 0, unknownTypes: {}, echoTypes: {} };
  var PACKET_GAP_THRESHOLD = 3; // seconds — flag if no packets for this long
  var lastHealthLog = 0;
  var unknownLogged = 0;          // per-connection cap on "Unknown packet" debug lines
  var unknownReported = {};       // per-connection: type -> true once unknown_packet was emitted
  var abandonLogged = false;      // per-connection: "Fragment abandoned" logged once

  // Per-connection reset. Counters used to survive across connections: a reconnect
  // 4.7h after a ride logged "Packet gap 17125s" and a health line carrying the
  // morning's 5403 packets.
  function resetPacketStats() {
    packetStats.total = 0; packetStats.good = 0; packetStats.badChecksum = 0; packetStats.unknown = 0;
    packetStats.echo = 0; packetStats.echoTypes = {};
    packetStats.gaps = 0; packetStats.framesReassembled = 0; packetStats.framesAbandoned = 0;
    packetStats.lastPacketTime = 0; packetStats.unknownTypes = {};
    lastHealthLog = 0;
    unknownLogged = 0; unknownReported = {}; abandonLogged = false;
    fragReset();
  }

  // ---- Multi-notification frames ----
  // Some frames arrive split across BLE notifications (rower D1: 21 bytes as
  // 10 + 11). A head is an F0 packet whose declared length (byte 2 + 4) exceeds
  // the notification; continuations don't start with F0. The checksum must be
  // verified on the reassembled frame, never on a fragment — verifying fragments
  // dropped every rower D1 (badCksum once a second, every rower stat stuck at 0).
  // E0 is excluded: byte 2 of a challenge is random data, not a length.
  var frag = { buf: null, expected: 0, got: 0, at: 0 };
  var FRAG_STALE_MS = 2000;

  function isFragmentHead(d) {
    return d[0] === 0xF0 && d.length >= 3 && d[1] !== 0xE0 && (d[2] + 4) > d.length;
  }
  function fragStart(d) {
    frag.expected = d[2] + 4;
    frag.buf = new Uint8Array(frag.expected);
    var n = Math.min(d.length, frag.expected);
    frag.buf.set(d.subarray(0, n));
    frag.got = n;
    frag.at = Date.now();
  }
  function fragAppend(d) {
    if (!frag.buf) return null;
    if (Date.now() - frag.at > FRAG_STALE_MS) { frag.buf = null; return null; }
    var n = Math.min(d.length, frag.expected - frag.got);
    frag.buf.set(d.subarray(0, n), frag.got);
    frag.got += n;
    if (frag.got >= frag.expected) { var f = frag.buf; frag.buf = null; return f; }
    return null;
  }
  function fragReset() { frag.buf = null; frag.got = 0; frag.expected = 0; }
  function fragAbandon() {
    packetStats.framesAbandoned++;
    if (!abandonLogged) {
      abandonLogged = true;
      debug('Fragment abandoned', { expected: frag.expected, got: frag.got });
    }
    frag.buf = null;
  }

  // Unknown packet types: keep the bytes and the channel (the log used to record
  // type/len only, so a first-ever 0x8b went by with its payload lost)
  function toHex(b) {
    var out = [];
    for (var i = 0; i < b.length; i++) out.push((b[i] < 16 ? '0' : '') + b[i].toString(16).toUpperCase());
    return out.join(' ');
  }
  function shortHandle(uuid) { return (uuid && uuid.length >= 8) ? uuid.substring(4, 8).toUpperCase() : '?'; }
  // With PS.ECHELON_FULL_INIT on, the equipment echoes our own init/keepalive
  // writes back on F3: an EX-5S sent 60 A0 echoes in an 81-second connection,
  // 42% of the stream. They are valid frames and not anomalies, so they get
  // their own bucket — otherwise they exhaust the 10-line log cap and the
  // 20-slot diag ring buffer, fire unknown_packet for nothing, and inflate the
  // denominator the checksum error rate is measured against.
  var ECHO_TYPES = { 0xA0: 1, 0xA1: 1, 0xA3: 1 };

  function noteUnknown(data, handle) {
    var type = '0x' + data[1].toString(16);
    if (ECHO_TYPES[data[1]]) {
      packetStats.echo++;
      packetStats.echoTypes[type] = (packetStats.echoTypes[type] || 0) + 1;
      return;
    }
    packetStats.unknown++;
    packetStats.unknownTypes[type] = (packetStats.unknownTypes[type] || 0) + 1;
    if (unknownLogged < 10) {
      unknownLogged++;
      debug('Unknown packet', { type: type, len: data.length, ch: handle, hex: toHex(data) });
    }
    if (!unknownReported[type]) {
      unknownReported[type] = true;
      if (window.__pulse) window.__pulse('unknown_packet', type + ':' + data.length + ':' + s.bikeModel);
    }
  }

  // Test handle (test/test_frames.js) — not used by the app
  PS._frames = {
    isFragmentHead: isFragmentHead, fragStart: fragStart, fragAppend: fragAppend, fragReset: fragReset,
    verifyChecksum: verifyChecksum, stats: packetStats, onBLEData: function(ev) { onBLEData(ev); },
    resetStats: resetPacketStats,
  };

  function verifyChecksum(data) {
    if (data.length < 3) return true; // too short to verify
    var sum = 0;
    for (var i = 0; i < data.length - 1; i++) sum += data[i];
    return (sum & 0xFF) === data[data.length - 1];
  }

  function onBLEData(event) {
    var data = new Uint8Array(event.target.value.buffer);
    if (data.length < 2) return;
    var handle = shortHandle(event.target && event.target.uuid);

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

    // Split frames: buffer the head, collect continuations, verify the whole frame
    if (isFragmentHead(data)) {
      if (frag.buf) fragAbandon();
      fragStart(data);
      return;
    }
    if (data[0] !== 0xF0) {
      var frame = fragAppend(data);
      if (!frame) return;   // partial, stale, or a stray continuation
      data = frame;
      packetStats.framesReassembled++;
    }

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
        // Echoes are ours coming back — they can't be corrupt, so they'd only
        // dilute the error rate. Measure it against the packets that can fail.
        var rated = packetStats.total - packetStats.echo;
        debug('Packet health', {
          total: packetStats.total,
          good: packetStats.good,
          badCksum: packetStats.badChecksum,
          unknown: packetStats.unknown,
          unknownTypes: packetStats.unknownTypes,
          echo: packetStats.echo,
          echoTypes: packetStats.echoTypes,
          frames_reassembled: packetStats.framesReassembled,
          frames_abandoned: packetStats.framesAbandoned,
          gaps: packetStats.gaps,
          errRate: (packetStats.badChecksum > 0 && rated > 0) ? Math.round(packetStats.badChecksum / rated * 100) + '%' : '0%'
        });
      }
    }

    // ---- ROWER ----
    if (s.equipmentType === 'rower') {
      if (!parseRowerPacket(data, now, dt) && data[0] === 0xF0 && data[1] !== 0xD0 && data[1] !== 0xD5) noteUnknown(data, handle);
      return;
    }

    // ---- TREADMILL ---- UNVERIFIED byte map
    if (s.equipmentType === 'treadmill') {
      if (!parseTreadmillPacket(data, now, dt) && data[0] === 0xF0 && data[1] !== 0xD0 && data[1] !== 0xD5) noteUnknown(data, handle);
      return;
    }

    // ---- BIKE ----
    if (data.length < 4) return;

    if (data[1] === 0xD1 && data.length >= 11) {
      s.cadence = (data[9] << 8) | data[10];

      // Revolution counter (bytes 7-8). Static for 60s+ while the rider is clearly
      // there (workout running, or the knob turned after it froze) = the speed
      // sensor isn't reporting — never counted, or froze mid-ride (Phoenix EX-5:
      // 138 revs, then 30 minutes of knob turns on a dead counter). updateBikeDisplay
      // turns that into the hint + no_cadence event, once per freeze; the counter
      // moving again clears the hint and re-arms it.
      var revs = (data[7] << 8) | data[8];
      if (s.revStaticSince === 0 || revs !== s.lastRevCount) {
        if (s.noCadenceFired) { s.noCadenceFired = false; hideNoCadenceHint(); }
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
      if (s.d2Count > 0 && newR !== s.lastD2Value) s.lastD2ChangeTime = now;
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
      noteUnknown(data, handle);
    }
  }

  // ---- Rower Packet Routing ----
  // Returns true when the packet was a known type. D1 arrives reassembled (21 bytes)
  // from the frame assembler in onBLEData.
  function parseRowerPacket(data, now, dt) {
    if (data[0] === 0xF0 && data[1] === 0xD1 && data.length >= 21) {
      parseRowerD1(data, now, dt);
      return true;
    }

    if (data[0] === 0xF0 && data[1] === 0xD2 && data.length >= 4) {
      s.resistance = data[3];
      return true;
    }

    if (data[0] === 0xF0 && data[1] === 0xD3 && data.length >= 4) {
      s.rowerPower = data[3];
      // Rower watts live here, not in the D1 that feeds powerSamples, so every
      // rower workout reported avg 0W and sent avg_power 0 to the adaptive coach.
      if (s.rowerPower > 0 && s.rowerPower < 1000) s.rowerPowerSamples.push(s.rowerPower);
      return true;
    }
    return false;
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
      return true;
    }

    if (data[0] === 0xF0 && data[1] === 0xD2 && data.length >= 4) {
      s.treadIncline = data[3];
      return true;
    }
    return false;
  }
})();