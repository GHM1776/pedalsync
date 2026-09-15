// /api/_plan.js — plan shape correction for the AI coach.
//
// Underscore-prefixed, so Vercel does not expose it as a route; instructor.js
// imports it and test/test_plan.js unit-tests it without pulling in the KV
// client.
//
// Why: the model is asked for a total and drifts anyway. Four 20-minute
// requests came back as 24, 23, 21 and 20 minutes of segments, and the
// sanitizer clamped each segment to 10-600s without ever checking the sum. A
// rider who asks for 20 minutes should get 20 minutes.
//
// Segments are in SECONDS. A 20-minute request must sum to 1200.

export const SEG_MIN_SEC = 10;
export const SEG_MAX_SEC = 600;

const DEFAULTS = {
  bike: {
    name: 'Steady State',
    target_resistance_min: 5, target_resistance_max: 15,
    target_cadence_min: 60, target_cadence_max: 90,
    coaching_text: 'Steady effort — hold a comfortable pace.',
  },
  rower: {
    name: 'Steady State',
    target_resistance_min: 3, target_resistance_max: 6,
    target_spm_min: 20, target_spm_max: 28,
    coaching_text: 'Steady state — drive with the legs, control the recovery.',
  },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const total = (segs) => segs.reduce((a, x) => a + (Number(x.duration_sec) || 0), 0);

// A model that returns min > max would make the dashboard show an impossible range
function orderRange(seg, minKey, maxKey) {
  if (typeof seg[minKey] !== 'number' || typeof seg[maxKey] !== 'number') return;
  if (seg[minKey] > seg[maxKey]) {
    const t = seg[minKey];
    seg[minKey] = seg[maxKey];
    seg[maxKey] = t;
  }
}

// Warmup and cool down are the first and last segments. If the model made
// either harder than something in the middle, bring its floor down to the
// plan's lowest; otherwise leave the shape it chose alone.
function easeEnds(segs) {
  if (segs.length < 3) return;
  const mins = segs.map((x) => x.target_resistance_min).filter((v) => typeof v === 'number');
  if (!mins.length) return;
  const lowest = Math.min(...mins);
  for (const i of [0, segs.length - 1]) {
    const seg = segs[i];
    if (typeof seg.target_resistance_min !== 'number') continue;
    if (seg.target_resistance_min <= lowest) continue;
    seg.target_resistance_min = lowest;
    if (typeof seg.target_resistance_max === 'number' && seg.target_resistance_max < lowest) {
      seg.target_resistance_max = lowest;
    }
  }
}

// The segment to put leftover seconds on: the longest one that still has room,
// preferring the middle so warmup and cool down keep their shape.
function longestAdjustable(segs, residue) {
  const hasRoom = (i) => (residue > 0 ? segs[i].duration_sec < SEG_MAX_SEC : segs[i].duration_sec > SEG_MIN_SEC);
  let best = -1;
  const scan = (from, to) => {
    for (let i = from; i <= to; i++) {
      if (!hasRoom(i)) continue;
      if (best === -1 || segs[i].duration_sec > segs[best].duration_sec) best = i;
    }
  };
  if (segs.length >= 3) scan(1, segs.length - 2);
  if (best === -1) scan(0, segs.length - 1);
  return best;
}

// Last resort: the requested time split evenly, summing exactly. Uses enough
// segments to respect the per-segment cap (a 90-minute plan needs at least
// nine) and not so many that the 10s minimum overshoots the request.
function evenDurations(segs, target, equipmentType) {
  const base = DEFAULTS[equipmentType] || DEFAULTS.bike;
  let n = Math.max(segs.length || 1, Math.ceil(target / SEG_MAX_SEC));
  n = Math.min(n, Math.max(1, Math.floor(target / SEG_MIN_SEC)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const src = segs[i] || segs[segs.length - 1] || base;
    out.push({ ...base, ...src });
  }
  const each = Math.floor(target / n);
  const spare = target - each * n;   // target is minutes*60, so this is small
  for (let i = 0; i < n; i++) out[i].duration_sec = each + (i < spare ? 1 : 0);
  return out;
}

// Returns a plan whose duration_sec values sum to exactly minutes*60.
export function normalizePlan(plan, minutes, equipmentType) {
  const target = Math.round(minutes * 60);
  const segs = (Array.isArray(plan) ? plan : []).map((x) => ({ ...x }));

  for (const seg of segs) {
    orderRange(seg, 'target_resistance_min', 'target_resistance_max');
    orderRange(seg, 'target_cadence_min', 'target_cadence_max');
    orderRange(seg, 'target_spm_min', 'target_spm_max');
  }
  easeEnds(segs);

  const sum = total(segs);
  if (!segs.length || sum <= 0) return evenDurations(segs, target, equipmentType);
  if (sum === target) return segs;

  const scale = target / sum;
  for (const seg of segs) {
    seg.duration_sec = clamp(Math.round((Number(seg.duration_sec) || 0) * scale), SEG_MIN_SEC, SEG_MAX_SEC);
  }

  // Rounding and the per-segment clamp leave a few seconds either way
  let residue = target - total(segs);
  for (let guard = 0; residue !== 0 && guard <= segs.length + 1; guard++) {
    const i = longestAdjustable(segs, residue);
    if (i === -1) break;
    const room = residue > 0 ? SEG_MAX_SEC - segs[i].duration_sec : SEG_MIN_SEC - segs[i].duration_sec;
    const step = residue > 0 ? Math.min(residue, room) : Math.max(residue, room);
    if (step === 0) break;
    segs[i].duration_sec += step;
    residue -= step;
  }

  // Never hand back a plan that doesn't last what was asked for
  if (total(segs) !== target) return evenDurations(segs, target, equipmentType);
  return segs;
}

export const planTotal = total;
