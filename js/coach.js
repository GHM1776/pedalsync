// ============================================================
// PedalSync — AI Coach (Bike + Rower)
// ============================================================
(function() {
  var s = PS.state;

  // ---- DOM element mapping per equipment type ----
  function els() {
    if (s.equipmentType === 'rower') {
      return {
        setup:       document.getElementById('rower-coach-setup'),
        active:      document.getElementById('rower-coach-active'),
        text:        document.getElementById('rower-coach-text'),
        segment:     document.getElementById('rower-coach-segment'),
        segCount:    document.getElementById('rower-coach-seg-count'),
        targetR:     document.getElementById('rower-coach-target-r'),
        targetC:     document.getElementById('rower-coach-target-c'),
        targetRLbl:  document.getElementById('rower-coach-target-r-label'),
        targetCLbl:  document.getElementById('rower-coach-target-c-label'),
        progress:    document.getElementById('rower-workout-progress'),
        btnStart:    document.getElementById('rower-btn-start-workout'),
        duration:    document.getElementById('rower-workout-duration'),
      };
    }
    return {
      setup:       document.getElementById('coach-setup'),
      active:      document.getElementById('coach-active'),
      text:        document.getElementById('coach-text'),
      segment:     document.getElementById('coach-segment'),
      segCount:    document.getElementById('coach-seg-count'),
      targetR:     document.getElementById('coach-target-r'),
      targetC:     document.getElementById('coach-target-c'),
      targetRLbl:  document.getElementById('coach-target-r-label'),
      targetCLbl:  document.getElementById('coach-target-c-label'),
      progress:    document.getElementById('workout-progress'),
      btnStart:    document.getElementById('btn-start-workout'),
      duration:    document.getElementById('workout-duration'),
    };
  }

  // ---- Difficulty Selection ----
  window.pickDifficulty = function(d) {
    s.selectedDifficulty = d;
    document.querySelectorAll('.diff-btn').forEach(function(b) {
      b.classList.toggle('selected', b.dataset.diff === d);
    });
  };

  // ---- Start Workout ----
  window.startWorkout = async function() {
    var e = els();
    var duration = parseInt(e.duration.value);
    e.btnStart.disabled = true;

    showCoaching('Generating your workout plan...', '', 0);
    s.workoutActive = true;
    updateCoachUI();

    var isRower = s.equipmentType === 'rower';

    try {
      var resp = await fetch(PS.API_BASE + '/api/instructor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate_plan',
          difficulty: s.selectedDifficulty,
          duration: duration,
          equipment_type: s.equipmentType,
          beta_code: getUserId(),
        }),
      });

      if (!resp.ok) {
        var errText = '';
        try { errText = (await resp.json()).error || ''; } catch(_) {}
        if (window.__pulse) window.__pulse('debug', 'Coach plan failed: HTTP ' + resp.status + ' ' + errText);
        showCoaching(resp.status === 429 ? 'Rate limited — wait a moment and try again.' : 'Failed to generate plan. Try again.', '', 0);
        s.workoutActive = false;
        e.btnStart.disabled = false;
        updateCoachUI();
        return;
      }

      var data = await resp.json();

      if (!data.plan || !data.plan.length) {
        if (window.__pulse) window.__pulse('debug', 'Coach plan empty or invalid');
        showCoaching('Failed to generate plan. Try again.', '', 0);
        s.workoutActive = false;
        e.btnStart.disabled = false;
        updateCoachUI();
        return;
      }

      s.workoutPlan = data.plan;
      s.workoutId = data.workout_id || '';
      s.currentSegIdx = 0;
      s.segStartTime = Date.now() / 1000;
      s.workoutStartTime = Date.now() / 1000;
      s.lastAdaptiveCall = Date.now() / 1000;
      s.powerSamples = [];
      s.cadenceSamples = [];
      s.spmSamples = [];

      if (window.__pulse) window.__pulse('workout_start', s.equipmentType + ':' + s.selectedDifficulty + ':' + duration + 'min');

      var seg = s.workoutPlan[0];
      if (isRower) {
        showCoaching(seg.coaching_text, seg.name, 0,
          seg.target_resistance_min + '-' + seg.target_resistance_max,
          seg.target_spm_min + '-' + seg.target_spm_max,
          0, s.workoutPlan.length);
      } else {
        showCoaching(seg.coaching_text, seg.name, 0,
          seg.target_resistance_min + '-' + seg.target_resistance_max,
          seg.target_cadence_min + '-' + seg.target_cadence_max,
          0, s.workoutPlan.length);
      }

    } catch(err) {
      if (window.__pulse) window.__pulse('debug', 'Coach plan network error: ' + (err.message || 'unknown'));
      showCoaching('Network error. Check connection.', '', 0);
      s.workoutActive = false;
      e.btnStart.disabled = false;
      updateCoachUI();
    }
  };

  // ---- Stop Workout ----
  window.stopWorkout = function() {
    // Guard against duplicate calls (race between timer and button)
    if (!s.workoutActive) return;
    s.workoutActive = false;
    var elapsed = Date.now() / 1000 - s.workoutStartTime;
    var avgP = s.powerSamples.length
      ? Math.round(s.powerSamples.reduce(function(a, b) { return a + b; }, 0) / s.powerSamples.length)
      : 0;
    showCoaching('Workout complete! ' + Math.round(elapsed / 60) + ' min, avg ' + avgP + 'W. Great work.', 'DONE', 100);
    if (window.__pulse) window.__pulse('workout_end', Math.round(elapsed / 60) + 'min:' + avgP + 'W');
    var e = els();
    e.btnStart.disabled = false;
    setTimeout(function() { updateCoachUI(); }, 5000);
  };

  // ---- Check Progress (called from main update loop) ----
  window.checkCoachProgress = function() {
    if (!s.workoutActive || !s.workoutPlan.length) return;

    var now = Date.now() / 1000;
    var seg = s.workoutPlan[s.currentSegIdx];
    var segElapsed = now - s.segStartTime;
    var isRower = s.equipmentType === 'rower';

    // Safety net: if total elapsed exceeds plan duration + 60s buffer, force stop
    var totalPlanDur = s.workoutPlan.reduce(function(a, x) { return a + x.duration_sec; }, 0);
    var totalElapsed = now - s.workoutStartTime;
    if (totalElapsed > totalPlanDur + 60) {
      if (window.__pulse) window.__pulse('debug', 'Workout safety stop: elapsed ' + Math.round(totalElapsed) + 's > plan ' + totalPlanDur + 's');
      stopWorkout();
      return;
    }

    if (segElapsed >= seg.duration_sec) {
      s.currentSegIdx++;
      s.segStartTime = now;

      if (s.currentSegIdx >= s.workoutPlan.length) {
        stopWorkout();
        return;
      }

      var newSeg = s.workoutPlan[s.currentSegIdx];
      var totalDur = s.workoutPlan.reduce(function(a, x) { return a + x.duration_sec; }, 0);
      var progress = Math.min(100, Math.round(((now - s.workoutStartTime) / totalDur) * 100));

      if (isRower) {
        showCoaching(newSeg.coaching_text, newSeg.name, progress,
          newSeg.target_resistance_min + '-' + newSeg.target_resistance_max,
          newSeg.target_spm_min + '-' + newSeg.target_spm_max,
          s.currentSegIdx, s.workoutPlan.length);
      } else {
        showCoaching(newSeg.coaching_text, newSeg.name, progress,
          newSeg.target_resistance_min + '-' + newSeg.target_resistance_max,
          newSeg.target_cadence_min + '-' + newSeg.target_cadence_max,
          s.currentSegIdx, s.workoutPlan.length);
      }
    }

    // Adaptive coaching every ~70 sec
    if (now - s.lastAdaptiveCall >= 70) {
      s.lastAdaptiveCall = now;
      fetchAdaptiveCoaching();
    }
  };

  // ---- Adaptive Coaching ----
  async function fetchAdaptiveCoaching() {
    if (!s.workoutActive || s.currentSegIdx >= s.workoutPlan.length) return;

    var seg = s.workoutPlan[s.currentSegIdx];
    var elapsed = Date.now() / 1000 - s.workoutStartTime;
    var totalDur = s.workoutPlan.reduce(function(a, x) { return a + x.duration_sec; }, 0);
    var isRower = s.equipmentType === 'rower';

    var body;
    if (isRower) {
      var recentPower = s.powerSamples.slice(-60);
      var recentSPM = s.spmSamples.slice(-60);
      body = {
        action: 'adaptive',
        equipment_type: 'rower',
        workout_id: s.workoutId,
        difficulty: s.selectedDifficulty,
        segment_name: seg.name,
        target_r: seg.target_resistance_min + '-' + seg.target_resistance_max,
        target_spm: seg.target_spm_min + '-' + seg.target_spm_max,
        actual_resistance: s.resistance,
        actual_spm: s.rowerSPM,
        actual_power: s.rowerPower,
        actual_split: s.rowerSplitSec,
        elapsed_min: Math.round(elapsed / 60),
        remaining_min: Math.round((totalDur - elapsed) / 60),
        avg_power: recentPower.length ? Math.round(recentPower.reduce(function(a, b) { return a + b; }, 0) / recentPower.length) : 0,
        avg_spm: recentSPM.length ? Math.round(recentSPM.reduce(function(a, b) { return a + b; }, 0) / recentSPM.length) : 0,
        beta_code: getUserId(),
      };
    } else {
      var recentP = s.powerSamples.slice(-60);
      var recentCad = s.cadenceSamples.slice(-60);
      body = {
        action: 'adaptive',
        equipment_type: 'bike',
        workout_id: s.workoutId,
        difficulty: s.selectedDifficulty,
        segment_name: seg.name,
        target_r: seg.target_resistance_min + '-' + seg.target_resistance_max,
        target_c: seg.target_cadence_min + '-' + seg.target_cadence_max,
        actual_resistance: s.resistance,
        actual_cadence: s.cadence,
        actual_power: Math.round(s.power),
        elapsed_min: Math.round(elapsed / 60),
        remaining_min: Math.round((totalDur - elapsed) / 60),
        avg_power: recentP.length ? Math.round(recentP.reduce(function(a, b) { return a + b; }, 0) / recentP.length) : 0,
        avg_cadence: recentCad.length ? Math.round(recentCad.reduce(function(a, b) { return a + b; }, 0) / recentCad.length) : 0,
        beta_code: getUserId(),
      };
    }

    try {
      var resp = await fetch(PS.API_BASE + '/api/instructor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (data.coaching) {
        var e = els();
        e.text.textContent = data.coaching;
      }
    } catch(err) {
      if (window.__pulse) window.__pulse('debug', 'Coach adaptive error: ' + (err.message || 'unknown'));
      console.error('Adaptive coaching error:', err);
    }
  }

  // ---- Show Coaching (updates correct dashboard) ----
  function showCoaching(text, segment, progress, targetR, targetC, segIdx, totalSegs) {
    var e = els();
    if (e.text) e.text.textContent = text;
    if (e.segment) e.segment.textContent = segment || '—';
    if (e.progress) e.progress.style.width = (progress || 0) + '%';
    if (targetR && e.targetR) e.targetR.textContent = targetR;
    if (targetC && e.targetC) e.targetC.textContent = targetC;
    if (segIdx !== undefined && totalSegs && e.segCount) {
      e.segCount.textContent = (segIdx + 1) + ' / ' + totalSegs;
    }
  }
  window.showCoaching = showCoaching;

  // ---- Toggle Setup / Active UI ----
  window.updateCoachUI = function() {
    var e = els();
    if (s.workoutActive) {
      if (e.setup) e.setup.classList.add('hidden');
      if (e.active) e.active.classList.add('visible');
    } else {
      if (e.setup) e.setup.classList.remove('hidden');
      if (e.active) e.active.classList.remove('visible');
    }
  };
})();