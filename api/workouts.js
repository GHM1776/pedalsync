// /api/workouts.js — Admin endpoint for workout logs
// Protected by ADMIN_KEY (header auth)

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // Header-only auth
  const adminKey = process.env.ADMIN_KEY;
  const provided = req.headers['x-admin-key'];

  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method === 'GET') {
    const workoutId = req.query.id;

    // Single workout detail
    if (workoutId) {
      try {
        const raw = await kv.get(`workout:${workoutId}`);
        if (!raw) return res.status(404).json({ error: 'Workout not found' });
        const workout = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return res.json(workout);
      } catch (err) {
        console.error('Workout fetch error:', err);
        return res.status(500).json({ error: 'Server error' });
      }
    }

    // List all workouts
    try {
      const raw = await kv.get('workouts:index');
      const index = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
      return res.json({ workouts: index });
    } catch (err) {
      console.error('Workout list error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}