// /api/unlock response shape — run from the repo root:  node test/test_unlock.js
//
// The unlock proxy builds a rich `diag` object for the Vercel log: the Echelon
// account's plan tier, upstream auth status and timing, and on a failure a
// snippet of Echelon's own response body. It used to return that object to the
// browser as well, and js/ble.js handed the whole response to PSDiag, which
// beacons it to Pulse — so the plan name and auth internals were sitting in
// every captured session. The server log must keep all of it; the browser must
// get the key or the message and nothing else.
//
// No env vars or network: the upstream calls are stubbed, and the module is
// re-imported with a cache-busting query when a different env is needed.
// Node prints a one-line MODULE_TYPELESS_PACKAGE_JSON notice. Harmless.
const path = require('path');
const { pathToFileURL } = require('url');

let fail = 0;
const check = (n, c, d) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) { fail++; if (d !== undefined) console.log('   ' + JSON.stringify(d)); } };
const MOD = pathToFileURL(path.join(__dirname, '..', 'api', 'unlock.js')).href;

// An 8-byte E0 challenge with a valid checksum, as the bike sends it
const challengeBytes = [0xF0, 0xE0, 1, 2, 3, 4, 5, 0];
challengeBytes[7] = challengeBytes.slice(0, 7).reduce((a, b) => a + b, 0) & 0xFF;
const CHALLENGE = Buffer.from(challengeBytes).toString('base64');
const KEY_B64 = Buffer.from([0xF0, 0xE0, 9, 8, 7, 6, 5, 0x3C]).toString('base64');

// A JWT whose payload parses, so the module caches it like the real one
const JWT = 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64') + '.s';

const AUTH_URL = 'https://auth.test/login';
const UNLOCK_URL = 'https://unlock.test/key';
const SECRET_SNIPPET = 'account greg@example.com is not entitled';

function setEnv() {
  process.env.ECHELON_AUTH_URL = AUTH_URL;
  process.env.ECHELON_UNLOCK_URL = UNLOCK_URL;
  process.env.ECHELON_API_KEY = 'test-api-key';
  process.env.ECHELON_EMAIL = 'greg@example.com';
  process.env.ECHELON_PASSWORD = 'test-password';
  process.env.ALLOWED_ORIGIN = 'https://pedalsync.app';
}

// ---- stubs ----
let routes = {};
global.fetch = async (url) => {
  const r = routes[String(url)];
  if (!r) throw new Error('unexpected fetch: ' + url);
  return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body };
};
const authOk = () => JSON.stringify({ data: { jwt: JWT, plan: 'Echelon Premier Monthly', member_id: 4471, email: 'greg@example.com' } });

function mkRes() {
  return {
    _status: 0, _body: undefined, _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(n) { this._status = n; return this; },
    json(b) { this._body = b; return this; },
    end() { return this; },
  };
}
function mkReq(body, method) {
  return { method: method || 'POST', headers: { origin: 'https://pedalsync.app' }, body };
}

// Capture the server log so we can prove it kept everything
const realLog = console.log;
let logs = [];
const captureLogs = (on) => {
  if (on) { logs = []; console.log = (...a) => { if (a[0] === '[unlock]') logs.push(a[1]); else realLog(...a); }; }
  else console.log = realLog;
};
const lastDiag = () => { try { return JSON.parse(logs[logs.length - 1]); } catch (e) { return null; } };

(async () => {
  setEnv();
  const { default: handler } = await import(MOD);

  // ---- 1. preflight and rejections ----
  let res = mkRes();
  await handler(mkReq(null, 'OPTIONS'), res);
  check('OPTIONS preflight answered 204', res._status === 204);

  captureLogs(true);
  res = mkRes();
  await handler(mkReq({ session: 'sess-1' }), res);
  captureLogs(false);
  check('missing challenge → 400 with only an error message',
    res._status === 400 && Object.keys(res._body).join(',') === 'error', res._body);
  check('...and the server log still carries the diag with its session id',
    lastDiag() && lastDiag().session === 'sess-1' && lastDiag().outcome === 'bad_request_missing_challenge', lastDiag());

  res = mkRes();
  await handler(mkReq({ challenge: 'not valid base64!!' }), res);
  check('malformed challenge → 400 with only an error message',
    res._status === 400 && Object.keys(res._body).join(',') === 'error', res._body);

  // ---- 2. the success path: the browser gets a key, nothing else ----
  routes = {
    [AUTH_URL]: { status: 200, body: authOk() },
    [UNLOCK_URL]: { status: 200, body: JSON.stringify({ status: 'success', data: { key: KEY_B64 } }) },
  };
  captureLogs(true);
  res = mkRes();
  await handler(mkReq({ challenge: CHALLENGE, session: 'sess-2', device: 'ECHEX-5-105626' }), res);
  captureLogs(false);
  check('unlock succeeds', res._status === 200 && res._body.key === KEY_B64, res._body);
  check('the 200 body is exactly { key } — no diag block',
    Object.keys(res._body).join(',') === 'key', Object.keys(res._body));
  const sent = JSON.stringify(res._body);
  check('no plan tier, auth block, or key hex reaches the browser',
    !/plan|auth|jwt_cached|key_hex|framed_hex|outcome|Premier/i.test(sent), sent);

  const d = lastDiag();
  check('the server log kept the full picture (session, device, plan, auth, key hex, outcome)',
    d && d.session === 'sess-2' && d.device === 'ECHEX-5-105626' && d.outcome === 'ok' &&
    d.plan && d.plan.plan === 'Echelon Premier Monthly' && d.auth && typeof d.auth.ms === 'number' &&
    !!d.key_hex && !!d.framed_hex && d.challenge_prefix_ok === true, d);
  check('the log never carried credentials in the first place',
    !/test-password|test-api-key/.test(JSON.stringify(d)) && !(d.auth.account_keys || []).some(k => /jwt|token|password|secret/i.test(k)),
    d.auth.account_keys);

  // ---- 3. the failure path is where the sensitive text lives ----
  routes[UNLOCK_URL] = { status: 403, body: JSON.stringify({ error: SECRET_SNIPPET }) };
  captureLogs(true);
  res = mkRes();
  await handler(mkReq({ challenge: CHALLENGE, session: 'sess-3' }), res);
  captureLogs(false);
  check('an upstream rejection returns a user-facing message only',
    res._status === 502 && Object.keys(res._body).join(',') === 'error' && /Echelon returned 403/.test(res._body.error), res._body);
  check('Echelon\'s own response body does NOT reach the browser',
    !JSON.stringify(res._body).includes('greg@example.com'), res._body);
  check('...but it is in the server log, where it is useful',
    JSON.stringify(lastDiag()).includes(SECRET_SNIPPET), lastDiag() && lastDiag().echelon);

  // ---- 4. a proxy-side exception ----
  routes[UNLOCK_URL] = { status: 200, body: 'not json at all' };
  res = mkRes();
  await handler(mkReq({ challenge: CHALLENGE, session: 'sess-4' }), res);
  check('an unparseable upstream body returns only a message',
    Object.keys(res._body).join(',') === 'error', res._body);

  // ---- 5. an unconfigured deployment must not describe itself to the client ----
  delete process.env.ECHELON_AUTH_URL;
  delete process.env.ECHELON_UNLOCK_URL;
  delete process.env.ECHELON_API_KEY;
  delete process.env.ECHELON_EMAIL;
  delete process.env.ECHELON_PASSWORD;
  const { default: bare } = await import(MOD + '?unconfigured');
  captureLogs(true);
  res = mkRes();
  await bare(mkReq({ challenge: CHALLENGE, session: 'sess-5' }), res);
  captureLogs(false);
  check('unconfigured → only an error message to the client',
    !!res._body && Object.keys(res._body).join(',') === 'error', res._body);
  check('...and the reason is in the log', lastDiag() && lastDiag().outcome === 'not_configured', lastDiag());

  console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log = realLog; console.error('CRASH', e); process.exit(2); });
