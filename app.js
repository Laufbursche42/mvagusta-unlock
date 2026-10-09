'use strict';
/*
 * MV Agusta (MV Ride) Tuning - Web Bluetooth. Implements the BLE protocols proven from com.mvagusta.mvride.
 * The app is a multi-vehicle companion: THREE independent BLE profiles selected by vehicle family, all
 * recovered from the app (Polidea RxAndroidBle2, no .so/Hermes/Flutter). This page probes all three and adapts.
 * Proven (app_side, code-verified):
 *   (A) MOTORCYCLE (BIKE): service 3719, write 2345, notify 1234. Text frame CR+seg(RS-joined)+CR, NO checksum.
 *       Binary dashboard commands ride inside a GUI1 text frame: GUI1 + hex([header][param][value]).
 *       Riding-mode registers (ABS 0x8A, quick-shift 0x87, traction 0x8B, front-lift 0x8E, ...) are accepted
 *       by the dashboard while it is in CUSTOM mode. There is NO speed/region/derestrict register.
 *   (B) E-BIKE (EBIKE): service FFE0, notify FFD1 (write FFE2 declared but NO command implemented - read-only).
 *       ASCII-header binary telemetry frames ($b$Z# battery, $m$Z# motor, $j$Z# EBM). Telemetry only.
 *   (C) KICKSCOOTER: service 1760F740, write 1760F741, notify 1760F744. ASCII AT-style '<CMD>=<val>' / '<CMD>=?'.
 *       Commands +MODE (assist 0-3), +CRZE (cruise), +LOCK (immobilizer), +HLGT (light). Response state = byte[6].
 * Auth: no app-level crypto/PIN. Motorcycle uses the phone's classic Bluetooth bonding, not an app PIN.
 * Writes are gated, the risky ones confirm-boxed; an echo only means "accepted" - live telemetry proves effect.
 */

// Pre-commit cache-buster auto-bumps BUILD and every ?v= on any web-asset change.
const BUILD = 'v6';

// --------------------------- UUIDs (BleService.java:327-332, BluetoothService.java:560-562; lowercase for Web BT) ---------------------------
const U = {
  // (A) motorcycles (VehicleSelectionType.BIKE)
  BIKE_SVC:    '00003719-0000-1000-8000-00805f9b34fb',
  BIKE_WRITE:  '00002345-0000-1000-8000-00805f9b34fb',
  BIKE_NOTIFY: '00001234-0000-1000-8000-00805f9b34fb',
  // (B) e-bikes (EBIKE) - telemetry only
  EBIKE_SVC:   '0000ffe0-0000-1000-8000-00805f9b34fb',
  EBIKE_NOTIFY:'0000ffd1-0000-1000-8000-00805f9b34fb',
  EBIKE_WRITE: '0000ffe2-0000-1000-8000-00805f9b34fb',
  // (C) kickscooter (KICKSCOOTER)
  KICK_SVC:    '1760f740-7c9e-11eb-9439-0002a5d5c51b',
  KICK_WRITE:  '1760f741-7c9e-11eb-9439-0002a5d5c51b',
  KICK_NOTIFY: '1760f744-7c9e-11eb-9439-0002a5d5c51b'
};
// one probe list covering all three families; connect auto-detects which one the device offers
const CANDIDATE_SERVICES = [U.BIKE_SVC, U.EBIKE_SVC, U.KICK_SVC];
const PROFILES = {
  bike:  { svc: U.BIKE_SVC,  notify: U.BIKE_NOTIFY,  write: U.BIKE_WRITE },
  ebike: { svc: U.EBIKE_SVC, notify: U.EBIKE_NOTIFY, write: null },        // read-only in the app
  kick:  { svc: U.KICK_SVC,  notify: U.KICK_NOTIFY,  write: U.KICK_WRITE }
};

// --------------------------- helpers ---------------------------
const $ = (id) => document.getElementById(id);
const hex = (arr) => Array.from(arr, b => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(' ');
const short = (u) => String(u).slice(0, 8).toUpperCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LS = { THEME: 'mvagusta_theme', PUBLOG: 'mvagusta_publog' };

let dev = null, server = null, ch = null, writeCh = null, busy = false;
let connected = false;

// live device state, rebuilt from the push frames (tiles read from this)
const S = {
  family: null,
  // e-bike ($b$Z# / $m$Z# / $j$Z#)
  eBatt: null, eAssist: null, eSpeed: null, eOdo: null, eRange: null, eLight: null, eFault: null,
  // kickscooter (+MODE/+CRZE/+LOCK/+HLGT)
  kMode: null, kCruise: null, kLock: null, kLight: null
};
function resetState() { S.family = null; for (const k of Object.keys(S)) if (k !== 'family') S[k] = null; }

// --------------------------- log (eg-unlock redaction pipeline: scrub secrets + anonymize PII) ---------------------------
let logBuffer = [];   // { raw, cls }
let publicLog = true; // anonymize device name/id/MAC on display/copy/save (default on)
let diag = false;     // verbose diagnostics (default off)
function redact(text) {
  let s = String(text);
  if (dev && dev.id) s = s.split(dev.id).join('[redacted-id]');
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[redacted-mac]');
  s = s.replace(/\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi,
    (m, k, sep) => k + sep + '[redacted]');
  s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]');
  return s;
}
// Unconditional secret scrubber, runs at the source before the buffer (independent of the Public Log toggle).
function maskSecrets(text) {
  let s = String(text);
  s = s.replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  s = s.replace(/\b(access[_-]?token|refresh[_-]?token|token|jwt|password|passwd|pwd|secret|code|otp)\b(\s*[:=]\s*)("?)([^\s",}]+)\3/gi,
    (m, k, sep) => k + sep + '***');
  return s;
}
function anonymize(s) {
  if (!publicLog) return String(s).replace(/\x01/g, '');
  return redact(String(s).replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
}
function logLine(cls, text) {
  const safe = '[' + new Date().toTimeString().slice(0, 8) + '] ' + maskSecrets(text);
  logBuffer.push({ raw: safe, cls: cls });
  const el = $('log'); if (!el) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = anonymize(safe) + '\n';
  el.appendChild(span); el.scrollTop = el.scrollHeight;
}
function renderLog() {
  const el = $('log'); if (!el) return;
  el.textContent = '';
  for (const e of logBuffer) { const span = document.createElement('span'); if (e.cls) span.className = e.cls; span.textContent = anonymize(e.raw) + '\n'; el.appendChild(span); }
  el.scrollTop = el.scrollHeight;
}
function logText() { return logBuffer.map(e => anonymize(e.raw)).join('\n'); }
const txChan = () => writeCh ? short(writeCh.uuid) : '?';
const rxChan = () => ch ? short(ch.uuid) : '?';
const logTx = (b) => logLine('log-tx', '>>> ' + txChan() + ' | ' + hex(b));
const logRx = (b) => logLine('log-rx', '<<< ' + rxChan() + ' | ' + hex(b));
const logSys = (t) => logLine('', '--- ' + t);
const logErr = (t) => logLine('log-err', '!!! ' + t);
const logDiag = (t) => { if (diag) logLine('', '... ' + t); };
// CRLF on Windows so the copied log pastes cleanly into Notepad (nv osNewline polish).
function osNewline() { return (navigator.platform || '').toLowerCase().indexOf('win') === 0 ? '\r\n' : '\n'; }
function saveLog() {
  try {
    const blob = new Blob([logText().split('\n').join(osNewline())], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'laufbursche42-mvagusta-log.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logSys('log saved');
  } catch (e) { logErr('save failed: ' + (e && e.message ? e.message : e)); }
}
function logDiagnosticHeader() {
  logLine('', '=== mvagusta-unlock diagnostic ===');
  logLine('', 'build: ' + BUILD);
  logLine('', 'time: ' + new Date().toISOString());
  logLine('', 'userAgent: ' + (navigator.userAgent || '?'));
  logLine('', 'platform: ' + (navigator.platform || '?'));
  logLine('', 'webBluetooth: ' + (navigator.bluetooth ? 'yes' : 'no'));
  logLine('', 'protocol self-test: ' + (FRAME_OK ? 'OK' : 'FAILED'));
  logLine('', '================================');
}

// =========================================================================================
//  VERIFIED PROTOCOL CORE (code-proven from com.mvagusta.mvride; self-test below runs at load)
// =========================================================================================
// THREE transports, NONE checksummed:
//   bike  : CommandDataPacket text frame = CR(0x0D) + seg0 + RS(0x1E) + seg1 + RS + ... + CR
//           (CommandDataPacket.java:14-39). Binary dashboard command = GUI1 wrapper holding
//           toHex([Header opcode][param][value]) (BluetoothService.java:1255).
//   ebike : ASCII 5-char header + fixed binary telemetry; parsed, never written (read-only).
//   kick  : ASCII AT text '<CMD>=<value>' UTF-8 (KickscooterCommandDataPacket.java:26-39); query '<CMD>=?'.
const CR = 0x0d, RS = 0x1e;
const strBytes = (s) => Array.from(String(s), c => c.charCodeAt(0) & 0xff);
const asciiOf = (bytes) => Array.from(bytes, b => String.fromCharCode(b & 0xff)).join('');
const be16 = (b, i) => ((b[i] & 0xff) << 8) | (b[i + 1] & 0xff);
const be32 = (b, i) => (((b[i] & 0xff) * 0x1000000) + ((b[i + 1] & 0xff) << 16) + ((b[i + 2] & 0xff) << 8) + (b[i + 3] & 0xff)) >>> 0;

// -- bike text frame + GUI1 binary wrapper --
function buildBikeFrame(segments) {
  const out = [CR];
  segments.forEach((seg, i) => { if (i) out.push(RS); for (const b of strBytes(seg)) out.push(b); });
  out.push(CR);
  return out;
}
const toHexPayload = (bytes) => bytes.map(b => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join('');
function buildBikeGui1(payload) { return buildBikeFrame(['GUI1', toHexPayload(payload)]); }
// Header opcodes (models/Header.java). payload bytes = [opcode][param][value].
const H = { CUSTOM_MAP: 0x86, QUICK_SHIFT: 0x87, ABS: 0x8a, TRACTION: 0x8b, ENGINE_BRAKE: 0x8c, FRONT_LIFT: 0x8e, SUSPENSION_TV: 0x9b };
// ABS (0x8A) param 16: value 1=NORMAL, 2=RACE (Abs.java:12-13, sendRidingMode$1$3:248)
function bikeAbs(value) { return buildBikeGui1([H.ABS, 16, value & 0xff]); }
// QUICK_SHIFT (0x87) param 2: value 0=off, 1=up, 0x11=up+down (sendRidingMode$1$3:245, :1327)
function bikeQuickShift(value) { return buildBikeGui1([H.QUICK_SHIFT, 2, value & 0xff]); }
// TRACTION_CONTROL (0x8B) param 16: value = TC level int (sendRidingMode$1$3:255)
function bikeTraction(level) { return buildBikeGui1([H.TRACTION, 16, level & 0xff]); }
// FRONT_LIFT_CONTROL (0x8E) param 2: value = ordinal 0=OFF, 1=ACTIVATED (sendRidingMode$1$3:259, FrontLiftControl)
function bikeFrontLift(ordinal) { return buildBikeGui1([H.FRONT_LIFT, 2, ordinal & 0xff]); }
// CUSTOM_MAP (0x86) engine-tuning params, value = enum ordinal (sendRidingMode$1$3:213-236)
function bikeGasSensitivity(ord) { return buildBikeGui1([H.CUSTOM_MAP, 16, ord & 0xff]); } // param 0x10 - GasSensitivity NORMAL/LOW/HIGH
function bikeMaxTorque(ord)      { return buildBikeGui1([H.CUSTOM_MAP, 17, ord & 0xff]); } // param 0x11 - MaxTorqueEngine FULL/LOW/MEDIUM
function bikeEngineResponse(ord) { return buildBikeGui1([H.CUSTOM_MAP, 19, ord & 0xff]); } // param 0x13 - EngineResponse FAST/SLOW
function bikeRpmLimiter(ord)     { return buildBikeGui1([H.CUSTOM_MAP, 20, ord & 0xff]); } // param 0x14 - RpmLimiter SOFT/HARD
// generic engine-level GUI1: [opcode][param][value]
function bikeGui1Raw(opcode, param, value) { return buildBikeGui1([opcode & 0xff, param & 0xff, value & 0xff]); }

// -- kickscooter AT frame --
function buildKickCmd(cmd, value) { return strBytes(cmd + '=' + value); }

// RX opcode/label map for the all-frames viewer (keyed by the string label of each transport)
const OPCODE_LABEL = {
  '$b$Z#': 'battery', '$m$Z#': 'motor', '$j$Z#': 'EBM',
  '+MODE': 'assist', '+CRZE': 'cruise', '+LOCK': 'lock', '+HLGT': 'light',
  'GUI1': 'dashboard cmd', 'HELLO': 'handshake', 'VER': 'firmware'
};

// load-time self-test: builders must match hand-computed byte vectors. No checksum exists, so FRAME_OK
// asserts the real transport byte strings instead (bike GUI1 text frame + kickscooter AT line).
const FRAME_OK = (function () {
  const eq = (a, b) => a.length === b.length && a.every((v, i) => (v & 0xff) === (b[i] & 0xff));
  // "+LOCK=0" and "+MODE=?" ASCII
  const t1 = eq(buildKickCmd('+LOCK', 0), [0x2b, 0x4c, 0x4f, 0x43, 0x4b, 0x3d, 0x30]);
  const t2 = eq(buildKickCmd('+MODE', '?'), [0x2b, 0x4d, 0x4f, 0x44, 0x45, 0x3d, 0x3f]);
  // ABS NORMAL -> GUI1 wrapping [8A 10 01]: CR "GUI1" RS "8A1001" CR
  const t3 = eq(bikeAbs(1), [0x0d, 0x47, 0x55, 0x49, 0x31, 0x1e, 0x38, 0x41, 0x31, 0x30, 0x30, 0x31, 0x0d]);
  // QUICK_SHIFT up+down (0x11) -> [87 02 11]: CR "GUI1" RS "870211" CR
  const t4 = eq(bikeQuickShift(0x11), [0x0d, 0x47, 0x55, 0x49, 0x31, 0x1e, 0x38, 0x37, 0x30, 0x32, 0x31, 0x31, 0x0d]);
  // CUSTOM_MAP gas sensitivity HIGH (0x86 param 16 value 2) -> CR "GUI1" RS "861002" CR
  const t5 = eq(bikeGasSensitivity(2), [0x0d, 0x47, 0x55, 0x49, 0x31, 0x1e, 0x38, 0x36, 0x31, 0x30, 0x30, 0x32, 0x0d]);
  return t1 && t2 && t3 && t4 && t5;
})();

// --------------------------- tiles (live-reveal: a tile shows a dash until its value arrives) ---------------------------
const TILE_IDS = ['t-profile', 't-batt', 't-speed', 't-eassist', 't-odo', 't-range', 't-elight', 't-fault', 't-kmode', 't-cruise', 't-lock', 't-klight'];
function setTile(id, val) { const el = $(id); if (el) el.textContent = (val == null ? '-' : val); }
function resetTiles() { TILE_IDS.forEach(id => setTile(id, null)); }
function onOff(v) { return v == null ? null : (v ? t('valOn') : t('valOff')); }
function famLabel(f) { return f ? (t('fam_' + f) || f) : null; }
// assistance mode names (ebike 0-3+87 WALK; kick 0-3) - EBikeDashboardData / KickscooterCommand
function assistLabel(v) {
  if (v == null) return null;
  const map = { 0: t('asNone'), 1: t('asEco'), 2: t('asNormal'), 3: t('asSport'), 87: t('asWalk') };
  return map[v] != null ? map[v] : String(v);
}
function refreshTiles() {
  setTile('t-profile', famLabel(S.family));
  // e-bike ($b$Z# battery byte[7]; $m$Z# assist byte[5] + speed BE[9:10]/10; $j$Z# odo BE[5:8]/10, range BE[9:12]/10, light byte[13], error byte[14])
  setTile('t-batt', S.eBatt == null ? null : S.eBatt + ' %');
  setTile('t-speed', S.eSpeed == null ? null : S.eSpeed + ' km/h');
  setTile('t-eassist', assistLabel(S.eAssist));
  setTile('t-odo', S.eOdo == null ? null : S.eOdo + ' km');
  setTile('t-range', S.eRange == null ? null : S.eRange + ' km');
  setTile('t-elight', onOff(S.eLight));
  setTile('t-fault', S.eFault == null ? null : (S.eFault === 0 ? t('valNone') : 'code ' + S.eFault));
  // kickscooter (+MODE/+CRZE/+LOCK/+HLGT; state from response byte[6] '0'..'3')
  setTile('t-kmode', assistLabel(S.kMode));
  setTile('t-cruise', onOff(S.kCruise));
  setTile('t-lock', S.kLock == null ? null : (S.kLock ? t('valLocked') : t('valOpen')));
  setTile('t-klight', onOff(S.kLight));
}

// --------------------------- all-frames decode (keyed by transport label) ---------------------------
const seenFrames = {};   // label -> last frame bytes
function renderAllFrames() {
  const box = $('all-frames'); if (!box) return;
  box.textContent = '';
  for (const k of Object.keys(seenFrames).sort()) {
    const row = document.createElement('div'); row.className = 'fr-row';
    const a = document.createElement('span'); a.className = 'fr-op'; a.textContent = k;
    const l = document.createElement('span'); l.className = 'fr-label'; l.textContent = OPCODE_LABEL[k] || '';
    const v = document.createElement('span'); v.className = 'fr-val'; v.textContent = hex(seenFrames[k]);
    row.appendChild(a); row.appendChild(l); row.appendChild(v); box.appendChild(row);
  }
}

// --------------------------- i18n ---------------------------
let lang = 'de';
function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => { const v = t(n.getAttribute('data-t')); if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v; }); // scan-ok: curated i18n values with markup (banner/disclaimer links); own table, not user input
  document.querySelectorAll('[data-t-ph]').forEach(n => { const v = t(n.getAttribute('data-t-ph')); if (v) n.setAttribute('placeholder', v); });
  ['GUIDE', 'README', 'LICENSE', 'PRIVACY', 'TRADEMARKS'].forEach(name => { const el = $('link-' + name.toLowerCase()); if (el) el.href = docFile(name); });
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  refreshTiles(); renderAllFrames(); revealForFamily();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light'; const el = $('btn-theme'); if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
}
function initLangSwitch() { document.querySelectorAll('#langs button').forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); })); }

// --------------------------- theme ---------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) { b.textContent = dark ? '\u2600' : '\u263E'; b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label'); }
  try { localStorage.setItem(LS.THEME, dark ? 'dark' : 'light'); } catch (e) {}
}
function initTheme() {
  let saved = null; try { saved = localStorage.getItem(LS.THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme'); if (b) b.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light'));
}

// --------------------------- status ---------------------------
function statusLabel(s) {
  const map = { disconnected: 'stDisconnected', connecting: 'stConnecting', linking: 'stLinking', connected: 'stConnected', 'no-service': 'stNoService' };
  return t(map[s] || 'stDisconnected') || s;
}
function setStatus(s) {
  const el = $('status'); if (el) { el.dataset.state = s; el.textContent = statusLabel(s); }
  const cb = $('btn-conn');
  if (cb) { const on = (s === 'connecting' || s === 'linking' || s === 'connected'); cb.textContent = on ? t('btnDisconnect') : t('btnConnect'); cb.dataset.act = on ? 'disconnect' : 'connect'; }
}
// reveal only the cards/rows that fit the detected family (live for all; settings/engine for bike+kick)
function revealForFamily() {
  const fam = S.family, on = connected;
  // uniform shell: on connect un-hide exactly these cards; family-specific sub-rows below stay gated
  ['live-card', 'batt-card', 'more-card', 'raw-card'].forEach(id => { const el = $(id); if (el) el.hidden = !on; });
  document.querySelectorAll('.set-row[data-family]').forEach(r => { r.hidden = !(on && r.getAttribute('data-family') === fam); });
  { const h = $('grp-kick-h'); if (h) h.hidden = !(on && fam === 'kick'); }
  { const h = $('grp-bike-h'); if (h) h.hidden = !(on && fam === 'bike'); }
  { const b = $('build-sub'); if (b) b.hidden = !(on && fam === 'bike'); }
}
function setControlsEnabled(on) {
  document.querySelectorAll('[data-conn]').forEach(e => { e.disabled = !on; });
  revealForFamily();
}

// --------------------------- connect (acceptAll + multi-profile GATT probe; 4x retry) ---------------------------
async function connect() {
  if (!navigator.bluetooth) { logErr(t('errNoWebBt')); return; }
  try {
    setStatus('connecting');
    const showAll = ($('showall') || {}).checked;
    const opts = showAll
      ? { acceptAllDevices: true, optionalServices: CANDIDATE_SERVICES }
      : { filters: CANDIDATE_SERVICES.map(s => ({ services: [s] })), optionalServices: CANDIDATE_SERVICES };
    dev = await navigator.bluetooth.requestDevice(opts);
    dev.addEventListener('gattserverdisconnected', onDisconnected);
    logSys('device: \x01' + (dev.name || '(no name)') + '\x01');
    setStatus('linking');
    await connectGatt();
    setStatus('connected'); connected = true;
    setControlsEnabled(true);
    { const el = $('devinfo'); if (el) el.textContent = t('devPrefix') + ' \x01' + (dev.name || 'MV Ride') + '\x01' + ' (' + (famLabel(S.family) || '?') + ')'; }
    logSys('connected [' + S.family + '], subscribed to ' + rxChan() + (writeCh ? ', write ' + txChan() : ' (read-only)'));
    if (S.family === 'kick') await guard(syncKick);     // query +MODE/+CRZE/+LOCK/+HLGT
  } catch (e) {
    logErr('connect failed: ' + (e && e.message ? e.message : e));
    connected = false; setStatus('disconnected'); setControlsEnabled(false);
  }
}
// tolerate the Android discovery race (nv 4x retry): service can be briefly absent right after link.
async function connectGatt() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      server = await dev.gatt.connect();
      const picked = await resolveProfile(server);
      if (!picked) { setStatus('no-service'); throw new Error('no MV Ride service found (bike/ebike/kick)'); }
      S.family = picked.family; ch = picked.notifyCh; writeCh = picked.writeCh;
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', onCharValue);
      return;
    } catch (e) {
      lastErr = e; logDiag('connect attempt ' + attempt + ' failed: ' + (e && e.message ? e.message : e));
      try { if (dev.gatt.connected) dev.gatt.disconnect(); } catch (_) {}
      await sleep(400);
    }
  }
  throw lastErr || new Error('gatt connect failed');
}
// probe the three families in order; the first service that resolves wins and sets the transport
async function resolveProfile(srv) {
  for (const family of ['bike', 'ebike', 'kick']) {
    const p = PROFILES[family];
    try {
      const svc = await srv.getPrimaryService(p.svc);
      const notifyCh = await svc.getCharacteristic(p.notify);
      let wch = null;
      if (p.write) { try { wch = await svc.getCharacteristic(p.write); } catch (_) {} }
      return { family, svc, notifyCh, writeCh: wch };
    } catch (_) {}
  }
  return null;
}
function onDisconnected() {
  connected = false; ch = null; writeCh = null; setStatus('disconnected'); setControlsEnabled(false);
  resetState(); resetTiles(); clearAcks(); for (const k of Object.keys(seenFrames)) delete seenFrames[k];
  renderAllFrames();
  const el = $('devinfo'); if (el) el.textContent = '';
  logSys('disconnected');
}
function disconnect() { if (dev && dev.gatt.connected) dev.gatt.disconnect(); }

// --------------------------- notify (per-family parsers) + ACK ---------------------------
let rxBuf = [];
function onCharValue(ev) {
  const b = Array.from(new Uint8Array(ev.target.value.buffer));
  logRx(b);
  if (S.family === 'bike') handleBikeBytes(b);
  else if (S.family === 'ebike') handleEbikeFrame(b);
  else if (S.family === 'kick') handleKickFrame(b);
}
// bike: reassemble CR(0x0D)-wrapped records, split segments on RS(0x1E). The raw records are surfaced in the
// all-frames viewer keyed by their text label.
function handleBikeBytes(b) {
  for (const x of b) rxBuf.push(x);
  while (true) {
    const first = rxBuf.indexOf(CR);
    if (first < 0) { if (rxBuf.length > 512) rxBuf = []; break; }
    const second = rxBuf.indexOf(CR, first + 1);
    if (second < 0) { if (first > 0) rxBuf = rxBuf.slice(first); break; }
    const rec = rxBuf.slice(first + 1, second); rxBuf = rxBuf.slice(second);
    if (rec.length) handleBikeRecord(rec);
  }
}
function handleBikeRecord(rec) {
  const segs = []; let cur = [];
  for (const x of rec) { if (x === RS) { segs.push(cur); cur = []; } else cur.push(x); }
  segs.push(cur);
  const label = asciiOf(segs[0]).replace(/[^\x20-\x7e]/g, '') || 'frame';
  seenFrames[label] = rec;
  resolveAck('rx'); renderAllFrames();
}
// e-bike telemetry (EBikeDataPacket.java offsets; all bounds-checked, read-only)
function handleEbikeFrame(b) {
  const tag = asciiOf(b.slice(0, 5));
  seenFrames[tag] = b;
  if (tag === '$b$Z#') { if (b.length > 7) S.eBatt = b[7] & 0xff; }
  else if (tag === '$m$Z#') { if (b.length > 5) S.eAssist = b[5] & 0xff; if (b.length > 10) S.eSpeed = +(be16(b, 9) / 10).toFixed(1); }
  else if (tag === '$j$Z#') { if (b.length > 8) S.eOdo = +(be32(b, 5) / 10).toFixed(1); if (b.length > 12) S.eRange = +(be32(b, 9) / 10).toFixed(1); if (b.length > 13) S.eLight = (b[13] & 0xff) !== 0; if (b.length > 14) S.eFault = b[14] & 0xff; }
  resolveAck('rx'); refreshTiles(); renderAllFrames();
}
// kickscooter: ASCII echo of the command; state value read from byte[6] ('0'..'3') (KickscooterDataPacket.java:41)
function handleKickFrame(b) {
  const str = asciiOf(b);
  let cmd = null;
  for (const c of ['+MODE', '+CRZE', '+LOCK', '+HLGT']) if (str.indexOf(c) >= 0) { cmd = c; break; }
  seenFrames[cmd || 'frame'] = b;
  const v = (b.length > 6) ? ((b[6] & 0xff) - 0x30) : null;
  if (v != null && v >= 0 && v <= 9) {
    if (cmd === '+MODE') S.kMode = v;
    else if (cmd === '+CRZE') S.kCruise = v !== 0;
    else if (cmd === '+LOCK') S.kLock = v !== 0;
    else if (cmd === '+HLGT') S.kLight = v !== 0;
  }
  resolveAck('rx'); refreshTiles(); renderAllFrames(); syncKickSelects();
}
const pendingAcks = new Map();
const ACK_TIMEOUT_MS = 3000;
function armAck(key, label) {
  clearAckTimer(key);
  const timer = setTimeout(() => { pendingAcks.delete(key); logSys(label + ': ' + t('ackNone')); }, ACK_TIMEOUT_MS);
  pendingAcks.set(key, { timer, label });
}
function resolveAck(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); logSys(a.label + ': ' + t('ackOk')); } }
function clearAckTimer(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); } }
function clearAcks() { for (const a of pendingAcks.values()) clearTimeout(a.timer); pendingAcks.clear(); }

// --------------------------- transmit (single funnel: log TX, arm ack, write) ---------------------------
async function writeFrame(bytes) {
  if (!writeCh) throw new Error(t('errReadOnly'));
  const arr = Uint8Array.from(bytes);
  if (writeCh.properties.write) return writeCh.writeValueWithResponse(arr);
  if (writeCh.properties.writeWithoutResponse) return writeCh.writeValueWithoutResponse(arr);
  return writeCh.writeValue(arr);
}
async function transmit(bytes, label, ackKey) {
  if (!connected || !ch) { logErr(t('errNotConnected')); return; }
  logTx(bytes);
  if (ackKey) armAck(ackKey, label);
  try { await writeFrame(bytes); logSys(label + ': ' + t('txSent')); }
  catch (e) { clearAckTimer(ackKey); logErr(label + ' ' + t('txFailed') + ': ' + (e && e.message ? e.message : e)); }
}
// serialize writes on the single characteristic (eg guard mutex; vr/ap/vmax omit it)
async function guard(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { logErr(e && e.message ? e.message : String(e)); } finally { busy = false; } }

// --------------------------- commands ---------------------------
async function setKick(cmd, value, label) { await transmit(buildKickCmd(cmd, value), label || cmd, 'rx'); }
async function sendBike(bytes, label) { await transmit(bytes, label, 'rx'); }
async function syncKick() { for (const c of ['+MODE', '+CRZE', '+LOCK', '+HLGT']) { await setKick(c, '?', t('syncLabel') + ' ' + c); await sleep(140); } }
function syncKickSelects() {
  const set = (id, val) => { const el = $(id); if (el && document.activeElement !== el && val != null) el.value = String(val); };
  if (S.kMode != null && S.kMode <= 3) set('sel-assist', S.kMode);
  if (S.kCruise != null) set('sel-cruise', S.kCruise ? 1 : 0);
  if (S.kLight != null) set('sel-klight', S.kLight ? 1 : 0);
  if (S.kLock != null) set('sel-lock', S.kLock ? 1 : 0);
}

// --------------------------- engine-level raw tools ---------------------------
function hexToBytes(s) {
  const clean = String(s).replace(/[^0-9a-fA-F]/g, '');
  const out = []; for (let i = 0; i + 2 <= clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}
async function cmdRaw() {
  const bytes = hexToBytes(($('raw-in') || {}).value || '');
  if (!bytes.length) { logErr(t('errNoBytes')); return; }
  await transmit(bytes, t('rawLabel'), 'rx');
}
async function cmdFree() {
  const str = (($('free-in') || {}).value || '').trim();
  if (!str) { logErr(t('errNoText')); return; }
  await transmit(strBytes(str), t('freeLabel') + ' ' + str, 'rx');
}
async function cmdBuild() {
  if (S.family !== 'bike') { logErr(t('errBuildBike')); return; }
  const op = parseInt((($('build-op-in') || {}).value || '').replace(/[^0-9a-fA-F]/g, ''), 16);
  const param = parseInt(($('build-param-in') || {}).value, 10);
  const val = parseInt(($('build-val-in') || {}).value, 10);
  if (isNaN(op) || isNaN(param) || isNaN(val)) { logErr(t('errNoBytes')); return; }
  await sendBike(bikeGui1Raw(op, param, val), t('engineBuild') + ' ' + op.toString(16).toUpperCase() + '/' + param + '/' + val);
}

// --------------------------- confirm dialog (themed; window.confirm fallback) ---------------------------
function confirmRisky(msg) {
  return new Promise(resolve => {
    const dlg = $('confirm'); const body = $('confirm-body');
    if (!dlg || !dlg.showModal) { resolve(window.confirm(msg)); return; }
    if (body) body.textContent = msg;
    const ok = $('confirm-ok'), cancel = $('confirm-x'), no = $('confirm-no');
    const done = (v) => { dlg.close(); ok.removeEventListener('click', onOk); if (no) no.removeEventListener('click', onNo); if (cancel) cancel.removeEventListener('click', onNo); resolve(v); };
    const onOk = () => done(true), onNo = () => done(false);
    ok.addEventListener('click', onOk); if (no) no.addEventListener('click', onNo); if (cancel) cancel.addEventListener('click', onNo);
    dlg.showModal();
  });
}

// --------------------------- doc viewer (markdown of our own docs) ---------------------------
const DOC_TITLES = { 'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide', 'README.md': 'footReadme', 'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense', 'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy', 'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks', 'DISCLAIMER.de.md': 'footDisclaimer', 'DISCLAIMER.md': 'footDisclaimer' };
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const esc = escHtml;
const slug = s => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
function docFile(name) { if (name === 'README') return 'README.md'; if (name === 'GUIDE') return 'GUIDE.' + lang + '.md'; return name + (lang === 'de' ? '.de.md' : '.md'); }
// inlineMd receives ALREADY-escaped text (mdToHtml escapes first); DOC_TITLES hrefs stay in-modal.
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, href) {
      if (DOC_TITLES[href]) return '<a href="' + href + '" data-docfile="' + href + '">' + text + '</a>';
      return '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
    });
}
function mdToHtml(md) {
  var codeBlocks = [];
  // 1) pull fenced code blocks out first so their content is never treated as markdown
  md = String(md).replace(/```[^\n]*\n?([\s\S]*?)```/g, function (m, code) {
    var i = codeBlocks.length;
    codeBlocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
    return '\x00CB' + i + '\x00';
  });
  var lines = md.split(/\r?\n/);
  var out = [], para = [], list = null;
  function flushPara() { if (para.length) { out.push('<p>' + inlineMd(esc(para.join(' '))) + '</p>'); para = []; } }
  function flushList() { if (list) { out.push('<' + list.type + '>' + list.items.join('') + '</' + list.type + '>'); list = null; } }
  function isTableSep(s) { var tt = s.replace(/\s/g, ''); return /^\|?:?-+:?(\|:?-+:?)+\|?$/.test(tt); }
  function splitRow(s) { return s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var cb = ln.match(/^\x00CB(\d+)\x00$/);
    if (cb) { flushPara(); flushList(); out.push(codeBlocks[Number(cb[1])]); continue; }
    if (/^\s*$/.test(ln)) { flushPara(); flushList(); continue; }
    var h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); var lvl = Math.min(h[1].length, 4); out.push('<h' + lvl + '>' + inlineMd(esc(h[2])) + '</h' + lvl + '>'); continue; }
    if (/^---+$/.test(ln.trim())) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if (ln.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {   // GFM table: header, |---| sep, rows
      flushPara(); flushList();
      var head = splitRow(ln); i++;   // consume the separator row
      var body = '';
      while (i + 1 < lines.length && lines[i + 1].indexOf('|') >= 0 && lines[i + 1].trim() !== '') {
        body += '<tr>' + splitRow(lines[++i]).map(function (c) { return '<td>' + inlineMd(esc(c)) + '</td>'; }).join('') + '</tr>';
      }
      out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + inlineMd(esc(c)) + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table>');
      continue;
    }
    if (/^\s*>/.test(ln)) {                             // merge consecutive > lines into ONE callout
      flushPara(); flushList();
      var q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      i--;                                              // step back; the for-loop re-increments
      while (q.length && /^\s*$/.test(q[0])) q.shift();
      while (q.length && /^\s*$/.test(q[q.length - 1])) q.pop();
      if (q.length) out.push('<blockquote>' + mdToHtml(q.join('\n')) + '</blockquote>');  // inner rendered as markdown
      continue;
    }
    var ul = ln.match(/^\s*[-*]\s+(.*)$/);
    var ol = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      var type = ul ? 'ul' : 'ol';
      if (!list || list.type !== type) { flushList(); list = { type: type, items: [] }; }
      list.items.push('<li>' + inlineMd(esc((ul ? ul[1] : ol[1]))) + '</li>');
      continue;
    }
    para.push(ln.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}
const docCache = {};
async function openDocFile(file) {
  const dlg = $('doc'); const titleEl = $('doc-title'); const bodyEl = $('doc-body');
  titleEl.textContent = t(DOC_TITLES[file] || 'footReadme');
  if (lang === 'de' && /\.md$/.test(file) && !/\.de\.md$/.test(file) && file !== 'README.md') titleEl.textContent += ' (englisch)';
  try { if (!docCache[file]) { const r = await fetch(file); docCache[file] = await r.text(); } bodyEl.innerHTML = mdToHtml(docCache[file]); } // scan-ok: own in-repo markdown rendered via mdToHtml; not user input
  catch (e) { bodyEl.textContent = 'Could not load ' + file; }
  if (dlg.showModal) dlg.showModal();
}
function wireDocViewer() {
  document.addEventListener('click', e => {
    const d = e.target.closest('a[data-doc]'); if (d) { e.preventDefault(); openDocFile(docFile(d.getAttribute('data-doc'))); return; }
    const df = e.target.closest('a[data-docfile]'); if (df) { e.preventDefault(); openDocFile(df.getAttribute('data-docfile')); return; }
    const disc = e.target.closest('[data-open-disclaimer]'); if (disc) { e.preventDefault(); openDocFile(docFile('DISCLAIMER')); return; }
  });
  ['doc-x', 'doc-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => $('doc').close()); });
}

// --------------------------- help modal ---------------------------
function openHelp(key) { openHelpText(t('help_' + key + '_t'), t('help_' + key + '_b')); }
function openHelpText(title, body) {
  const dlg = $('help'); $('help-title').textContent = title || ''; const b = $('help-body'); if (/[<&]/.test(body || '')) b.innerHTML = body; else b.textContent = body || ''; // scan-ok: curated i18n help text; own table, not user input
  if (dlg.showModal) dlg.showModal();
}
function closeHelp() { const d = $('help'); if (d) d.close(); }

// --------------------------- init ---------------------------
window.addEventListener('DOMContentLoaded', () => {
  initLangSwitch(); initTheme(); wireDocViewer();
  applyLang(); setStatus('disconnected'); resetTiles();
  logDiagnosticHeader();
  if (!FRAME_OK) logErr('protocol self-test FAILED - builders do not match known vectors; do not trust writes');

  $('btn-conn').addEventListener('click', () => { if ($('btn-conn').dataset.act === 'disconnect') disconnect(); else guard(connect); });

  // kickscooter settings rows (+MODE/+CRZE/+HLGT and the +LOCK immobilizer)
  { const b = $('btn-assist'); if (b) b.addEventListener('click', () => guard(() => setKick('+MODE', parseInt(($('sel-assist') || {}).value, 10) || 0, t('setAssist')))); }
  { const b = $('btn-cruise'); if (b) b.addEventListener('click', () => guard(() => setKick('+CRZE', (($('sel-cruise') || {}).value === '1') ? 1 : 0, t('setCruise')))); }
  { const b = $('btn-klight'); if (b) b.addEventListener('click', () => guard(() => setKick('+HLGT', (($('sel-klight') || {}).value === '1') ? 1 : 0, t('setLight')))); }
  { const b = $('btn-lock'); if (b) b.addEventListener('click', () => guard(async () => {
    const on = (($('sel-lock') || {}).value === '1');
    if (!await confirmRisky(t(on ? 'warnLock' : 'warnUnlock'))) return;
    await setKick('+LOCK', on ? 1 : 0, t('setLock'));
  })); }

  // motorcycle CUSTOM ride-mode parameters (GUI1 wrapper) - confirm-gated
  { const b = $('btn-abs'); if (b) b.addEventListener('click', () => guard(async () => { if (!await confirmRisky(t('warnBikeCustom'))) return; await sendBike(bikeAbs((parseInt(($('sel-abs') || {}).value, 10) || 0) + 1), t('setAbs')); })); }
  { const b = $('btn-quickshift'); if (b) b.addEventListener('click', () => guard(async () => { if (!await confirmRisky(t('warnBikeCustom'))) return; await sendBike(bikeQuickShift([0, 1, 0x11][parseInt(($('sel-quickshift') || {}).value, 10) || 0]), t('setQuickShift')); })); }
  { const b = $('btn-traction'); if (b) b.addEventListener('click', () => guard(async () => { if (!await confirmRisky(t('warnBikeCustom'))) return; await sendBike(bikeTraction(parseInt(($('traction-in') || {}).value, 10) || 0), t('setTraction')); })); }
  { const b = $('btn-frontlift'); if (b) b.addEventListener('click', () => guard(async () => { if (!await confirmRisky(t('warnBikeCustom'))) return; await sendBike(bikeFrontLift(parseInt(($('sel-frontlift') || {}).value, 10) || 0), t('setFrontLift')); })); }
  { const b = $('btn-gas'); if (b) b.addEventListener('click', () => guard(async () => { if (!await confirmRisky(t('warnBikeCustom'))) return; await sendBike(bikeGasSensitivity(parseInt(($('sel-gas') || {}).value, 10) || 0), t('setGas')); })); }
  { const b = $('btn-torque'); if (b) b.addEventListener('click', () => guard(async () => { if (!await confirmRisky(t('warnBikeCustom'))) return; await sendBike(bikeMaxTorque(parseInt(($('sel-torque') || {}).value, 10) || 0), t('setTorque')); })); }
  { const b = $('btn-engresp'); if (b) b.addEventListener('click', () => guard(async () => { if (!await confirmRisky(t('warnBikeCustom'))) return; await sendBike(bikeEngineResponse(parseInt(($('sel-engresp') || {}).value, 10) || 0), t('setEngResp')); })); }
  { const b = $('btn-rpm'); if (b) b.addEventListener('click', () => guard(async () => { if (!await confirmRisky(t('warnBikeCustom'))) return; await sendBike(bikeRpmLimiter(parseInt(($('sel-rpm') || {}).value, 10) || 0), t('setRpm')); })); }

  // engine level
  { const b = $('btn-build'); if (b) b.addEventListener('click', () => guard(cmdBuild)); }
  { const b = $('btn-raw'); if (b) b.addEventListener('click', () => guard(cmdRaw)); }
  { const b = $('btn-free'); if (b) b.addEventListener('click', () => guard(cmdFree)); }

  document.querySelectorAll('.help-btn[data-help]').forEach(btn => btn.addEventListener('click', () => openHelp(btn.getAttribute('data-help'))));
  ['help-x', 'help-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', closeHelp); });
  { const b = $('link-disclaimer'); if (b) b.addEventListener('click', e => { e.preventDefault(); openDocFile(docFile('DISCLAIMER')); }); }

  { const cb = $('public-log'); if (cb) { let saved = null; try { saved = localStorage.getItem(LS.PUBLOG); } catch (e) {} publicLog = saved !== '0'; cb.checked = publicLog; cb.addEventListener('change', () => { publicLog = cb.checked; try { localStorage.setItem(LS.PUBLOG, cb.checked ? '1' : '0'); } catch (e) {} logSys('public-log: ' + (cb.checked ? 'on (anonymizing device name/id)' : 'off')); renderLog(); }); } }
  { const cb = $('diag-log'); if (cb) { cb.addEventListener('change', () => { diag = cb.checked; logSys('diag-log: ' + (cb.checked ? 'on' : 'off')); }); } }
  { const cb = $('showall'); if (cb) cb.addEventListener('change', () => { logSys('show-all-frames: ' + (cb.checked ? 'on' : 'off')); renderLog(); }); }
  { const b = $('btn-clear-log'); if (b) b.addEventListener('click', () => { logBuffer = []; $('log').textContent = ''; logDiagnosticHeader(); }); }
  { const b = $('btn-copy-log'); if (b) b.addEventListener('click', () => navigator.clipboard.writeText(logText()).then(() => logSys('log copied')).catch(() => {})); }
  { const b = $('btn-save-log'); if (b) b.addEventListener('click', saveLog); }

  setControlsEnabled(false);
});
