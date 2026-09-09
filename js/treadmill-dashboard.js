// ============================================================
// PedalSync — Treadmill Dashboard Display
// UNVERIFIED — byte map estimated, awaiting hardware test
// ============================================================
window.updateTreadmillDisplay = function() {
  var s = PS.state;

  // Speed (mph)
  document.getElementById('val-tread-speed').textContent = s.treadSpeed.toFixed(1);
  document.getElementById('card-tread-speed').classList.toggle('active', s.treadSpeed > 0);

  // Pace (min/mile)
  document.getElementById('val-tread-pace').textContent = PS.formatPace(s.treadSpeed);
  document.getElementById('card-tread-pace').classList.toggle('active', s.treadSpeed > 0);

  // Incline
  document.getElementById('val-tread-incline').textContent = s.treadIncline;

  // Time
  document.getElementById('val-tread-time').textContent = PS.formatTime(s.rideElapsed);

  // Distance (miles, computed from speed)
  document.getElementById('val-tread-distance').textContent = s.totalDistance.toFixed(2);

  // Calories
  document.getElementById('val-tread-calories').textContent = Math.round(s.totalCalories);

  // Averages
  if (s.treadSpeedSamples.length > 0) {
    var avgSpeed = s.treadSpeedSamples.reduce(function(a, b) { return a + b; }, 0) / s.treadSpeedSamples.length;
    document.getElementById('val-tread-avg-speed').textContent = avgSpeed.toFixed(1);
    document.getElementById('val-tread-avg-pace').textContent = PS.formatPace(avgSpeed);
  }
};