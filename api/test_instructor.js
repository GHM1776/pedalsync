#!/usr/bin/env node
// test-instructor-verbose.js — Show full AI Coach output
// Usage: node test-instructor-verbose.js [base_url]

const BASE = (process.argv[2] || 'https://pedalsync.app').replace(/\/+$/, '');
const ENDPOINT = `${BASE}/api/instructor`;

async function call(body) {
  const start = Date.now();
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - start;
  const data = await resp.json();
  return { status: resp.status, data, ms };
}

function pad(str, len) {
  return String(str).padEnd(len);
}

function printPlan(plan, type) {
  const isRower = type === 'rower';
  const totalSec = plan.reduce((a, s) => a + s.duration_sec, 0);

  // Header
  const cols = isRower
    ? ['#', 'Segment', 'Dur', 'Resistance', 'SPM', 'Coaching']
    : ['#', 'Segment', 'Dur', 'Resistance', 'Cadence', 'Coaching'];

  const widths = [3, 20, 6, 12, 12, 50];

  console.log('  ' + cols.map((c, i) => pad(c, widths[i])).join(' '));
  console.log('  ' + widths.map(w => '─'.repeat(w)).join(' '));

  plan.forEach((seg, i) => {
    const dur = `${Math.floor(seg.duration_sec / 60)}:${String(seg.duration_sec % 60).padStart(2, '0')}`;
    const res = `${seg.target_resistance_min}-${seg.target_resistance_max}`;
    const rate = isRower
      ? `${seg.target_spm_min}-${seg.target_spm_max}`
      : `${seg.target_cadence_min}-${seg.target_cadence_max}`;
    const text = (seg.coaching_text || '').substring(0, 48);

    console.log('  ' + [
      pad(i + 1, widths[0]),
      pad(seg.name, widths[1]),
      pad(dur, widths[2]),
      pad(res, widths[3]),
      pad(rate, widths[4]),
      text,
    ].join(' '));
  });

  console.log('  ' + widths.map(w => '─'.repeat(w)).join(' '));
  console.log(`  Total: ${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}  |  ${plan.length} segments`);
}

(async () => {
  console.log(`\nPedalSync AI Coach — Full Output Dump`);
  console.log(`Target: ${ENDPOINT}\n`);

  // ══════════════════════════════════════
  // BIKE PLAN
  // ══════════════════════════════════════
  console.log('═══ BIKE PLAN (medium, 10 min) ═══\n');
  const bike = await call({
    action: 'generate_plan',
    equipment_type: 'bike',
    difficulty: 'medium',
    duration: 10,
    user_id: 'TEST-VERBOSE',
  });

  if (bike.status !== 200) {
    console.log(`  ✗ HTTP ${bike.status}: ${bike.data.error}`);
  } else {
    console.log(`  Response time: ${bike.ms}ms`);
    console.log(`  Workout ID: ${bike.data.workout_id}\n`);
    printPlan(bike.data.plan, 'bike');

    // BIKE ADAPTIVE
    console.log(`\n── Bike Adaptive Coaching ──\n`);
    const seg = bike.data.plan[0];
    const bikeAdapt = await call({
      action: 'adaptive',
      equipment_type: 'bike',
      difficulty: 'medium',
      segment_name: seg.name,
      target_r: `${seg.target_resistance_min}-${seg.target_resistance_max}`,
      target_c: `${seg.target_cadence_min}-${seg.target_cadence_max}`,
      actual_resistance: 12,
      actual_cadence: 75,
      actual_power: 85,
      elapsed_min: 3,
      remaining_min: 7,
      avg_power: 80,
      avg_cadence: 72,
      user_id: 'TEST-VERBOSE',
      workout_id: bike.data.workout_id,
    });

    if (bikeAdapt.status !== 200) {
      console.log(`  ✗ HTTP ${bikeAdapt.status}: ${bikeAdapt.data.error}`);
    } else {
      console.log(`  Segment: ${seg.name}`);
      console.log(`  Simulated input: R=12, C=75rpm, P=85W (avg 80W, 72rpm)`);
      console.log(`  Response time: ${bikeAdapt.ms}ms\n`);
      console.log(`  Coach says: "${bikeAdapt.data.coaching}"`);
    }
  }

  // ══════════════════════════════════════
  // ROWER PLAN
  // ══════════════════════════════════════
  console.log(`\n\n═══ ROWER PLAN (easy, 10 min) ═══\n`);
  const rower = await call({
    action: 'generate_plan',
    equipment_type: 'rower',
    difficulty: 'easy',
    duration: 10,
    user_id: 'TEST-VERBOSE',
  });

  if (rower.status !== 200) {
    console.log(`  ✗ HTTP ${rower.status}: ${rower.data.error}`);
  } else {
    console.log(`  Response time: ${rower.ms}ms`);
    console.log(`  Workout ID: ${rower.data.workout_id}\n`);
    printPlan(rower.data.plan, 'rower');

    // ROWER ADAPTIVE
    console.log(`\n── Rower Adaptive Coaching ──\n`);
    const seg = rower.data.plan[0];
    const rowerAdapt = await call({
      action: 'adaptive',
      equipment_type: 'rower',
      difficulty: 'easy',
      segment_name: seg.name,
      target_r: `${seg.target_resistance_min}-${seg.target_resistance_max}`,
      target_spm: `${seg.target_spm_min}-${seg.target_spm_max}`,
      actual_resistance: 4,
      actual_spm: 22,
      actual_power: 45,
      actual_split: 150,
      elapsed_min: 2,
      remaining_min: 8,
      avg_power: 42,
      avg_spm: 21,
      user_id: 'TEST-VERBOSE',
      workout_id: rower.data.workout_id,
    });

    if (rowerAdapt.status !== 200) {
      console.log(`  ✗ HTTP ${rowerAdapt.status}: ${rowerAdapt.data.error}`);
    } else {
      console.log(`  Segment: ${seg.name}`);
      console.log(`  Simulated input: R=4, SPM=22, P=45W, Split=2:30/500m (avg 42W, 21spm)`);
      console.log(`  Response time: ${rowerAdapt.ms}ms\n`);
      console.log(`  Coach says: "${rowerAdapt.data.coaching}"`);
    }
  }

  console.log('\n');
})();