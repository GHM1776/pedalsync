// /api/instructor.js — AI Coach (Bike + Rower)
// Requires ANTHROPIC_API_KEY env var + Vercel KV store
// Logs all workout plans and adaptive coaching to KV for admin review

import { kv } from '@vercel/kv';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://pedalsync.app';

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];
const VALID_EQUIPMENT = ['bike', 'rower'];
const MIN_DURATION = 5;
const MAX_DURATION = 90;
const MAX_INPUT_LEN = 20;

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SEC = 60;

// Max workouts to keep in the index
const MAX_WORKOUT_INDEX = 200;
// Workout data expires after 30 days
const WORKOUT_TTL = 30 * 24 * 60 * 60;

// ---- BIKE PROMPTS ----

const BIKE_PLAN_PROMPT = `You are a spin cycling instructor creating a structured workout plan.

Rider profile:
- Difficulty: DIFFICULTY_VALUE
- Duration: DURATION_VALUE minutes
- Bike has 32 resistance levels

Generate a workout plan as a JSON array of segments. Each segment:
{
  "name": "Warmup" | "Flat Road" | "Hill Climb" | "Sprint" | "Recovery" | "Cool Down" | etc,
  "duration_sec": integer,
  "target_resistance_min": integer (1-32),
  "target_resistance_max": integer (1-32),
  "target_cadence_min": integer (RPM),
  "target_cadence_max": integer (RPM),
  "coaching_text": "Short motivational instruction"
}

Rules:
- Easy: resistance 5-15, cadence 60-85, longer recovery, no sprints
- Medium: resistance 8-22, cadence 65-100, moderate intervals
- Hard: resistance 12-32, cadence 70-110, aggressive intervals and climbs
- Total durations must sum to approximately DURATION_VALUE minutes
- Start with warmup, end with cool down
- Vary segments — don't repeat the same type back to back
- coaching_text: punchy, 1-2 sentences max

Respond with ONLY the JSON array. No markdown, no explanation.`;

const BIKE_ADAPTIVE_PROMPT = `You are a spin cycling instructor giving mid-ride coaching.

Current state:
- Difficulty: DIFFICULTY_VALUE
- Segment: SEGMENT_VALUE
- Targets: resistance TARGET_R, cadence TARGET_C
- Actual: resistance ACTUAL_R, cadence ACTUAL_C, power ACTUAL_PW
- Elapsed: ELAPSED_M min, remaining: ~REMAINING_M min
- Averages: AVG_PW, AVG_C RPM

Give a 1-2 sentence coaching cue based on performance vs targets.
Crushing it? Push them. Struggling? Encourage.
Direct, motivational, not cheesy.
Respond with ONLY the coaching text.`;

// ---- ROWER PROMPTS ----

const ROWER_PLAN_PROMPT = `You are a rowing coach creating a structured indoor rowing workout.

Athlete profile:
- Difficulty: DIFFICULTY_VALUE
- Duration: DURATION_VALUE minutes
- Rower has resistance levels (1-10 typical, higher available)
- Metrics: strokes per minute (SPM), split pace (/500m), power (watts)

Generate a workout plan as a JSON array of segments. Each segment:
{
  "name": "Warmup" | "Steady State" | "Power Intervals" | "Sprint" | "Recovery" | "Cool Down" | "Rate Build" | "Pyramid" | etc,
  "duration_sec": integer,
  "target_resistance_min": integer (1-10),
  "target_resistance_max": integer (1-10),
  "target_spm_min": integer (strokes per minute),
  "target_spm_max": integer (strokes per minute),
  "coaching_text": "Short rowing-specific coaching cue"
}

Rules:
- Easy: resistance 2-5, SPM 18-24, focus on form and steady state
- Medium: resistance 3-7, SPM 22-30, mix of steady state and intervals
- Hard: resistance 5-10, SPM 26-36, aggressive intervals, rate builds, and power pieces
- Total durations must sum to approximately DURATION_VALUE minutes
- Start with warmup, end with cool down
- Vary segments — don't repeat the same type back to back
- coaching_text: rowing-specific cues (drive with legs, squeeze at the catch, control the recovery, ratio, body angle, etc). Punchy, 1-2 sentences max.

Respond with ONLY the JSON array. No markdown, no explanation.`;

const ROWER_ADAPTIVE_PROMPT = `You are a rowing coach giving mid-workout coaching on an indoor rower.

Current state:
- Difficulty: DIFFICULTY_VALUE
- Segment: SEGMENT_VALUE
- Targets: resistance TARGET_R, stroke rate TARGET_SPM
- Actual: resistance ACTUAL_R, stroke rate ACTUAL_SPM SPM, power ACTUAL_PW, split ACTUAL_SPLIT
- Elapsed: ELAPSED_M min, remaining: ~REMAINING_M min
- Averages: AVG_PW, AVG_SPM SPM

Give a 1-2 sentence rowing coaching cue based on performance vs targets.
Use rowing-specific language: legs-body-arms sequence, drive ratio, catch timing, handle height, body angle, power application.
If they're hitting targets, push for more power or better form.
If struggling, cue technique over effort — rowing rewards efficiency.
Direct, motivational, not generic.
Respond with ONLY the coaching text.`;

// ---- Rate limiter ----

async function checkRateLimit(userId) {
  const key = `ratelimit:${userId}`;
  try {
    const current = await kv.incr(key);
    if (current === 1) {
      await kv.expire(key, RATE_LIMIT_WINDOW_SEC);
    }
    return current <= RATE_LIMIT_MAX;
  } catch (err) {
    console.error('Rate limit check failed:', err);
    return true;
  }
}

// ---- Input sanitizers ----

function sanitizeInt(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeEnum(val, allowed, fallback) {
  if (typeof val !== 'string') return fallback;
  const clean = val.toLowerCase().trim();
  return allowed.includes(clean) ? clean : fallback;
}

function sanitizeRange(val) {
  if (typeof val !== 'string') return '0';
  return val.replace(/[^0-9\- ]/g, '').substring(0, MAX_INPUT_LEN) || '0';
}

function getUserId(body) {
  const raw = body.beta_code || body.user_id || '';
  if (typeof raw !== 'string') return 'ANON';
  return raw.trim().toUpperCase().substring(0, 20) || 'ANON';
}

function generateWorkoutId() {
  return 'w_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

// ---- Workout logging ----

async function logWorkoutStart(workoutId, userId, equipmentType, difficulty, duration, plan) {
  try {
    const workout = {
      id: workoutId,
      userId,
      equipmentType,
      difficulty,
      duration,
      plan,
      startedAt: new Date().toISOString(),
      coachingLog: [],
    };
    await kv.set(`workout:${workoutId}`, JSON.stringify(workout), { ex: WORKOUT_TTL });

    // Add to index (recent first, capped)
    let index = [];
    try {
      var raw = await kv.get('workouts:index');
      if (raw) {
        index = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(index)) index = [];
      }
    } catch { index = []; }
    index.unshift({ id: workoutId, userId, equipmentType, difficulty, duration, startedAt: workout.startedAt });
    if (index.length > MAX_WORKOUT_INDEX) index = index.slice(0, MAX_WORKOUT_INDEX);
    await kv.set('workouts:index', JSON.stringify(index));
  } catch (err) {
    console.error('Workout log error:', err);
  }
}

async function logAdaptiveCoaching(workoutId, entry) {
  if (!workoutId) return;
  try {
    const raw = await kv.get(`workout:${workoutId}`);
    if (!raw) return;
    const workout = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!workout.coachingLog) workout.coachingLog = [];
    workout.coachingLog.push(entry);
    await kv.set(`workout:${workoutId}`, JSON.stringify(workout), { ex: WORKOUT_TTL });
  } catch (err) {
    console.error('Coaching log error:', err);
  }
}

async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Server config error');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    console.error(`Claude API error: ${resp.status}`);
    throw new Error('AI service unavailable');
  }

  const data = await resp.json();
  return data.content[0].text;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin === ALLOWED_ORIGIN || process.env.NODE_ENV === 'development') {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  const userId = getUserId(req.body);

  if (!(await checkRateLimit(userId))) {
    return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
  }

  try {
    const equipmentType = sanitizeEnum(req.body.equipment_type, VALID_EQUIPMENT, 'bike');

    if (action === 'generate_plan') {
      const difficulty = sanitizeEnum(req.body.difficulty, VALID_DIFFICULTIES, 'medium');
      const duration = sanitizeInt(req.body.duration, MIN_DURATION, MAX_DURATION, 20);

      const template = equipmentType === 'rower' ? ROWER_PLAN_PROMPT : BIKE_PLAN_PROMPT;
      const prompt = template
        .replaceAll('DIFFICULTY_VALUE', difficulty)
        .replaceAll('DURATION_VALUE', String(duration));

      const text = await callClaude(prompt);

      let clean = text.trim();
      if (clean.startsWith('```')) {
        clean = clean.split('\n').slice(1).join('\n');
        clean = clean.replace(/```\s*$/, '');
      }

      const plan = JSON.parse(clean);
      if (!Array.isArray(plan)) throw new Error('Invalid plan format');

      let safePlan;
      if (equipmentType === 'rower') {
        safePlan = plan.slice(0, 20).map(seg => ({
          name: String(seg.name || '').substring(0, 30),
          duration_sec: sanitizeInt(seg.duration_sec, 10, 600, 60),
          target_resistance_min: sanitizeInt(seg.target_resistance_min, 1, 32, 3),
          target_resistance_max: sanitizeInt(seg.target_resistance_max, 1, 32, 6),
          target_spm_min: sanitizeInt(seg.target_spm_min, 10, 50, 20),
          target_spm_max: sanitizeInt(seg.target_spm_max, 10, 50, 28),
          coaching_text: String(seg.coaching_text || '').substring(0, 200),
        }));
      } else {
        safePlan = plan.slice(0, 20).map(seg => ({
          name: String(seg.name || '').substring(0, 30),
          duration_sec: sanitizeInt(seg.duration_sec, 10, 600, 60),
          target_resistance_min: sanitizeInt(seg.target_resistance_min, 1, 32, 5),
          target_resistance_max: sanitizeInt(seg.target_resistance_max, 1, 32, 15),
          target_cadence_min: sanitizeInt(seg.target_cadence_min, 30, 150, 60),
          target_cadence_max: sanitizeInt(seg.target_cadence_max, 30, 150, 90),
          coaching_text: String(seg.coaching_text || '').substring(0, 200),
        }));
      }

      // Log workout to KV
      const workoutId = generateWorkoutId();
      await logWorkoutStart(workoutId, userId, equipmentType, difficulty, duration, safePlan);

      return res.json({ plan: safePlan, workout_id: workoutId });

    } else if (action === 'adaptive') {
      const difficulty = sanitizeEnum(req.body.difficulty, VALID_DIFFICULTIES, 'medium');
      const workoutId = (req.body.workout_id || '').substring(0, 30);

      if (equipmentType === 'rower') {
        const VALID_ROWER_SEGMENTS = [
          'warmup', 'steady state', 'power intervals', 'sprint', 'recovery',
          'cool down', 'rate build', 'pyramid', 'tempo', 'endurance',
          'intervals', 'threshold', 'push', 'technique', 'segment',
        ];
        const segName = sanitizeEnum(req.body.segment_name, VALID_ROWER_SEGMENTS, 'segment');
        const targetR = sanitizeRange(req.body.target_r);
        const targetSPM = sanitizeRange(req.body.target_spm);
        const actualR = sanitizeInt(req.body.actual_resistance, 0, 32, 0);
        const actualSPM = sanitizeInt(req.body.actual_spm, 0, 60, 0);
        const actualP = sanitizeInt(req.body.actual_power, 0, 2000, 0);
        const actualSplit = sanitizeInt(req.body.actual_split, 0, 999, 0);
        const elapsedM = sanitizeInt(req.body.elapsed_min, 0, 120, 0);
        const remainM = sanitizeInt(req.body.remaining_min, 0, 120, 0);
        const avgP = sanitizeInt(req.body.avg_power, 0, 2000, 0);
        const avgSPM = sanitizeInt(req.body.avg_spm, 0, 60, 0);

        const splitDisplay = actualSplit > 0 && actualSplit < 600
          ? Math.floor(actualSplit / 60) + ':' + String(actualSplit % 60).padStart(2, '0') + '/500m'
          : 'n/a';

        const prompt = ROWER_ADAPTIVE_PROMPT
          .replace('DIFFICULTY_VALUE', difficulty)
          .replace('SEGMENT_VALUE', segName)
          .replace('TARGET_R', targetR)
          .replace('TARGET_SPM', targetSPM)
          .replace('ACTUAL_R', String(actualR))
          .replace('ACTUAL_SPM', String(actualSPM))
          .replace('ACTUAL_PW', String(actualP))
          .replace('ACTUAL_SPLIT', splitDisplay)
          .replace('ELAPSED_M', String(elapsedM))
          .replace('REMAINING_M', String(remainM))
          .replace('AVG_PW', String(avgP))
          .replace('AVG_SPM', String(avgSPM));

        const coaching = await callClaude(prompt);
        const coachingText = coaching.trim().substring(0, 300);

        // Log adaptive coaching
        await logAdaptiveCoaching(workoutId, {
          ts: new Date().toISOString(),
          segment: segName,
          targets: { resistance: targetR, spm: targetSPM },
          actuals: { resistance: actualR, spm: actualSPM, power: actualP, split: splitDisplay },
          elapsed: elapsedM,
          remaining: remainM,
          averages: { power: avgP, spm: avgSPM },
          coaching: coachingText,
        });

        return res.json({ coaching: coachingText });

      } else {
        const VALID_BIKE_SEGMENTS = [
          'warmup', 'flat road', 'hill climb', 'sprint', 'recovery', 'cool down',
          'steady state', 'intervals', 'threshold', 'tempo', 'endurance', 'push', 'segment',
        ];
        const segName = sanitizeEnum(req.body.segment_name, VALID_BIKE_SEGMENTS, 'segment');
        const targetR = sanitizeRange(req.body.target_r);
        const targetC = sanitizeRange(req.body.target_c);
        const actualR = sanitizeInt(req.body.actual_resistance, 0, 32, 0);
        const actualC = sanitizeInt(req.body.actual_cadence, 0, 200, 0);
        const actualP = sanitizeInt(req.body.actual_power, 0, 2000, 0);
        const elapsedM = sanitizeInt(req.body.elapsed_min, 0, 120, 0);
        const remainM = sanitizeInt(req.body.remaining_min, 0, 120, 0);
        const avgP = sanitizeInt(req.body.avg_power, 0, 2000, 0);
        const avgC = sanitizeInt(req.body.avg_cadence, 0, 200, 0);

        const prompt = BIKE_ADAPTIVE_PROMPT
          .replace('DIFFICULTY_VALUE', difficulty)
          .replace('SEGMENT_VALUE', segName)
          .replace('TARGET_R', targetR)
          .replace('TARGET_C', targetC)
          .replace('ACTUAL_R', String(actualR))
          .replace('ACTUAL_C', String(actualC))
          .replace('ACTUAL_PW', String(actualP))
          .replace('ELAPSED_M', String(elapsedM))
          .replace('REMAINING_M', String(remainM))
          .replace('AVG_PW', String(avgP))
          .replace('AVG_C', String(avgC));

        const coaching = await callClaude(prompt);
        const coachingText = coaching.trim().substring(0, 300);

        // Log adaptive coaching
        await logAdaptiveCoaching(workoutId, {
          ts: new Date().toISOString(),
          segment: segName,
          targets: { resistance: targetR, cadence: targetC },
          actuals: { resistance: actualR, cadence: actualC, power: actualP },
          elapsed: elapsedM,
          remaining: remainM,
          averages: { power: avgP, cadence: avgC },
          coaching: coachingText,
        });

        return res.json({ coaching: coachingText });
      }

    } else {
      return res.status(400).json({ error: 'Invalid request' });
    }
  } catch (err) {
    console.error('Instructor error:', err);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}