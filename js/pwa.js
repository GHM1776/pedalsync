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
  // for an update on CONNECT and when the tab returns after a long absence, and
  // when a new worker takes control, reload — immediately if not connected,
  // after the ride if connected. Never mid-ride.
  var swReg = null;
  var lastUpdateCheck = 0;
  var UPDATE_CHECK_MIN_MS = 30 * 60 * 1000;
  var hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  var reloading = false;
  var hiddenSince = 0;

  function isConnected() {
    return !!(s.bleDevice && s.bleDevice.gatt && s.bleDevice.gatt.connected);
  }

  function showUpdateBanner() {
    ['dashboard', 'rower-dashboard', 'treadmill-dashboard'].forEach(function(id) {
      var dash = document.getElementById(id);
      if (!dash) return;
      var el = dash.querySelector('.update-banner');
      if (!el) {
        el = document.createElement('div');
        el.className = 'update-banner';
        el.style.cssText = 'padding:8px 12px;margin-bottom:8px;background:rgba(242,169,0,0.08);' +
          'border-left:2px solid var(--gold-dim);font-size:0.8rem;color:var(--text);letter-spacing:0.04em;';
        dash.insertBefore(el, dash.firstChild);
      }
      el.textContent = 'Update ready — will apply after your ride';
    });
  }

  function reloadForUpdate() {
    if (reloading) return;
    reloading = true;
    if (window.__pulse) window.__pulse('sw_update', 'reloaded');   // keepalive beacon survives the reload
    location.reload();
  }

  // Ask the browser to re-fetch sw.js now. Resolves once it's reasonable to carry
  // on — CONNECT awaits this so a stale page reloads BEFORE the picker opens.
  // Throttled to one network check per 30 min unless force is set.
  window.PSCheckForUpdate = function(force) {
    if (!swReg) return Promise.resolve();
    var now = Date.now();
    if (!force && now - lastUpdateCheck < UPDATE_CHECK_MIN_MS) return Promise.resolve();
    lastUpdateCheck = now;
    var netCheck = Promise.race([
      swReg.update().catch(function() { /* offline or sw.js unreachable — carry on */ }),
      new Promise(function(r) { setTimeout(r, 1500); }),   // the no-update path never waits longer than this
    ]);
    return netCheck.then(function() {
      // A new worker is installing: give it a moment to activate — controllerchange
      // does the reload. If it takes longer, the picker just opens and the reload
      // lands when the worker does.
      if (swReg.installing || swReg.waiting) return new Promise(function(r) { setTimeout(r, 3000); });
    });
  };

  function onControllerChange() {
    if (!hadController) { hadController = true; return; }   // first install claiming this page — nothing to swap
    if (!isConnected()) { reloadForUpdate(); return; }
    s.updatePending = true;
    if (window.__pulse) window.__pulse('sw_update', 'deferred');
    showUpdateBanner();
  }

  // Called from fullDisconnectCleanup() in ble.js once the ride is over
  window.PSApplyPendingUpdate = function() {
    if (!s.updatePending) return;
    s.updatePending = false;
    reloadForUpdate();
  };

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') { hiddenSince = Date.now(); return; }
    if (document.visibilityState === 'visible' && hiddenSince && Date.now() - hiddenSince > UPDATE_CHECK_MIN_MS) {
      hiddenSince = 0;
      window.PSCheckForUpdate();
    }
  });

  window.addEventListener('DOMContentLoaded', function() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then(function(reg) { swReg = reg; }).catch(function() {});
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  });

  // Expose install prompt state for connect screen
  PS.hasInstallPrompt = function() { return !!deferredInstallPrompt; };
})();