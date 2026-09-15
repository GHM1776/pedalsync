// ============================================================
// PedalSync — Heart Rate (standard Bluetooth Heart Rate Service)
// ============================================================
// An optional accessory on its own GATT connection. Nothing in here may be
// able to affect the equipment link: no shared reconnect state machine, no
// wake lock, no diag capture, no connectInFlight. Every failure is silent and
// non-blocking — a strap problem must never look like a bike problem.
//
// Works with any 0x180D peripheral: chest straps (Polar, Wahoo, Garmin,
// Coospo, Magene) and Garmin / Polar / Coros / Suunto watches in broadcast
// mode. Apple Watch cannot be used — watchOS does not expose heart rate over
// standard BLE to third parties. Never imply otherwise anywhere in the UI.
//
// Measurement characteristic 0x2A37 is variable length. Byte 0 is flags:
//   bit 0  0 = BPM is uint8 at byte 1, 1 = uint16 LE at bytes 1-2
//   bit 1  sensor contact detected
//   bit 2  sensor contact feature supported
//   bit 3  energy expended present (uint16 LE after the BPM field)
//   bit 4  RR intervals present (uint16 LE each, 1/1024 s, after energy)
// Only bytes 0-2 are read. Straps that send RR intervals produce longer
// payloads, which is why nothing here assumes a fixed length. RR is ignored
// for now — it would enable HRV later.
(function() {
  var s = PS.state;

  var HR_SERVICE = 'heart_rate';                  // 0x180D
  var HR_MEASUREMENT = 'heart_rate_measurement';  // 0x2A37
  var RETRY_DELAYS_MS = [5000, 15000];            // two tries, then leave the button to the rider
  var SANE_MIN = 30, SANE_MAX = 230;
  var MAX_SAMPLES = 20000;                        // ~5.5h at 1Hz; bounds memory without touching real rides

  var device = null;
  var char = null;
  var hrGen = 0;              // cancellation token, same idea as reconnectGen in ble.js
  var retryTimers = [];
  var connecting = false;
  var userOptedOut = false;   // the rider disconnected the strap themselves — don't silently re-attach

  function debug(msg, data) {
    if (data !== undefined) console.log('[PS:hr]', msg, data);
    else console.log('[PS:hr]', msg);
  }
  function each(sel, fn) {
    var list = document.querySelectorAll(sel);
    for (var i = 0; i < list.length; i++) fn(list[i]);
  }
  function beacon(v) { if (window.__pulse) window.__pulse('hr', v); }

  // ---- reading state ----
  // Cleared on every new connection and device switch. Leaving hrStale or
  // lastHrTime set across a reconnect would make a healthy new strap read stale.
  function clearReadings() {
    s.heartRate = 0;
    s.hrStale = false;
    s.lastHrTime = 0;
    s.hrSamples = [];
  }
  PS.hrClearReadings = clearReadings;   // resetRide() calls this

  function parseHR(dv) {
    if (!dv || dv.byteLength < 2) return null;
    var flags = dv.getUint8(0);
    var u16 = (flags & 0x01) !== 0;
    if (u16 && dv.byteLength < 3) return null;
    var bpm = u16 ? dv.getUint16(1, true) : dv.getUint8(1);
    var contactSupported = (flags & 0x04) !== 0;
    var contactDetected = (flags & 0x02) !== 0;
    return { bpm: bpm, stale: contactSupported && !contactDetected };
  }
  PS.hrParse = parseHR;   // test/test_hr.js

  function onMeasurement(event) {
    var r = parseHR(event.target.value);
    if (!r) return;
    // Contact lost: the strap keeps reporting its last value. Showing or
    // recording it is the difference between a plausible file and a flatline.
    if (r.stale) { s.hrStale = true; render(); return; }
    if (r.bpm < SANE_MIN || r.bpm > SANE_MAX) return;   // discarded silently
    s.hrStale = false;
    s.heartRate = r.bpm;
    s.lastHrTime = Date.now() / 1000;
    s.hrSamples.push({ bpm: r.bpm, ts: s.lastHrTime });
    if (s.hrSamples.length > MAX_SAMPLES) s.hrSamples.shift();
    render();
  }

  // ---- the only trustworthy read path ----
  // The tile, recordDataPoint() and the coach payload all go through this.
  // Reading s.heartRate directly is how a stale value leaks into one consumer
  // but not another — including the case that matters most, a strap whose
  // battery dies mid-ride: it stops notifying without disconnecting, so the
  // last value would otherwise be written into every remaining trackpoint.
  PS.hr = PS.hr || {};
  PS.hr.current = function() {
    if (!s.heartRate || s.hrStale) return 0;
    if (s.lastHrTime && (Date.now() / 1000 - s.lastHrTime) > PS.HR_STALE_AFTER_S) return 0;
    return s.heartRate;
  };
  PS.hr.isConnected = function() {
    return !!(device && device.gatt && device.gatt.connected && char);
  };

  // ---- UI ----
  // One renderer for every dashboard plus the connect screen: only one screen
  // is ever visible, and a shared render keeps the tiles from drifting apart.
  function render() {
    var connected = PS.hr.isConnected();
    if (connected && s.lastHrTime > 0 && (Date.now() / 1000 - s.lastHrTime) > PS.HR_STALE_AFTER_S) {
      s.heartRate = 0;   // notifications stopped without a disconnect (dead battery, out of range)
    }
    var bpm = PS.hr.current();
    each('.hr-bpm', function(el) { el.textContent = bpm > 0 ? String(bpm) : '—'; });
    each('.hr-device', function(el) {
      el.textContent = connected ? (s.hrDeviceName || 'Heart rate monitor')
                                 : 'Pair a Bluetooth heart rate strap, or a watch in broadcast mode.';
    });
    each('.hr-tile', function(el) {
      el.classList.toggle('active', bpm > 0);
      el.classList.toggle('stale', connected && bpm === 0);
    });
    each('.btn-hr', function(el) { el.textContent = connected ? '♥ HR ON' : '♥ CONNECT HR'; });
  }
  PS.hr.render = render;

  // ---- connection ----
  function clearRetries() {
    for (var i = 0; i < retryTimers.length; i++) clearTimeout(retryTimers[i]);
    retryTimers = [];
  }

  function detach() {
    if (char) {
      try { char.removeEventListener('characteristicvaluechanged', onMeasurement); } catch (e) { /* gone */ }
    }
    if (device) {
      try { device.removeEventListener('gattserverdisconnected', onDeviceDropped); } catch (e) { /* gone */ }
    }
    char = null;
    device = null;
    s.hrDeviceName = '';
    clearReadings();
  }

  async function attach(d, gen) {
    var server = await d.gatt.connect();
    if (gen !== hrGen) { try { d.gatt.disconnect(); } catch (e) {} return false; }
    var service = await server.getPrimaryService(HR_SERVICE);
    var c = await service.getCharacteristic(HR_MEASUREMENT);
    await c.startNotifications();
    if (gen !== hrGen) { try { d.gatt.disconnect(); } catch (e) {} return false; }

    // A different strap than last time: drop the old readings, don't blend them
    if (device && device !== d) detach();
    clearReadings();
    device = d;
    char = c;
    s.hrDeviceName = d.name || 'Heart rate monitor';
    c.addEventListener('characteristicvaluechanged', onMeasurement);
    d.addEventListener('gattserverdisconnected', onDeviceDropped);
    try { if (d.id) localStorage.setItem('ps_hr_device', d.id); } catch (e) { /* private mode */ }
    debug('connected', s.hrDeviceName);
    beacon('connected');
    render();
    return true;
  }

  function onDeviceDropped() {
    var gen = hrGen;
    s.heartRate = 0;
    s.hrStale = false;
    char = null;
    debug('dropped');
    beacon('dropped');
    render();
    // Two tries, no ladder, no banner, nothing touching the equipment link.
    // Each retry checks the generation it was scheduled under, so a strap the
    // rider has since disconnected — or swapped — is never resurrected.
    var d = device;
    for (var i = 0; i < RETRY_DELAYS_MS.length; i++) {
      (function(delay) {
        retryTimers.push(setTimeout(function() {
          if (gen !== hrGen || !d || PS.hr.isConnected()) return;
          attach(d, gen).catch(function() { /* still gone — the button is there */ });
        }, delay));
      })(RETRY_DELAYS_MS[i]);
    }
  }

  // Picker flow — requires a user gesture, so it is only ever called from a tap
  PS.hr.connect = async function() {
    if (connecting || PS.hr.isConnected()) return;
    if (!navigator.bluetooth) return;
    connecting = true;
    userOptedOut = false;
    var gen = ++hrGen;
    clearRetries();
    try {
      var d = await navigator.bluetooth.requestDevice({ filters: [{ services: [HR_SERVICE] }] });
      if (gen !== hrGen) { try { d.gatt.disconnect(); } catch (e) {} return; }
      await attach(d, gen);
    } catch (err) {
      // Cancelled picker, no device, refused connection — all the same to us
      debug('connect failed', (err && err.message) || String(err));
      beacon('connect_failed');
      render();
    } finally {
      connecting = false;
    }
  };

  // Rider-initiated teardown: don't silently re-attach afterwards
  PS.hr.disconnect = function() {
    userOptedOut = true;
    teardown();
    beacon('user_disconnected');
  };

  // Equipment teardown (DISCONNECT, the banner's END WORKOUT, page teardown).
  // NOT the dashboard END WORKOUT — that ends a coached session and leaves the
  // rider on the bike with the equipment still streaming.
  PS.hr.equipmentTeardown = function() {
    if (!PS.hr.isConnected() && !connecting && !retryTimers.length) return;
    teardown();
  };

  function teardown() {
    hrGen++;
    clearRetries();
    connecting = false;
    var d = device;
    detach();
    if (d && d.gatt && d.gatt.connected) { try { d.gatt.disconnect(); } catch (e) { /* already gone */ } }
    render();
  }

  // Silent re-attach on a later page load. Called only once equipment telemetry
  // is already flowing — never alongside the equipment connect, because two
  // GATT connection attempts in flight is exactly what budget Android BLE
  // stacks handle worst.
  PS.hr.autoReconnect = function() {
    if (userOptedOut || connecting || PS.hr.isConnected()) return;
    if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;   // varies by Chrome build
    var id = null;
    try { id = localStorage.getItem('ps_hr_device'); } catch (e) { /* private mode */ }
    if (!id) return;
    var gen = ++hrGen;
    navigator.bluetooth.getDevices().then(function(list) {
      var found = null;
      for (var i = 0; list && i < list.length; i++) { if (list[i].id === id) { found = list[i]; break; } }
      if (!found || gen !== hrGen) return null;
      return attach(found, gen);
    }).catch(function() { /* not in range, or the permission is gone */ });
  };

  PS.hr.toggle = function() {
    if (PS.hr.isConnected()) PS.hr.disconnect();
    else PS.hr.connect();
  };
  window.toggleHR = function() { PS.hr.toggle(); };

  window.addEventListener('pagehide', function() { teardown(); });
  window.addEventListener('DOMContentLoaded', function() { render(); });
})();
