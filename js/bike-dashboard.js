// ============================================================
// PedalSync — Bike Dashboard Display
// ============================================================
window.updateBikeDisplay = function() {
  var s = PS.state;

  document.getElementById('val-cadence').textContent = s.cadence;
  document.getElementById('card-cadence').classList.toggle('active', s.cadence > 0);
  document.getElementById('val-power').textContent = Math.round(s.power);
  document.getElementById('card-power').classList.toggle('active', s.power > 0);
  document.getElementById('val-resistance').textContent = s.resistance;

  document.getElementById('val-time').textContent = PS.formatTime(s.rideElapsed);
  document.getElementById('val-distance').textContent = s.totalDistance.toFixed(1);
  document.getElementById('val-calories').textContent = Math.round(s.totalCalories);

  // "Bike reports no pedal motion": connected 60s+, D1 streaming with the
  // revolution counter stuck at 0 the whole time, and the rider clearly there
  // (workout running or resistance knob turned). Say so once per connection;
  // clear the hint the moment revs move. Demo mode never sets connectedAt.
  var hint = document.getElementById('no-cadence-hint');
  if (!hint) return;
  if (s.lastRevCount > 0 || s.cadence > 0) {
    hint.classList.add('hidden');
  } else if (!s.noCadenceFired && s.connectedAt > 0 && s.revStaticSince > 0) {
    var nowS = Date.now() / 1000;
    var sinceConnect = nowS - s.connectedAt;
    var interacting = s.workoutActive || s.d2ChangedSinceConnect;
    if (interacting && sinceConnect >= PS.NO_CADENCE_AFTER_S && (nowS - s.revStaticSince) >= PS.NO_CADENCE_AFTER_S) {
      s.noCadenceFired = true;
      hint.classList.remove('hidden');
      if (window.__pulse) window.__pulse('no_cadence', 'bike:' + s.bikeModel + ':' + Math.round(sinceConnect) + 's');
    }
  }
};