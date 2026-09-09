// ============================================================
// PedalSync — Rower Dashboard Display
// ============================================================
window.updateRowerDisplay = function() {
  var s = PS.state;

  document.getElementById('val-spm').textContent = s.rowerSPM;
  document.getElementById('card-spm').classList.toggle('active', s.rowerSPM > 0);
  document.getElementById('val-split').textContent = PS.formatSplit(s.rowerSplitSec);
  document.getElementById('card-split').classList.toggle('active', s.rowerSPM > 0);
  document.getElementById('val-rower-power').textContent = s.rowerPower;
  document.getElementById('card-rower-power').classList.toggle('active', s.rowerPower > 0);
  document.getElementById('val-rower-resistance').textContent = s.resistance;
  document.getElementById('val-rower-distance').textContent = s.rowerDistance;
  document.getElementById('val-strokes').textContent = s.rowerStrokes;
  document.getElementById('val-rower-calories').textContent = s.rowerCalories;

  document.getElementById('val-rower-time').textContent = PS.formatTime(s.rideElapsed);

  // Averages
  if (s.rowerSPMSamples.length > 0) {
    document.getElementById('val-avg-spm').textContent =
      Math.round(s.rowerSPMSamples.reduce(function(a, b) { return a + b; }, 0) / s.rowerSPMSamples.length);
  }
  if (s.rowerSplitSamples.length > 0) {
    var avgSplit = Math.round(s.rowerSplitSamples.reduce(function(a, b) { return a + b; }, 0) / s.rowerSplitSamples.length);
    document.getElementById('val-avg-split').textContent = PS.formatSplit(avgSplit);
  }
};