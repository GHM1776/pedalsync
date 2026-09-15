// ============================================================
// PedalSync — AI Coach (Bike + Rower)
// ============================================================
(function() {
  var s = PS.state;
  var planAbort = null;      // AbortController of the in-flight plan request
  var planCancelled = false; // set when the connection ended mid-request

  // ble.js and app.js each keep their own private averager; this module needs one too
  function avgOf(arr) {
    if (!arr || !arr.length) return 0;
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += arr[i];
    return t / arr.length;
  }

  // Heart rate for the adaptive call. Filtered by TIMESTAMP, not sample count:
  // straps notify at different rates, so slice(-60) is a two-minute window on a
  // 2s notifier and thirty seconds on a fast one. Unweighted mean of the
  // notifications in the window — close enough while real straps report
  // steadily; per-second bucketing is the clean fix if it ever matters.
  function hrFields() {
    var now = PS.hr && PS.hr.current ? PS.hr.current() : 0;
    var cutoff = Date.now() / 1000 - 60;
    var sum = 0, n = 0;
    for (var i = s.hrSamples.length - 1; i >= 0; i--) {
      if (s.hrSamples[i].ts < cutoff) break;
      sum += s.hrSamples[i].bpm; n++;
    }
    return { actual_hr: now || null, avg_hr: n ? Math.round(sum / n) : null };
  }

  // Called from fullDisconnectCleanup(): a plan response landing after the BLE
  // link is gone must not start a workout on the connect screen.
  window.abortPendingPlan = function() {
    if (!s.planPending) return;
    planCancelled = true;
    s.planPending = false;
    s.workoutActive = false;
    if (planAbort) { try { planAbort.abort(); } catch(e) {} planAbort = null; }
    var e = els();
    if (e.btnStart) e.btnStart.disabled = false;
    updateCoachUI();
  };

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
    if (s.planPending) return;
    var e = els();
    var duration = parseInt(e.duration.value);
    var isRower = s.equipmentType === 'rower';

    // Not a workout until the plan arrives. Setting workoutActive here used to let
    // checkCoachProgress (200ms loop) see the PREVIOUS plan + start time, trip the
    // safety stop, emit a bogus workout_end and re-enable START mid-fetch.
    s.planPending = true;
    planCancelled = false;
    s.workoutActive = false;
    s.workoutPlan = [];
    s.workoutStartTime = 0;
    s.workoutEndedAt = 0;
    e.btnStart.disabled = true;
    showCoaching('Generating your workout plan...', '', 0);
    updateCoachUI();

    var ctl = new AbortController();
    planAbort = ctl;
    var timer = setTimeout(function() { ctl.abort(); }, PS.PLAN_TIMEOUT_MS);
    // Long plans (45 min) take a while — reassure at 15s instead of looking hung
    var slowNote = setTimeout(function() {
      if (s.planPending && planAbort === ctl) showCoaching('Still generating — longer plans take a moment.', '', 0);
    }, 15000);

    function finishRequest() {
      clearTimeout(timer);
      clearTimeout(slowNote);
      if (planAbort === ctl) planAbort = null;
    }

    // Every failure path goes through here so the UI reset can't drift.
    // reason: timeout | http_<status> | empty | network
    function abortPlan(msg, reason) {
      finishRequest();
      s.planPending = false;
      s.workoutActive = false;
      if (window.__pulse) window.__pulse('plan_error', reason + ':' + s.equipmentType + ':' + s.selectedDifficulty + ':' + duration + 'min');
      showCoaching(msg, '', 0);
      e.btnStart.disabled = false;
      updateCoachUI();
    }

    try {
      var resp = await fetch(PS.API_BASE + '/api/instructor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          action: 'generate_plan',
          difficulty: s.selectedDifficulty,
          duration: duration,
          equipment_type: s.equipmentType,
          beta_code: getUserId(),
        }),
      });

      // Connection ended while we waited — abortPendingPlan already reset the UI
      if (planCancelled) { planCancelled = false; finishRequest(); return; }

      if (!resp.ok) {
        abortPlan(resp.status === 429 ? 'Rate limited — wait a moment and try again.' : 'Failed to generate plan. Try again.',
                  'http_' + resp.status);
        return;
      }

      var data = await resp.json();
      if (planCancelled) { planCancelled = false; finishRequest(); return; }

      if (!data.plan || !data.plan.length) {
        abortPlan('Failed to generate plan. Try again.', 'empty');
        return;
      }

      finishRequest();
      s.workoutPlan = data.plan;
      s.workoutId = data.workout_id || '';
      s.currentSegIdx = 0;
      s.segStartTime = Date.now() / 1000;
      s.workoutStartTime = Date.now() / 1000;
      s.lastAdaptiveCall = Date.now() / 1000;
      s.powerSamples = [];
      s.cadenceSamples = [];
      s.spmSamples = [];
      s.rowerPowerSamples = [];
      s.treadSpeedSamples = [];
      s.workoutActive = true;
      s.planPending = false;

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
      if (planCancelled) { planCancelled = false; finishRequest(); return; }
      if (err.name === 'AbortError') {
        abortPlan('Plan request timed out. Check your connection and try again.', 'timeout');
      } else {
        abortPlan('Network error. Check connection.', 'network');
      }
    }
  };

  // ---- Stop Workout ----
  window.stopWorkout = function() {
    // Guard against duplicate calls (race between timer and button)
    if (!s.workoutActive && !s.planPending) return;
    // END while the plan is still generating just cancels the request — there is
    // nothing to summarize, and START must not come back while a fetch is in flight
    if (s.planPending) { window.abortPendingPlan(); return; }
    s.workoutActive = false;
    s.workoutEndedAt = Date.now() / 1000;
    var elapsed = Date.now() / 1000 - s.workoutStartTime;
    // Each equipment type keeps its effort in a different array, and a treadmill
    // has no power at all — reporting 0W there was misleading rather than missing.
    var avg;
    if (s.equipmentType === 'treadmill') {
      avg = (Math.round(avgOf(s.treadSpeedSamples) * 10) / 10) + 'mph';
    } else {
      var src = s.equipmentType === 'rower' ? s.rowerPowerSamples : s.powerSamples;
      avg = Math.round(avgOf(src)) + 'W';
    }
    showCoaching('Workout complete! ' + Math.round(elapsed / 60) + ' min, avg ' + avg + '. Great work.', 'DONE', 100);
    if (window.__pulse) window.__pulse('workout_end', Math.round(elapsed / 60) + 'min:' + avg);
    var e = els();
    e.btnStart.disabled = false;
    setTimeout(function() { updateCoachUI(); }, 5000);
  };

  // ---- Check Progress (called from main update loop) ----
  window.checkCoachProgress = function() {
    if (!s.workoutActive || s.planPending || !s.workoutPlan.length) return;

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
  async function fetchAdaptiveCoaching(isRetry) {
    if (!s.workoutActive || s.currentSegIdx >= s.workoutPlan.length) return;

    var seg = s.workoutPlan[s.currentSegIdx];
    var elapsed = Date.now() / 1000 - s.workoutStartTime;
    var totalDur = s.workoutPlan.reduce(function(a, x) { return a + x.duration_sec; }, 0);
    var isRower = s.equipmentType === 'rower';

    var body;
    if (isRower) {
      var recentPower = s.rowerPowerSamples.slice(-60);   // bike powerSamples is never filled on a rower
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
      var hrR = hrFields();
      body.actual_hr = hrR.actual_hr;
      body.avg_hr = hrR.avg_hr;
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
      var hrB = hrFields();
      body.actual_hr = hrB.actual_hr;
      body.avg_hr = hrB.avg_hr;
    }

    var ctl = new AbortController();
    var timer = setTimeout(function() { ctl.abort(); }, PS.PLAN_TIMEOUT_MS);
    try {
      var resp = await fetch(PS.API_BASE + '/api/instructor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify(body),
      });
      clearTimeout(timer);
      var data = await resp.json();
      if (data.coaching && s.workoutActive) {
        var e = els();
        e.text.textContent = data.coaching;
      }
    } catch(err) {
      clearTimeout(timer);
      var reason = err.name === 'AbortError' ? 'timeout' : 'network';
      // Phones hop networks mid-ride and lose one call — retry a network blip once.
      // Adaptive cues are non-fatal either way: the UI just keeps the last cue.
      if (reason === 'network' && !isRetry && s.workoutActive) {
        setTimeout(function() { fetchAdaptiveCoaching(true); }, 3000);
        return;
      }
      if (window.__pulse) window.__pulse('coach_error', 'adaptive:' + reason);
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
    if (s.workoutActive || s.planPending) {
      if (e.setup) e.setup.classList.add('hidden');
      if (e.active) e.active.classList.add('visible');
    } else {
      if (e.setup) e.setup.classList.remove('hidden');
      if (e.active) e.active.classList.remove('visible');
    }
  };
})();