<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<meta name="theme-color" content="#0a0a0a">
<title>PedalSync — Diagnostic</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  :root {
    --bg: #0a0a0a; --surface: #111; --border: #2a2a2a;
    --gold: #F2A900; --green: #00E676; --red: #FF3D00;
    --text: #e0e0e0; --text-dim: #666;
    --font-display: 'Barlow Condensed', sans-serif;
    --font-mono: 'JetBrains Mono', monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: var(--font-display); min-height: 100vh; padding: 24px; }
  h1 { font-size: 1.6rem; font-weight: 700; letter-spacing: 0.12em; color: var(--gold); margin-bottom: 4px; }
  .subtitle { font-size: 0.85rem; color: var(--text-dim); margin-bottom: 24px; letter-spacing: 0.05em; }
  .status-box {
    background: var(--surface); border: 1px solid var(--border); padding: 16px;
    margin-bottom: 16px; font-family: var(--font-mono); font-size: 0.85rem;
  }
  .status-label { color: var(--text-dim); font-family: var(--font-display); font-size: 0.75rem;
    letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 4px; }
  .status-value { color: var(--gold); }
  .status-value.connected { color: var(--green); }
  .status-value.error { color: var(--red); }
  .btn {
    background: var(--gold); color: #000; border: none; font-family: var(--font-display);
    font-weight: 700; font-size: 1.1rem; letter-spacing: 0.1em; padding: 16px 32px;
    cursor: pointer; text-transform: uppercase; width: 100%; margin-bottom: 16px;
  }
  .btn:active { transform: scale(0.97); }
  .btn:disabled { background: var(--text-dim); cursor: not-allowed; }
  .btn.disconnect { background: var(--surface); border: 1px solid var(--red); color: var(--red); font-size: 0.85rem; padding: 12px; }
  .log-box {
    background: var(--surface); border: 1px solid var(--border); padding: 12px;
    font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-dim);
    height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
  }
  .log-label { color: var(--text-dim); font-size: 0.75rem; letter-spacing: 0.12em;
    text-transform: uppercase; margin: 16px 0 6px; }
  .log-tx { color: var(--gold); }
  .log-rx { color: var(--green); }
  .log-err { color: var(--red); }
  .log-info { color: var(--text-dim); }
  .counter { display: flex; gap: 12px; margin-bottom: 16px; }
  .counter-item { flex: 1; background: var(--surface); border: 1px solid var(--border);
    padding: 10px; text-align: center; }
  .counter-item .num { font-family: var(--font-mono); font-size: 1.8rem; color: var(--gold); }
  .counter-item .lbl { font-size: 0.7rem; color: var(--text-dim); letter-spacing: 0.1em; text-transform: uppercase; }
  .device-badge {
    font-size: 0.8rem; color: var(--gold); font-family: var(--font-mono);
    margin-bottom: 16px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border);
    display: none;
  }
</style>
</head>
<body>
<h1>PEDALSYNC DIAG</h1>
<div class="subtitle">BLE relay — connect your Echelon device and leave this page open</div>

<div class="status-box">
  <div class="status-label">Connection</div>
  <div class="status-value" id="conn-status">Not connected</div>
</div>

<div class="device-badge" id="device-badge"></div>

<button class="btn" id="btn-connect" onclick="startRelay()">CONNECT TO DEVICE</button>

<div class="counter">
  <div class="counter-item">
    <div class="num" id="cnt-notif">0</div>
    <div class="lbl">Notifications</div>
  </div>
  <div class="counter-item">
    <div class="num" id="cnt-cmds">0</div>
    <div class="lbl">Commands Run</div>
  </div>
  <div class="counter-item">
    <div class="num" id="cnt-errors">0</div>
    <div class="lbl">Errors</div>
  </div>
</div>

<div class="log-label">Activity Log</div>
<div class="log-box" id="log"></div>

<button class="btn disconnect" id="btn-disconnect" onclick="stopRelay()" style="display:none; margin-top:16px;">
  DISCONNECT &amp; STOP RELAY
</button>

<script>
const ECH_SERVICE  = '0bf669f1-45f2-11e7-9598-0800200c9a66';
const ECH_WRITE    = '0bf669f2-45f2-11e7-9598-0800200c9a66';
const ECH_NOTIFY1  = '0bf669f3-45f2-11e7-9598-0800200c9a66';
const ECH_DATA     = '0bf669f4-45f2-11e7-9598-0800200c9a66';

const API = location.origin + '/api/diag';
const BETA_CODE = 'DIAG';
const POLL_INTERVAL = 1500;

let bleDevice = null;
let writeChar = null;
let pollTimer = null;
let notifCount = 0;
let cmdCount = 0;
let errCount = 0;

// Detect equipment type from BLE name
function detectType(name) {
  const n = (name || '').toUpperCase();
  if (n.startsWith('ROW'))    return 'Rower';
  if (n.includes('STRIDE'))   return 'Treadmill';
  if (n.includes('TREAD'))    return 'Treadmill';
  if (n.includes('REFLECT'))  return 'Mirror';
  return 'Bike';
}

function log(msg, cls = 'info') {
  const el = document.getElementById('log');
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = document.createElement('div');
  line.className = 'log-' + cls;
  line.textContent = `[${ts}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setStatus(msg, cls = '') {
  const el = document.getElementById('conn-status');
  el.textContent = msg;
  el.className = 'status-value ' + cls;
}

function updateCounters() {
  document.getElementById('cnt-notif').textContent = notifCount;
  document.getElementById('cnt-cmds').textContent = cmdCount;
  document.getElementById('cnt-errors').textContent = errCount;
}

async function report(type, data) {
  try {
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'report', beta_code: BETA_CODE, type, ...data }),
    });
  } catch(e) { /* silent */ }
}

async function setRemoteStatus(state, device) {
  try {
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_status', beta_code: BETA_CODE, state, bike: device }),
    });
  } catch(e) {}
}

function bytesToHex(arr) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

// ---- BLE notification handler ----
function onData(event) {
  const raw = new Uint8Array(event.target.value.buffer);
  const hex = bytesToHex(raw);
  const handle = event.target.uuid;
  const shortHandle = handle.substring(4, 8).toUpperCase();

  notifCount++;
  updateCounters();
  log(`RX [${shortHandle}] (${raw.length}B) ${hex}`, 'rx');

  report('notification', {
    handle: shortHandle,
    hex,
    bytes: Array.from(raw),
    len: raw.length,
  });
}

// ---- Connect to device ----
async function startRelay() {
  document.getElementById('btn-connect').disabled = true;
  setStatus('Scanning...', '');
  log('Requesting BLE device (bikes, rowers, treadmills)...');

  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'ECH' },
        { namePrefix: 'ROW' },
        { namePrefix: 'STRIDE' },
      ],
      optionalServices: [ECH_SERVICE],
    });

    const devType = detectType(bleDevice.name);
    setStatus(`Found ${bleDevice.name} (${devType}), connecting...`, '');
    log(`Found: ${bleDevice.name} — detected as ${devType}`);

    // Show device badge
    const badge = document.getElementById('device-badge');
    badge.textContent = `${devType}: ${bleDevice.name}`;
    badge.style.display = 'block';

    bleDevice.addEventListener('gattserverdisconnected', () => {
      setStatus('Disconnected', 'error');
      log('BLE disconnected', 'err');
      setRemoteStatus('disconnected', '');
      stopPolling();
    });

    log('Step 1/6: Requesting GATT connection...', 'info');
    const gattStart = Date.now();
    const gattTimeout = setTimeout(() => {
      log('GATT connect TIMEOUT after 15s — the tablet may be holding the connection', 'err');
    }, 15000);
    const server = await bleDevice.gatt.connect();
    clearTimeout(gattTimeout);
    log('Step 2/6: GATT connected in ' + (Date.now() - gattStart) + 'ms. Discovering service...', 'info');

    const service = await server.getPrimaryService(ECH_SERVICE);
    log('Step 3/6: Service found. Getting write characteristic...', 'info');

    writeChar = await service.getCharacteristic(ECH_WRITE);
    log('Step 4/6: Write char (F2) ready. Getting data characteristic...', 'info');

    const dataChar = await service.getCharacteristic(ECH_DATA);
    log('Step 5/6: Data char (F4) ready. Subscribing to notifications...', 'info');

    // Subscribe to F4 (primary data)
    await dataChar.startNotifications();
    dataChar.addEventListener('characteristicvaluechanged', onData);
    log('Step 6/6: F4 notifications active!', 'info');

    // Try F3 (secondary)
    try {
      const notify1 = await service.getCharacteristic(ECH_NOTIFY1);
      await notify1.startNotifications();
      notify1.addEventListener('characteristicvaluechanged', onData);
      log('Subscribed to F3 (secondary)', 'info');
    } catch(e) {
      log('F3 subscribe failed (non-critical): ' + e.message, 'info');
    }

    setStatus(`Connected: ${bleDevice.name} (${devType})`, 'connected');
    log('Connected and listening. Waiting for commands...', 'info');
    setRemoteStatus('connected', bleDevice.name);

    document.getElementById('btn-connect').style.display = 'none';
    document.getElementById('btn-disconnect').style.display = 'block';

    // Start polling for remote commands
    startPolling();

    // Report connection info
    report('info', { note: `Connected to ${bleDevice.name} (${devType})`, hex: '' });

  } catch(err) {
    if (err.name === 'NotFoundError') {
      setStatus('No device selected', '');
      log('User cancelled BLE picker', 'info');
    } else {
      setStatus('Error: ' + err.message, 'error');
      log('Connect error: ' + err.message, 'err');
      errCount++;
      updateCounters();
    }
    document.getElementById('btn-connect').disabled = false;
  }
}

// ---- Command polling ----
function startPolling() {
  pollTimer = setInterval(pollForCommands, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollForCommands() {
  if (!writeChar) return;

  try {
    const resp = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'poll_cmd', beta_code: BETA_CODE }),
    });
    const data = await resp.json();

    if (data.cmd) {
      await executeCommand(data.cmd);
    }
  } catch(e) {
    // Silent — network hiccup during poll
  }
}

async function executeCommand(cmd) {
  const hexStr = cmd.hex.replace(/\s+/g, '');
  const bytes = new Uint8Array(hexStr.match(/.{1,2}/g).map(b => parseInt(b, 16)));

  log(`TX [F2] (${bytes.length}B) ${bytesToHex(bytes)}`, 'tx');
  cmdCount++;
  updateCounters();

  try {
    await writeChar.writeValue(bytes);
    log('Write OK', 'info');
    report('write_result', {
      handle: 'F2',
      hex: bytesToHex(bytes),
      bytes: Array.from(bytes),
      len: bytes.length,
      note: 'write_ok',
    });
  } catch(err) {
    log('Write FAILED: ' + err.message, 'err');
    errCount++;
    updateCounters();
    report('error', {
      hex: bytesToHex(bytes),
      note: 'write_failed: ' + err.message,
    });
  }
}

// ---- Disconnect ----
function stopRelay() {
  stopPolling();
  if (bleDevice && bleDevice.gatt.connected) {
    bleDevice.gatt.disconnect();
  }
  setStatus('Disconnected', '');
  document.getElementById('btn-connect').style.display = 'block';
  document.getElementById('btn-connect').disabled = false;
  document.getElementById('btn-disconnect').style.display = 'none';
}
</script>
</body>
</html>