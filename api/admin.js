// /api/admin.js — View beta code claim status
// Protected by ADMIN_KEY env var (header-only auth)

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // Header-only auth — never accept key in query string (leaks to logs/referrers)
  const adminKey = process.env.ADMIN_KEY;
  const provided = req.headers['x-admin-key'];

  if (!adminKey || provided !== adminKey) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const validCodes = (process.env.BETA_CODES || '')
      .split(',')
      .map(c => c.trim().toUpperCase())
      .filter(Boolean);

    const totalClaims = await kv.get('beta:total_claims') || 0;

    // Check each code
    const codeStatus = [];
    for (const code of validCodes) {
      const data = await kv.get(`beta:${code}`);
      codeStatus.push({
        code,
        claimed: !!data,
        claimed_at: data?.claimed_at || null,
      });
    }

    const claimed = codeStatus.filter(c => c.claimed).length;
    const unclaimed = codeStatus.filter(c => !c.claimed).length;

    return res.json({
      total_codes: validCodes.length,
      claimed,
      unclaimed,
      total_claims: totalClaims,
      codes: codeStatus,
    });

  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: 'KV error' });
  }
}