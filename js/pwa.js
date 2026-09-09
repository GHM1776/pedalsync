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

  // ---- Service Worker ----
  window.addEventListener('DOMContentLoaded', function() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function() {});
    }
  });

  // Expose install prompt state for connect screen
  PS.hasInstallPrompt = function() { return !!deferredInstallPrompt; };
})();