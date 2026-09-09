// /api/unlock.js — BLE Unlock Proxy
// Handles the firmware lockout challenge-response handshake
//
// Flow: Browser sends the challenge bytes → this endpoint authenticates with
// the manufacturer's service, forwards the challenge, returns the unlock key.
//
// Every attempt writes one "[unlock] {...}" line to the Vercel log with the
// full picture: challenge bytes + well-formedness, Echelon HTTP status /
// latency / body snippet on anything abnormal, key bytes + the exact framed
// packet the client will write, whether the key merely echoes the challenge,
// JWT cached-vs-fresh, and the service account's plan fields from login.
// Grep "[unlock]" in the log view.
//
// The request body also accepts optional `session` (Pulse session id) and
// `device` (BLE name); both are logged and echoed back in `diag` so a log
// line here can be joined to the client-side Pulse timeline.

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://pedalsync.app';

// Upstream service configuration — endpoints, API key, and account are
// intentionally not in source. Set these in Vercel env vars:
//   ECHELON_AUTH_URL, ECHELON_UNLOCK_URL, ECHELON_API_KEY,
//   ECHELON_EMAIL, ECHELON_PASSWORD
const ECHELON_AUTH_URL = process.env.ECHELON_AUTH_URL;
const ECHELON_UNLOCK_URL = process.env.ECHELON_UNLOCK_URL;
const ECHELON_API_KEY = process.env.ECHELON_API_KEY;
const ECHELON_EMAIL = process.env.ECHELON_EMAIL;
const ECHELON_PASSWORD = process.env.ECHELON_PASSWORD;

// A hung Echelon call surfaces as aborted:true instead of a Vercel timeout
const FETCH_TIMEOUT_MS = 8000;

// Cache the JWT token (valid for ~30 days based on token payload)
let cachedJwt = null;
let jwtExpiry = 0;
let cachedPlan = null;

// ---------- helpers ----------

function hex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function checksumOk(b) {
  if (!b || b.length < 2) return false;
  let s = 0;
  for (let i = 0; i < b.length - 1; i++) s += b[i];
  return (s & 0xFF) === b[b.length - 1];
}

function snippet(text) {
  return (text || '').replace(/\s+/g, ' ').slice(0, 300);
}

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[^\x20-\x7E]/g, '').slice(0, max);
}

// Plan/subscription-shaped fields from the login response, in case Echelon
// starts gating unlock on subscription. Never includes token-ish keys.
function extractPlan(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (/jwt|token|password|secret/i.test(k)) continue;
    if (/plan|subscri|member|tier|premium/i.test(k)) {
      const v = obj[k];
      out[k] = typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120);
    }
  }
  return Object.keys(out).length ? out : null;
}

// fetch with a hard timeout; never throws — returns {status, ok, text, ms, aborted, error}
async function timedFetch(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  try {
    const resp = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await resp.text();
    return { status: resp.status, ok: resp.ok, text, ms: Date.now() - started, aborted: false };
  } catch (err) {
    return {
      status: 0, ok: false, text: '', ms: Date.now() - started,
      aborted: err.name === 'AbortError',
      error: err.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Echelon calls ----------

async function getEchelonJwt(diag) {
  const now = Date.now() / 1000;

  // Return cached token if still valid (with 1 hour buffer)
  if (cachedJwt && jwtExpiry > now + 3600) {
    diag.jwt_cached = true;
    diag.plan = cachedPlan;
    return cachedJwt;
  }
  diag.jwt_cached = false;

  if (!ECHELON_AUTH_URL || !ECHELON_UNLOCK_URL || !ECHELON_API_KEY || !ECHELON_EMAIL || !ECHELON_PASSWORD) {
    diag.outcome = 'not_configured';
    throw new Error('Unlock service not configured');
  }

  const r = await timedFetch(ECHELON_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ECHELON_API_KEY,
    },
    body: JSON.stringify({ email: ECHELON_EMAIL, password: ECHELON_PASSWORD }),
  });
  diag.auth = { status: r.status, ms: r.ms, aborted: r.aborted };

  if (!r.ok) {
    diag.auth.body_snippet = snippet(r.text) || r.error || null;
    diag.outcome = r.aborted ? 'auth_timeout' : 'auth_http_' + r.status;
    throw new Error('Echelon authentication failed');
  }

  let data;
  try { data = JSON.parse(r.text); } catch {
    diag.auth.body_snippet = snippet(r.text);
    diag.outcome = 'auth_bad_body';
    throw new Error('Echelon auth returned non-JSON');
  }

  const jwt = data && data.data && data.data.jwt;
  if (!jwt) {
    diag.auth.keys = data && typeof data === 'object' ? Object.keys(data) : [];
    diag.outcome = 'auth_no_jwt';
    throw new Error('Echelon auth response missing jwt');
  }

  cachedJwt = jwt;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    jwtExpiry = payload.exp || (now + 86400);
  } catch {
    jwtExpiry = now + 86400; // Default 24h if parse fails
  }

  cachedPlan = extractPlan(data.data);
  diag.plan = cachedPlan;
  diag.auth.account_keys = Object.keys(data.data).filter(k => !/jwt|token|password|secret/i.test(k));

  return cachedJwt;
}

function callUnlock(jwt, challengeB64) {
  return timedFetch(ECHELON_UNLOCK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ECHELON_API_KEY,
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ data: challengeB64 }),
  });
}

// ---------- handler ----------

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || '';
  if (origin === ALLOWED_ORIGIN || process.env.NODE_ENV === 'development') {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { challenge, session, device } = req.body || {};

  const diag = {
    session: cleanStr(session, 40),
    device: cleanStr(device, 64),
    challenge_hex: null,
    challenge_len: 0,
    challenge_prefix_ok: false,
    challenge_cksum_ok: false,
    jwt_cached: null,
    auth: null,
    plan: cachedPlan,
    echelon: null,
    key_hex: null,
    key_len: 0,
    framed_hex: null,
    key_echoes_challenge: false,
    outcome: null,
  };

  const finish = (status, body) => {
    if (!diag.outcome) diag.outcome = status === 200 ? 'ok' : 'error';
    console.log('[unlock]', JSON.stringify(diag));
    return res.status(status).json(body);
  };

  if (!challenge || typeof challenge !== 'string') {
    diag.outcome = 'bad_request_missing_challenge';
    return finish(400, { error: 'Missing challenge (base64-encoded E0 bytes)', diag });
  }

  // Basic validation — challenge should be valid base64, ~12 chars for 8 bytes
  if (challenge.length > 20 || !/^[A-Za-z0-9+/=]+$/.test(challenge)) {
    diag.outcome = 'bad_request_challenge_format';
    return finish(400, { error: 'Invalid challenge format', diag });
  }

  const cBytes = Buffer.from(challenge, 'base64');
  diag.challenge_hex = hex(cBytes);
  diag.challenge_len = cBytes.length;
  diag.challenge_prefix_ok = cBytes.length === 8 && cBytes[0] === 0xF0 && cBytes[1] === 0xE0;
  diag.challenge_cksum_ok = checksumOk(cBytes);

  try {
    const jwt = await getEchelonJwt(diag);

    let r = await callUnlock(jwt, challenge);
    let retried = false;

    // If auth expired, clear cache and retry once with a fresh JWT
    if (!r.ok && !r.aborted && (r.status === 401 || r.status === 403)) {
      cachedJwt = null;
      jwtExpiry = 0;
      const freshJwt = await getEchelonJwt(diag);
      r = await callUnlock(freshJwt, challenge);
      retried = true;
    }

    diag.echelon = { status: r.status, ms: r.ms, aborted: r.aborted, retried };

    if (r.aborted) {
      diag.outcome = 'echelon_timeout';
      return finish(502, { error: 'Echelon unlock service timed out. Try again.', diag });
    }
    if (!r.ok) {
      diag.echelon.body_snippet = snippet(r.text) || r.error || null;
      diag.outcome = 'echelon_http_' + r.status;
      return finish(502, { error: `Unlock failed — Echelon returned ${r.status}`, diag });
    }

    let result;
    try { result = JSON.parse(r.text); } catch {
      diag.echelon.body_snippet = snippet(r.text);
      diag.outcome = 'echelon_bad_body';
      return finish(502, { error: 'Unlock failed — invalid response from server', diag });
    }

    // Unexpected extra fields are new-scheme hints — always log them
    diag.echelon.extra_keys = Object.keys(result).filter(k => k !== 'status' && k !== 'data');
    if (result.data && typeof result.data === 'object') {
      diag.echelon.extra_data_keys = Object.keys(result.data).filter(k => k !== 'key');
    }

    if (result.status !== 'success' || !result.data || !result.data.key) {
      diag.echelon.body_snippet = snippet(r.text);
      diag.outcome = 'echelon_bad_response';
      return finish(502, { error: 'Unlock failed — invalid response from server', diag });
    }

    const keyB64 = result.data.key;
    const kBytes = Buffer.from(keyB64, 'base64');
    diag.key_hex = hex(kBytes);
    diag.key_len = kBytes.length;
    diag.key_echoes_challenge = diag.key_hex === diag.challenge_hex;

    // The exact bytes the client will write — mirrors the framing in ble.js
    if (kBytes.length === 8) {
      const framed = Buffer.alloc(8);
      framed[0] = 0xF0;
      framed[1] = 0xE0;
      for (let i = 2; i < 7; i++) framed[i] = kBytes[i];
      let sum = 0;
      for (let j = 0; j < 7; j++) sum += framed[j];
      framed[7] = sum & 0xFF;
      diag.framed_hex = hex(framed);
    } else {
      diag.framed_hex = diag.key_hex; // client writes the raw key bytes
    }

    diag.outcome = 'ok';
    return finish(200, { key: keyB64, diag });

  } catch (err) {
    console.error('Unlock error:', err);
    if (!diag.outcome) diag.outcome = 'proxy_error';
    diag.error = err.message || String(err);
    return finish(500, { error: 'Unlock service error. Try again.', diag });
  }
}
