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

  // "Bike reports no pedal motion": connected 60s+ and the D1 revolution counter
  // static for 60s+ — never counted, or froze mid-ride — while the rider is
  // clearly there: a workout is running, or the resistance knob was turned AFTER
  // the counter froze. A rest with nothing touched is not a fault. Say so once
  // per freeze (ble.js re-arms when the counter moves); any cadence hides it.
  // Demo mode never sets connectedAt.
  var hint = document.getElementById('no-cadence-hint');
  if (!hint) return;
  if (s.cadence > 0) {
    hint.classList.add('hidden');
  } else if (!s.noCadenceFired && s.connectedAt > 0 && s.revStaticSince > 0) {
    var nowS = Date.now() / 1000;
    var staticS = nowS - s.revStaticSince;
    var interacting = s.workoutActive || s.lastD2ChangeTime > s.revStaticSince;
    if (interacting && nowS - s.connectedAt >= PS.NO_CADENCE_AFTER_S && staticS >= PS.NO_CADENCE_AFTER_S) {
      s.noCadenceFired = true;
      hint.classList.remove('hidden');
      // never:<model>:<n>s = the counter never left 0; mid:<model>:<revs>:<n>s = froze after counting
      var value = s.lastRevCount === 0
        ? 'never:' + s.bikeModel + ':' + Math.round(staticS) + 's'
        : 'mid:' + s.bikeModel + ':' + s.lastRevCount + ':' + Math.round(staticS) + 's';
      if (window.__pulse) window.__pulse('no_cadence', value);
    }
  }
};