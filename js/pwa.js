// ============================================================
// PedalSync — PWA, Install, Support Banner & Ride Tracking
// ============================================================
(function() {
  var s = PS.state;

  // ---- PWA Install Prompt ----
  var deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    var btn = document.getElementById('btn-install');
    if (btn) btn.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', function() {
    deferredInstallPrompt = null;
    var btn = document.getElementById('btn-install');
    if (btn) btn.classList.add('hidden');
    var note = document.getElementById('install-note');
    if (note) note.textContent = 'App installed! Launch PedalSync from your home screen.';
  });

  window.installApp = function() {
    if (!deferredInstallPrompt) {
      var note = document.getElementById('install-note');
      if (note) note.innerHTML = 'Tap the browser menu (⋮) and select<br>"Add to Home Screen" to install.';
      return;
    }
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(function(choice) {
      if (choice.outcome === 'accepted') {
        var btn = document.getElementById('btn-install');
        if (btn) btn.classList.add('hidden');
      }
      deferredInstallPrompt = null;
    });
  };

  // Hide install UI if already running as PWA
  if (window.matchMedia('(display-mode: standalone)').matches) {
    document.addEventListener('DOMContentLoaded', function() {
      var btn = document.getElementById('btn-install');
      if (btn) btn.classList.add('hidden');
      var note = document.getElementById('install-note');
      if (note) note.classList.add('hidden');
      var div = document.querySelector('.connect-divider');
      if (div) div.style.display = 'none';
    });
  }

  // ---- User ID (rate limiting) ----
  window.getUserId = function() {
    var uid = localStorage.getItem('ps_uid');
    if (!uid) {
      uid = 'U-' + Math.random().toString(36).substring(2, 10).toUpperCase();
      localStorage.setItem('ps_uid', uid);
    }
    return uid;
  };

  // ---- Ride Count ----
  window.getRideCount = function() {
    return parseInt(localStorage.getItem('ps_rides') || '0', 10);
  };

  window.incrementRideCount = function() {
    var count = getRideCount() + 1;
    localStorage.setItem('ps_rides', String(count));
    return count;
  };

  // ---- Support Banner ----
  // Shows after 3 completed rides, dismissible forever
  var BANNER_RIDE_THRESHOLD = 3;

  window.maybeShowSupportBanner = function() {
    if (localStorage.getItem('ps_banner_dismissed') === '1') return;
    if (getRideCount() < BANNER_RIDE_THRESHOLD) return;

    var bike = document.getElementById('bike-support-banner');
    var rower = document.getElementById('rower-support-banner');
    var tread = document.getElementById('tread-support-banner');
    if (bike) bike.classList.remove('hidden');
    if (rower) rower.classList.remove('hidden');
    if (tread) tread.classList.remove('hidden');
  };

  window.dismissBanner = function() {
    localStorage.setItem('ps_banner_dismissed', '1');
    var bike = document.getElementById('bike-support-banner');
    var rower = document.getElementById('rower-support-banner');
    var tread = document.getElementById('tread-support-banner');
    if (bike) bike.classList.add('hidden');
    if (rower) rower.classList.add('hidden');
    if (tread) tread.classList.add('hidden');
  };

  // ---- Coach Tip UI (no-op now, kept for compatibility) ----
  window.updateCoachTipUI = function() {};
  window.markTipped = function() {};
  window.isTipped = function() { return true; };
  window.showDonationBanner = function() {};

  // ---- Ride Completion Tracking ----
  // A ride counts as complete when activity persists for 2+ continuous minutes
  window.checkRideCompletion = function() {
    if (s.rideTracked) return;
    var isActive = s.equipmentType === 'rower' ? s.rowerSPM > 0 : s.cadence > 0;
    if (isActive) {
      if (s.rideCadenceStart === 0) s.rideCadenceStart = Date.now() / 1000;
      if (Date.now() / 1000 - s.rideCadenceStart >= 120) {
        s.rideTracked = true;
        incrementRideCount();
        // Check if we should now show the banner
        maybeShowSupportBanner();
      }
    } else {
      s.rideCadenceStart = 0;
    }
  };

  // ---- Service Worker + update pickup ----
  // The SW is cache-first with background refresh, and the browser only re-checks
  // sw.js on navigation or every 24h — so a tab left open (or an installed PWA)
  // can run yesterday's JS through today's ride. A rower reconnected 25 minutes
  // after the rower fix deployed and was still on the broken build. So: check
  // for an update when the connect screen is shown and when the tab returns
  // after a long absence, and when a new worker takes control, reload —
  // immediately if idle, after the ride if connected or mid-connect. Never
  // mid-ride. NOT on the CONNECT tap itself: the Bluetooth picker needs
  // transient user activation, which Chrome expires ~5s after the tap, so
  // nothing may await between the tap and requestDevice().
  var swReg = null;
  var lastUpdateCheck = 0;
  var UPDATE_CHECK_MIN_MS = 30 * 60 * 1000;
  var hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  var reloading = false;
  var hiddenSince = 0;

  function isConnected() {
    return !!(s.bleDevice && s.bleDevice.gatt && s.bleDevice.gatt.connected);
  }

  // Reloading now would destroy something the rider can't get back. One
  // definition, used by every path that might reload: the controller swap, the
  // version poller's answer to the service worker, and the worker's own probe.
  function pageBusy() {
    if (isConnected()) return true;                                    // mid-workout
    if (PS.connectInFlight && PS.connectInFlight()) return true;       // picker open or setupGATT running
    if (PS.lastRideShowing && PS.lastRideShowing()) return true;       // finished workout still un-exported
    return false;
  }

  function reloadForUpdate() {
    if (reloading) return;
    // Loop guard: if this build already reloaded itself once in this tab and is
    // still the one running, something upstream is wrong — don't spin.
    // PS.BUILD tracks sw.js CACHE_NAME, so a real update always changes it.
    var build = PS.BUILD || '';
    var last = '';
    try { last = sessionStorage.getItem('ps_reloaded') || ''; } catch(e) { /* private mode */ }
    if (build && last === build) {
      if (window.__pulse) window.__pulse('sw_update', 'loop_guard');
      return;
    }
    try { sessionStorage.setItem('ps_reloaded', build); } catch(e) { /* private mode */ }
    reloading = true;
    if (window.__pulse) window.__pulse('sw_update', 'reloaded');   // keepalive beacon survives the reload
    location.reload();
  }

  // Ask the browser to re-fetch sw.js now. Fire-and-forget: nobody awaits it —
  // controllerchange does the reload when a new worker lands. Throttled to one
  // network check per 30 min unless force is set.
  window.PSCheckForUpdate = function(force) {
    if (!swReg) return Promise.resolve();
    var now = Date.now();
    if (!force && now - lastUpdateCheck < UPDATE_CHECK_MIN_MS) return Promise.resolve();
    lastUpdateCheck = now;
    return swReg.update().catch(function() { /* offline or sw.js unreachable — carry on */ });
  };

  function onControllerChange() {
    if (!hadController) { hadController = true; return; }   // first install claiming this page — nothing to swap
    if (!pageBusy()) { reloadForUpdate(); return; }
    // Mid-ride a reload would kill the BLE session and the in-memory ride
    // samples — fullDisconnectCleanup() applies it once the ride is over.
    s.updatePending = true;
    if (window.__pulse) window.__pulse('sw_update', 'deferred');
  }

  // ---- Deployed-build poller ----
  // swReg.update() only re-fetches sw.js when the browser feels like it, and for
  // a page that never navigates that is the ~24h periodic check. A tab opened
  // Sep 11 was still running pre-rower-fix code three days later: the code that
  // picks up a deploy shipped *inside* the deploy it never received. /api/version
  // costs a few bytes and removes that dependency entirely.
  var lastVersionCheck = 0;
  var versionTimer = null;

  // Builds are 'v<n>'. Test builds append a tag ('v20-t1'), so compare the number
  // and fall back to string inequality — never treat a LOWER number as an update.
  function buildNum(b) { var m = /^v(\d+)/.exec(b || ''); return m ? parseInt(m[1], 10) : -1; }

  window.PSCheckVersion = function(force) {
    var now = Date.now();
    if (!force && now - lastVersionCheck < UPDATE_CHECK_MIN_MS) return Promise.resolve();
    lastVersionCheck = now;
    return fetch(PS.API_BASE + '/api/version', { cache: 'no-store' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        // A missing route or env value must never start a reload
        if (!d || !d.build || d.build === 'unknown') return;
        if (d.build === PS.BUILD) return;
        if (buildNum(d.build) < buildNum(PS.BUILD)) return;   // endpoint is behind this page — don't go backwards
        if (window.__pulse) window.__pulse('sw_update', 'version_mismatch:' + PS.BUILD + '>' + d.build);
        // Deliberately NOT reloading here. This page's cache still holds the old
        // assets, so a reload would serve them again, the loop guard would see
        // its own build and pin the page on it for good. Forcing the worker
        // update installs the new cache first; its controllerchange then does the
        // reload — or defers it to the end of the workout — with the guards above.
        if (window.PSCheckForUpdate) PSCheckForUpdate(true);
      })
      .catch(function() { /* offline is not an error */ });
  };

  function startVersionPoll() {
    if (versionTimer) return;
    versionTimer = setInterval(function() { window.PSCheckVersion(); }, PS.VERSION_POLL_MS);
  }
  function stopVersionPoll() {
    if (versionTimer) { clearInterval(versionTimer); versionTimer = null; }
  }

  // The worker pings controlled pages to take a census (sw.js). Answering is what
  // marks this page as one that can pick up a deploy on its own — pages older
  // than the update-pickup code have no listener here, so silence is how the
  // worker counts them.
  function onSWMessage(event) {
    var d = event.data;
    if (!d || d.ps !== 'ping') return;
    var port = event.ports && event.ports[0];
    if (!port) return;
    try { port.postMessage({ ps: 'pong', build: PS.BUILD, busy: pageBusy() }); } catch (e) { /* port closed */ }
  }

  // Called from ble.js once the page is idle again (end of a ride, or a connect
  // attempt that ended without a connection). Returns true if a reload was started.
  window.PSApplyPendingUpdate = function() {
    if (!s.updatePending) return false;
    s.updatePending = false;
    reloadForUpdate();
    return reloading;
  };

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') { hiddenSince = Date.now(); stopVersionPoll(); return; }
    if (document.visibilityState !== 'visible') return;
    startVersionPoll();   // no point polling a background tab: it reloads on return anyway
    if (hiddenSince && Date.now() - hiddenSince > UPDATE_CHECK_MIN_MS) {
      hiddenSince = 0;
      window.PSCheckForUpdate();
      window.PSCheckVersion();
    }
  });

  window.addEventListener('DOMContentLoaded', function() {
    if (document.visibilityState !== 'hidden') startVersionPoll();
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then(function(reg) { swReg = reg; }).catch(function() {});
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    navigator.serviceWorker.addEventListener('message', onSWMessage);
  });

  // Expose install prompt state for connect screen
  PS.hasInstallPrompt = function() { return !!deferredInstallPrompt; };
})();