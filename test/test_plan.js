// Plan normalizer — run from the repo root:  node test/test_plan.js
//
// The AI returns segments in seconds and drifts off the requested total: four
// 20-minute requests came back as 24, 23, 21 and 20 minutes, because the
// sanitizer clamped each segment to 10-600s and never checked the sum. These
// pin the correction, including the cases where scaling alone cannot work
// (six segments cannot hold 90 minutes at a 600s cap).
//
// Node prints a one-line MODULE_TYPELESS_PACKAGE_JSON notice loading the ESM
// module from this CommonJS package. Harmless.
const { normalizePlan, planTotal, SEG_MIN_SEC, SEG_MAX_SEC } = require('../api/_plan.js');

let fail = 0;
const check = (n, c, d) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) { fail++; if (d !== undefined) console.log('   ' + JSON.stringify(d)); } };

const bikeSeg = (duration_sec, rMin, rMax) => ({
  name: 'Segment', duration_sec,
  target_resistance_min: rMin === undefined ? 8 : rMin,
  target_resistance_max: rMax === undefined ? 14 : rMax,
  target_cadence_min: 70, target_cadence_max: 95,
  coaching_text: 'Go',
});
const rowerSeg = (duration_sec) => ({
  name: 'Segment', duration_sec,
  target_resistance_min: 3, target_resistance_max: 6,
  target_spm_min: 22, target_spm_max: 28, coaching_text: 'Row',
});
const durations = (p) => p.map((x) => x.duration_sec);
const inBounds = (p) => p.every((x) => x.duration_sec >= SEG_MIN_SEC && x.duration_sec <= SEG_MAX_SEC);

// ---- 1. a plan that already lasts the requested time is left alone ----
let plan = [bikeSeg(300), bikeSeg(600), bikeSeg(300)];
let out = normalizePlan(plan, 20, 'bike');
check('exact plan passes through untouched', planTotal(out) === 1200 && JSON.stringify(durations(out)) === '[300,600,300]', durations(out));

// ---- 2. the real failure: 20 minutes requested, 24 delivered ----
out = normalizePlan([bikeSeg(300), bikeSeg(540), bikeSeg(420), bikeSeg(180)], 20, 'bike');
check('overrun (1440s) scaled to exactly 1200s', planTotal(out) === 1200, { total: planTotal(out), durations: durations(out) });
check('overrun stays within the 10-600s per-segment bounds', inBounds(out), durations(out));
check('overrun keeps its segment count', out.length === 4);

// ---- 3. underrun scales up ----
out = normalizePlan([bikeSeg(200), bikeSeg(400), bikeSeg(300)], 20, 'bike');
check('underrun (900s) scaled to exactly 1200s', planTotal(out) === 1200, { total: planTotal(out), durations: durations(out) });

// ---- 4. 45 and 90 minute requests ----
out = normalizePlan([bikeSeg(300), bikeSeg(600), bikeSeg(600), bikeSeg(400), bikeSeg(300), bikeSeg(200)], 45, 'bike');
check('45 minutes lands on exactly 2700s', planTotal(out) === 2700, { total: planTotal(out), durations: durations(out) });
check('45-minute plan respects the per-segment cap', inBounds(out), durations(out));

// Six segments cannot hold 90 minutes at 600s each — scaling alone is impossible
out = normalizePlan([bikeSeg(300), bikeSeg(300), bikeSeg(300), bikeSeg(300), bikeSeg(300), bikeSeg(300)], 90, 'bike');
check('90 minutes with too few segments still sums to exactly 5400s', planTotal(out) === 5400, { total: planTotal(out), n: out.length });
check('...by adding segments rather than breaking the cap', out.length >= 9 && inBounds(out), { n: out.length, durations: durations(out) });
check('...and the added segments keep the equipment shape (cadence, not spm)',
  out.every((x) => typeof x.target_cadence_min === 'number' && x.target_spm_min === undefined), out[out.length - 1]);

// ---- 5. rounding residue avoids warmup and cool down ----
// 7 segments of 101s = 707 -> 1200: scale 1.697..., every segment rounds and the
// leftovers must not land on the ends.
out = normalizePlan([bikeSeg(101), bikeSeg(101), bikeSeg(101), bikeSeg(101), bikeSeg(101), bikeSeg(101), bikeSeg(101)], 20, 'bike');
check('residue plan sums exactly', planTotal(out) === 1200, { total: planTotal(out), durations: durations(out) });
const ends = [out[0].duration_sec, out[out.length - 1].duration_sec];
const mids = out.slice(1, -1).map((x) => x.duration_sec);
check('leftover seconds went to a middle segment, not the ends',
  Math.max(...mids) >= Math.max(...ends), { ends, mids });

// ---- 6. degenerate input must not divide by zero or return nothing ----
out = normalizePlan([], 20, 'bike');
check('empty plan becomes a usable 1200s plan', planTotal(out) === 1200 && out.length >= 1 && inBounds(out), { n: out.length, durations: durations(out) });
check('empty bike plan carries bike targets', typeof out[0].target_cadence_min === 'number' && typeof out[0].coaching_text === 'string', out[0]);
out = normalizePlan([], 20, 'rower');
check('empty rower plan carries rower targets', typeof out[0].target_spm_min === 'number' && out[0].target_cadence_min === undefined, out[0]);
out = normalizePlan([bikeSeg(0), bikeSeg(0)], 10, 'bike');
check('all-zero durations become exactly 600s', planTotal(out) === 600 && inBounds(out), durations(out));
out = normalizePlan([{ name: 'x' }, { name: 'y' }], 10, 'bike');
check('missing duration_sec handled', planTotal(out) === 600 && inBounds(out), durations(out));
out = normalizePlan(null, 5, 'bike');
check('a null plan still returns 300s of segments', planTotal(out) === 300 && out.length >= 1, durations(out));

// ---- 7. structural repair ----
out = normalizePlan([
  { ...bikeSeg(400), target_resistance_min: 20, target_resistance_max: 8 },
  { ...bikeSeg(400), target_cadence_min: 110, target_cadence_max: 70 },
  bikeSeg(400),
], 20, 'bike');
check('inverted resistance min/max swapped', out[0].target_resistance_min <= out[0].target_resistance_max, [out[0].target_resistance_min, out[0].target_resistance_max]);
check('inverted cadence min/max swapped', out[1].target_cadence_min <= out[1].target_cadence_max, [out[1].target_cadence_min, out[1].target_cadence_max]);
out = normalizePlan([rowerSeg(400), { ...rowerSeg(400), target_spm_min: 34, target_spm_max: 20 }, rowerSeg(400)], 20, 'rower');
check('inverted spm min/max swapped', out[1].target_spm_min <= out[1].target_spm_max, [out[1].target_spm_min, out[1].target_spm_max]);

// ---- 8. warmup and cool down should not be the hardest part ----
out = normalizePlan([bikeSeg(400, 18, 24), bikeSeg(400, 6, 12), bikeSeg(400, 16, 22)], 20, 'bike');
check('a hard first segment is eased to the plan\'s lowest resistance floor', out[0].target_resistance_min === 6, out[0]);
check('a hard last segment is eased too', out[2].target_resistance_min === 6, out[2]);
check('easing never leaves max below min', out.every((x) => x.target_resistance_max >= x.target_resistance_min), out.map((x) => [x.target_resistance_min, x.target_resistance_max]));
out = normalizePlan([bikeSeg(400, 5, 9), bikeSeg(400, 14, 20), bikeSeg(400, 5, 8)], 20, 'bike');
check('a plan already shaped with easy ends is not reshaped',
  out[0].target_resistance_min === 5 && out[1].target_resistance_min === 14 && out[2].target_resistance_min === 5,
  out.map((x) => x.target_resistance_min));

// ---- 9. the input is not mutated (the caller logs the pre-normalization sum) ----
const original = [bikeSeg(300), bikeSeg(540)];
const originalTotal = planTotal(original);
normalizePlan(original, 20, 'bike');
check('caller\'s plan object is not mutated', planTotal(original) === originalTotal, planTotal(original));

// ---- 10. every duration in the supported range sums exactly ----
let allExact = true;
const shapes = [[1], [2], [3], [5], [8], [13], [20]];
for (let minutes = 5; minutes <= 90; minutes += 5) {
  for (const [n] of shapes) {
    const segs = [];
    for (let i = 0; i < n; i++) segs.push(bikeSeg(60 + i * 37));
    const r = normalizePlan(segs, minutes, 'bike');
    if (planTotal(r) !== minutes * 60 || !inBounds(r)) {
      allExact = false;
      console.log('   mismatch at ' + minutes + 'min x ' + n + ' segments: ' + planTotal(r) + ' (' + durations(r) + ')');
    }
  }
}
check('every supported duration x segment count sums exactly, within bounds', allExact);

console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS');
process.exit(fail ? 1 : 0);
