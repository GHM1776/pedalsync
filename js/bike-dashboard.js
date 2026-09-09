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
};