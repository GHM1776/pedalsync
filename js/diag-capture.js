// ============================================================
// PedalSync — BLE Diagnostic Capture
// ============================================================
// Records the full BLE session lifecycle so a failure can be classified as
// bike-side, Echelon-server-side, or app-side without the user telling us
// anything. Loaded before ble.js; exposes window.PSDiag.
//
// Wired into ble.js at these points:
//   PSDiag.begin(name)                after requestDevice() / on reconnect leg
//   PSDiag.phase(...)                 gatt_connected, f4_subscribed, f3_subscribed,
//                                     model_detected, not_locked, unlock_window_timeout
//   PSDiag.packet(uuid, bytes)        from the dedicated diagTap listener on F3+F4
//                                     (covers the unlock window where no app
//                                     listener is attached)
//   PSDiag.unlockRequest / unlockResponse / unlockError   around POST /api/unlock
//   PSDiag.write('key' | 'cmd_enable', bytes, ok, err)    around writeValue
//   PSDiag.disconnected('user'|'gatt') from gattserverdisconnected
//   PSDiag.unlockBody()               spread into the /api/unlock POST body so a
//                                     Vercel "[unlock]" log line can be joined to
//                                     this Pulse session
//
// Emit sink: sends directly to the Pulse collector (pulse.intrepidend.com/e)
// using the same session id as s.js (sessionStorage '__p'), with structured
// data in the x= param — window.__pulse only forwards (event, value) and would
// drop the payload. Large packet dumps are split into <event>_pkts chunks
// because the payload travels in a GET query string.
// Override with PSDiag.init({ emit: (event, message, data) => ... }).

(function () {
  'use strict';

  var FIRST_KEEP = 150;     // first N packets kept verbatim (the handshake lives here)
  var RING_KEEP = 100;      // most recent N packets kept after that
  var HEAD_PKTS = 30;       // packets from the start attached to emitted events
  var TAIL_PKTS = 40;       // packets from the end attached to emitted events
  var WATCHDOG_MS = [10000, 30000];  // no_telemetry checks at these offsets after cmd_enable

  var PULSE_URL = 'https://pulse.intrepidend.com/e';
  var PULSE_SITE = 'pedalsync';
  var MAX_X_CHARS = 6000;   // JSON payload size before packet chunking kicks in
  var PKT_CHUNK = 16;       // packets per <event>_pkts chunk

  var emitFn = null;
  var st = null;
  var memSid = null;        // fallback if sessionStorage is unavailable

  // ---------- Pulse sink ----------

  function sid() {
    try {
      var id = sessionStorage.getItem('__p');
      if (!id) {
        // Same format as s.js — it reuses whatever is already stored
        id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        sessionStorage.setItem('__p', id);
      }
      return id;
    } catch (e) {
      if (!memSid) memSid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      return memSid;
    }
  }

  function pulseSend(event, message, data) {
    var url = PULSE_URL
      + '?s=' + encodeURIComponent(PULSE_SITE)
      + '&p=' + encodeURIComponent(location.pathname + (location.hash || ''))
      + '&i=' + encodeURIComponent(sid())
      + '&e=' + encodeURIComponent(event);
    if (message != null) url += '&v=' + encodeURIComponent(String(message).substring(0, 400));
    if (data != null) {
      try { url += '&x=' + encodeURIComponent(JSON.stringify(data)); } catch (e) { /* skip */ }
    }
    try {
      fetch(url, { keepalive: true, mode: 'no-cors' }).catch(function () {});
    } catch (e) {
      try { navigator.sendBeacon(url); } catch (e2) { /* give up quietly */ }
    }
  }

  function defaultEmit(event, message, data) {
    if (!data) { pulseSend(event, message, data); return; }
    var json = '';
    try { json = JSON.stringify(data); } catch (e) { pulseSend(event, message, { err: 'unserializable' }); return; }
    var pkts = data.packets;
    if (json.length <= MAX_X_CHARS || !pkts || !pkts.length) {
      pulseSend(event, message, data);
      return;
    }
    // Too big for one beacon: send the snapshot without packets, then the
    // packets in numbered chunks under <event>_pkts.
    var head = {};
    for (var k in data) { if (k !== 'packets') head[k] = data[k]; }
    head.packets_sent_separately = pkts.length;
    try {
      // Last-resort guard: never let one beacon URL grow past what servers accept
      if (JSON.stringify(head).length > MAX_X_CHARS) {
        head = {
          truncated: true,
          session: data.session, device: data.device, phase: data.phase,
          elapsed_s: data.elapsed_s, total_pkts: data.total_pkts,
          counts: data.counts, e0: data.e0, unlock: data.unlock,
          verdict: data.verdict, reason: data.reason,
          packets_sent_separately: pkts.length,
        };
      }
    } catch (e) { /* keep full head */ }
    pulseSend(event, message, head);
    var total = Math.ceil(pkts.length / PKT_CHUNK);
    for (var i = 0; i < total; i++) {
      pulseSend(event + '_pkts', event + ' packets ' + (i + 1) + '/' + total, {
        seq: i + 1, of: total,
        packets: pkts.slice(i * PKT_CHUNK, (i + 1) * PKT_CHUNK),
      });
    }
  }

  function emit(event, message, data) {
    var fn = emitFn || defaultEmit;
    try { fn(event, message, data); } catch (e) { /* never let diagnostics break the app */ }
  }

  // ---------- utils ----------

  function hex(bytes) {
    return Array.from(bytes || []).map(function (b) {
      return b.toString(16).padStart(2, '0').toUpperCase();
    }).join(' ');
  }

  function cksumOk(b) {
    if (!b || b.length < 2) return false;
    var s = 0;
    for (var i = 0; i < b.length - 1; i++) s += b[i];
    return (s & 0xFF) === b[b.length - 1];
  }

  function shortHandle(uuid) {
    if (!uuid || typeof uuid !== 'string') return '?';
    return uuid.substring(4, 8).toUpperCase();
  }

  function classify(b) {
    if (!b || b.length < 2) return 'short';
    if (b[0] !== 0xF0) return 'cont';            // continuation fragment (rower D1 second half, or garbage)
    switch (b[1]) {
      case 0xE0: return 'E0';
      case 0xD0: return 'D0';
      case 0xD1: return 'D1';
      case 0xD2: return 'D2';
      case 0xD3: return 'D3';
      case 0xD5: return 'D5';
      default: return 'F0_' + b[1].toString(16).padStart(2, '0').toUpperCase();
    }
  }

  function isTelemetry(type) {
    return type === 'D1' || type === 'D2' || type === 'D3';
  }

  function now() { return Date.now(); }
  function rel(t) { return st && st.t0 ? +((t - st.t0) / 1000).toFixed(3) : 0; }

  // ---------- state ----------

  function fresh(deviceName) {
    return {
      t0: now(),
      device: deviceName || '',
      phase: 'requested',
      phases: [],                  // [{phase, t, extra}]
      firstPkts: [],
      ringPkts: [],
      total: 0,
      counts: {},                  // type -> count
      byHandle: {},                // handle -> count
      badCksum: 0,
      e0: { count: 0, firstAt: null, lastAt: null, afterKey: 0, afterEnable: 0, unique: {} },
      unlock: null,                // {challenge, sentAt, ms, ok, status, key, framed, serverDiag, error}
      writes: [],                  // [{label, hex, t, ok, err}]
      keyWrittenAt: null,
      enableAt: null,
      firstTelemetryAt: null,
      firstTelemetryType: null,
      lastPkt: null,
      ended: false,
      timers: [],
    };
  }

  function clearTimers() {
    if (!st) return;
    st.timers.forEach(function (t) { clearTimeout(t); });
    st.timers = [];
  }

  // ---------- verdict ----------
  //
  // Where did it break?
  //   bike        — device never spoke, or dropped us cold
  //   echelon     — their unlock API failed / returned junk
  //   app_server  — our /api/unlock errored (500) or timed out
  //   handshake   — key was written and the bike kept challenging (rejected) or went silent
  //   app         — our client logic never did its part
  //   ok          — telemetry flowing

  function verdict() {
    if (!st) return { side: 'unknown', code: 'no_session' };
    if (st.firstTelemetryAt) return { side: 'ok', code: 'telemetry' };

    var u = st.unlock;
    var sawE0 = st.e0.count > 0;

    if (!sawE0 && st.total === 0) {
      return { side: 'bike', code: 'silent_device', why: 'no packets at all after subscribe' };
    }
    if (!sawE0 && st.total > 0) {
      return { side: 'bike', code: 'unknown_traffic', why: 'packets but no E0 and no telemetry', types: st.counts };
    }
    if (sawE0 && !u) {
      return { side: 'app', code: 'no_unlock_attempt', why: 'E0 seen but /api/unlock never called' };
    }
    if (u && u.error) {
      var s = u.status || 0;
      if (s === 502) return { side: 'echelon', code: 'echelon_bad_response', why: u.error, status: s };
      if (s === 500 || s === 0) return { side: 'app_server', code: 'unlock_proxy_error', why: u.error, status: s };
      return { side: 'app_server', code: 'unlock_http_' + s, why: u.error, status: s };
    }
    if (u && u.ok && !st.keyWrittenAt) {
      return { side: 'app', code: 'key_not_written', why: 'unlock ok but writeValue never happened/failed' };
    }
    if (st.keyWrittenAt && st.e0.afterKey > 0) {
      return {
        side: 'handshake', code: 'key_rejected',
        why: 'bike kept sending E0 after key write',
        e0_after_key: st.e0.afterKey,
        e0_unique: Object.keys(st.e0.unique).length,
      };
    }
    if (st.enableAt && st.e0.afterEnable === 0) {
      return { side: 'handshake', code: 'silent_after_enable', why: 'no E0, no telemetry after CMD_ENABLE' };
    }
    if (st.keyWrittenAt && !st.enableAt) {
      return { side: 'app', code: 'enable_not_sent', why: 'key written, CMD_ENABLE never sent' };
    }
    return { side: 'unknown', code: 'inconclusive' };
  }

  // ---------- snapshot ----------

  function snapshot(withPackets) {
    if (!st) return null;
    var t = now();
    var snap = {
      session: PSDiag.sessionId,
      device: st.device,
      phase: st.phase,
      elapsed_s: rel(t),
      total_pkts: st.total,
      counts: st.counts,
      by_handle: st.byHandle,
      bad_cksum: st.badCksum,
      e0: {
        count: st.e0.count,
        first_s: st.e0.firstAt != null ? rel(st.e0.firstAt) : null,
        last_s: st.e0.lastAt != null ? rel(st.e0.lastAt) : null,
        after_key: st.e0.afterKey,
        after_enable: st.e0.afterEnable,
        // A rotating challenge can produce hundreds of uniques — cap the sample
        unique_count: Object.keys(st.e0.unique).length,
        unique: Object.keys(st.e0.unique).slice(0, 12),
      },
      unlock: st.unlock ? {
        challenge: st.unlock.challenge,
        ms: st.unlock.ms,
        ok: st.unlock.ok,
        status: st.unlock.status,
        key: st.unlock.key,
        framed: st.unlock.framed,
        error: st.unlock.error || null,
        server: st.unlock.serverDiag || null,
      } : null,
      writes: st.writes,
      key_written_s: st.keyWrittenAt != null ? rel(st.keyWrittenAt) : null,
      enable_s: st.enableAt != null ? rel(st.enableAt) : null,
      first_telemetry_s: st.firstTelemetryAt != null ? rel(st.firstTelemetryAt) : null,
      first_telemetry_type: st.firstTelemetryType,
      last_pkt: st.lastPkt,
      phases: st.phases,
      verdict: verdict(),
    };
    if (withPackets) {
      // First HEAD_PKTS always (that's where E0 / first D1 live) + the most
      // recent TAIL_PKTS, with a gap marker when packets were omitted between.
      var all = st.firstPkts.concat(st.ringPkts);
      if (all.length <= HEAD_PKTS + TAIL_PKTS) {
        snap.packets = all;
      } else {
        snap.packets = all.slice(0, HEAD_PKTS)
          .concat([{ gap: all.length - HEAD_PKTS - TAIL_PKTS }])
          .concat(all.slice(-TAIL_PKTS));
      }
    }
    return snap;
  }

  // ---------- watchdog ----------

  function armWatchdog() {
    clearTimers();
    WATCHDOG_MS.forEach(function (ms) {
      var t = setTimeout(function () {
        if (!st || st.ended || st.firstTelemetryAt) return;
        var snap = snapshot(true);
        emit('no_telemetry', 'No telemetry ' + (ms / 1000) + 's after CMD_ENABLE — ' + snap.verdict.side + ':' + snap.verdict.code, snap);
      }, ms);
      st.timers.push(t);
    });
  }

  // ---------- public API ----------

  var PSDiag = {
    sessionId: '',

    init(opts) {
      if (opts && typeof opts.emit === 'function') emitFn = opts.emit;
    },

    begin(deviceName) {
      clearTimers();
      st = fresh(deviceName);
      st.phases.push({ phase: 'requested', t: 0 });
      emit('diag_begin', 'Diag capture started | ' + (deviceName || '?'), { device: deviceName || '', session: PSDiag.sessionId });
    },

    phase(name, extra) {
      if (!st) return;
      st.phase = name;
      st.phases.push({ phase: name, t: rel(now()), extra: extra || undefined });
    },

    // Called for EVERY notification via the diagTap listener on F3 and F4.
    packet(uuid, bytes) {
      if (!st || st.ended) return;
      var t = now();
      var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      var type = classify(b);
      var handle = shortHandle(uuid);
      var ok = b[0] === 0xF0 ? cksumOk(b) : null;

      var rec = { t: rel(t), h: handle, type: type, len: b.length, hex: hex(b), ck: ok };

      st.total++;
      st.counts[type] = (st.counts[type] || 0) + 1;
      st.byHandle[handle] = (st.byHandle[handle] || 0) + 1;
      if (ok === false) st.badCksum++;
      st.lastPkt = rec;

      if (st.firstPkts.length < FIRST_KEEP) st.firstPkts.push(rec);
      else { st.ringPkts.push(rec); if (st.ringPkts.length > RING_KEEP) st.ringPkts.shift(); }

      if (type === 'E0') {
        st.e0.count++;
        if (st.e0.firstAt == null) st.e0.firstAt = t;
        st.e0.lastAt = t;
        st.e0.unique[rec.hex] = (st.e0.unique[rec.hex] || 0) + 1;
        if (st.keyWrittenAt != null) st.e0.afterKey++;
        if (st.enableAt != null) st.e0.afterEnable++;

        // A NEW challenge after we wrote a key is the clearest "rejected" signal there is
        if (st.keyWrittenAt != null && st.e0.afterKey === 1) {
          emit('e0_after_key', 'Bike re-challenged after key write | ' + rec.hex, snapshot(false));
        }
      }

      if (isTelemetry(type) && st.firstTelemetryAt == null) {
        st.firstTelemetryAt = t;
        st.firstTelemetryType = type;
        clearTimers();
        emit('first_telemetry', 'First ' + type + ' at +' + rel(t) + 's', {
          type: type,
          since_connect_s: rel(t),
          since_enable_s: st.enableAt != null ? +((t - st.enableAt) / 1000).toFixed(3) : null,
          since_key_s: st.keyWrittenAt != null ? +((t - st.keyWrittenAt) / 1000).toFixed(3) : null,
          e0_count: st.e0.count,
          hex: rec.hex,
        });
      }
    },

    unlockRequest(challengeBytes) {
      if (!st) return;
      var b = challengeBytes instanceof Uint8Array ? challengeBytes : new Uint8Array(challengeBytes);
      st.unlock = {
        challenge: hex(b),
        challenge_cksum_ok: cksumOk(b),
        sentAt: now(),
        ms: null, ok: false, status: null,
        key: null, framed: null, serverDiag: null, error: null,
      };
      st.phase = 'unlock_requested';
      st.phases.push({ phase: 'unlock_requested', t: rel(st.unlock.sentAt) });
    },

    // json = parsed body of /api/unlock; status = HTTP status
    unlockResponse(json, status) {
      if (!st || !st.unlock) return;
      var u = st.unlock;
      u.ms = now() - u.sentAt;
      u.status = status;
      u.serverDiag = json && json.diag ? json.diag : null;
      if (json && json.key) {
        u.ok = true;
        try {
          var kb = Uint8Array.from(atob(json.key), function (c) { return c.charCodeAt(0); });
          u.key = hex(kb);
          u.key_len = kb.length;
        } catch (e) { u.key = '(undecodable)'; }
      } else {
        u.error = (json && json.error) || ('HTTP ' + status);
      }
      st.phase = u.ok ? 'unlock_ok' : 'unlock_failed';
      st.phases.push({ phase: st.phase, t: rel(now()) });
      emit(u.ok ? 'unlock_response' : 'unlock_failed',
        u.ok ? 'Unlock key received in ' + u.ms + 'ms | ' + u.key : 'Unlock failed (' + status + ') | ' + u.error,
        { challenge: u.challenge, key: u.key, ms: u.ms, status: status, server: u.serverDiag, error: u.error });
    },

    unlockError(err, status) {
      if (!st) return;
      if (st.unlock && st.unlock.ok) {
        // The unlock itself succeeded — this is a failure after the key came
        // back (e.g. the GATT write threw, already recorded by write()).
        emit('post_unlock_error', 'Error after unlock response | ' + ((err && err.message) || String(err)), snapshot(false));
        return;
      }
      if (!st.unlock) st.unlock = { challenge: null, sentAt: now() };
      var u = st.unlock;
      u.ms = now() - u.sentAt;
      u.ok = false;
      u.status = status || 0;
      u.error = (err && err.message) || String(err);
      st.phase = 'unlock_failed';
      st.phases.push({ phase: 'unlock_failed', t: rel(now()) });
      emit('unlock_failed', 'Unlock request threw | ' + u.error, { challenge: u.challenge, ms: u.ms, status: u.status, error: u.error });
    },

    // label: 'key' | 'cmd_enable' | anything else
    write(label, bytes, ok, err) {
      if (!st) return;
      var t = now();
      var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      var rec = { label: label, hex: hex(b), t: rel(t), ok: !!ok, err: err ? ((err.message) || String(err)) : null };
      st.writes.push(rec);
      if (label === 'key') {
        if (ok) st.keyWrittenAt = t;
        if (st.unlock) st.unlock.framed = rec.hex;
        st.e0.afterKey = 0;
      }
      if (label === 'cmd_enable') {
        if (ok) { st.enableAt = t; st.e0.afterEnable = 0; armWatchdog(); }
      }
      if (!ok) emit('write_failed', 'Write ' + label + ' failed | ' + rec.err, rec);
    },

    disconnected(reason) {
      if (!st || st.ended) return;
      st.ended = true;
      clearTimers();
      var t = now();
      var snap = snapshot(true);
      snap.reason = reason || 'gatt';
      snap.since_key_s = st.keyWrittenAt != null ? +((t - st.keyWrittenAt) / 1000).toFixed(1) : null;
      snap.since_enable_s = st.enableAt != null ? +((t - st.enableAt) / 1000).toFixed(1) : null;
      snap.since_last_pkt_s = st.lastPkt ? +(rel(t) - st.lastPkt.t).toFixed(1) : null;
      var v = snap.verdict;
      emit('ble_disconnect',
        'Disconnected (' + snap.reason + ') after ' + snap.elapsed_s + 's, ' + st.total + ' pkts — ' + v.side + ':' + v.code,
        snap);
    },

    // Body fields to spread into the /api/unlock POST — lets a Vercel
    // "[unlock]" log line be joined to this Pulse session.
    unlockBody() {
      if (!PSDiag.sessionId) PSDiag.sessionId = sid();
      return { session: PSDiag.sessionId, device: st ? st.device : '' };
    },

    // For a future "report a problem" button — attaches the whole picture to the user's note
    report(note) {
      var snap = snapshot(true) || {};
      snap.note = String(note || '').substring(0, 500);
      emit('user_report', 'User report | ' + snap.note.substring(0, 80), snap);
      return snap;
    },

    snapshot: snapshot,
    verdict: verdict,

    // Dev helper: PSDiag.dump() in devtools
    dump() {
      var s = snapshot(true);
      if (!s) { console.log('PSDiag: no session'); return; }
      console.log('PSDiag verdict:', s.verdict);
      console.log('PSDiag summary:', s);
      if (console.table && s.packets) console.table(s.packets.slice(0, 30));
    },
  };

  PSDiag.sessionId = sid();
  window.PSDiag = PSDiag;
})();
