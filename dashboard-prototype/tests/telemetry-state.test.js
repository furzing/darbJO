const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../telemetry-state.js');
const NOW = Date.parse('2026-10-06T12:00:00Z');

function message(overrides) {
  return Object.assign({
    schema: 'beacon.prototype.v1', type: 'gps_status', hub_uptime_ms: 1000,
    gps_fix: false, gps_state: 'acquiring', gps_reason: 'receiver_no_fix',
    latitude: null, longitude: null, satellites: 0, hdop: null,
    gps_age_ms: null, lora_connected: true, lora_error_code: 0,
    lora_chip_version: 18, last_fix: null
  }, overrides);
}
function acquire(session, at = NOW) {
  T.applyMessage(session, message({
    gps_fix: true, gps_state: 'fixed', gps_reason: 'none',
    latitude: 31.9539, longitude: 35.9106, satellites: 8, hdop: 1.2, gps_age_ms: 250,
    last_fix: { latitude: 31.9539, longitude: 35.9106, satellites: 8, hdop: 1.2,
      source: 'current_session', age_ms: 250, gps_time_utc: '2026-10-06T11:59:59Z' }
  }), at);
}

test('cold acquisition, timeout, and silent UART never fabricate coordinates', () => {
  const s = T.createSession();
  ['starting', 'acquiring', 'acquisition_timeout', 'uart_silent', 'data_error'].forEach((state, i) => {
    T.applyMessage(s, message({ gps_state: state }), NOW + i * 1000);
    assert.equal(s.lastFix, null);
    assert.equal(s.latest.gps_fix, false);
  });
});
test('valid position and its quality details survive reception loss and USB loss', () => {
  const s = T.createSession();
  acquire(s);
  const fix = structuredClone(s.lastFix);
  T.applyMessage(s, message({ gps_state: 'fix_lost', gps_reason: 'uart_silent' }), NOW + 6000);
  assert.deepEqual(s.lastFix, fix);
  T.markUnavailable(s, 'stale', NOW + 12000);
  T.markUnavailable(s, 'disconnected', NOW + 13000);
  assert.deepEqual(s.lastFix, fix);
  assert.equal(s.latest.latitude, null);
  assert.equal(s.lastFix.satellites, 8);
  assert.equal(s.lastFix.hdop, 1.2);
});
test('reload restores historical fix, and an older hub flash snapshot cannot overwrite it', () => {
  const s = T.createSession(); acquire(s);
  const restored = T.createSession(JSON.parse(JSON.stringify(T.cache(s))));
  assert.equal(restored.lastFix.source, 'browser_cache');
  assert.equal(restored.latest, null);
  const saved = { latitude: 10, longitude: 20, satellites: 4, hdop: 2.5,
    source: 'saved', age_ms: null, gps_time_utc: '2026-10-05T10:00:00Z' };
  T.applyMessage(restored, message({ last_fix: saved }), NOW + 10000);
  assert.equal(restored.lastFix.latitude, 31.9539);
});
test('hub flash snapshot is displayed as historical when browser has no prior fix', () => {
  const s = T.createSession();
  T.applyMessage(s, message({ last_fix: { latitude: 31, longitude: 35, source: 'saved',
    satellites: 5, hdop: 1.7, gps_time_utc: null, age_ms: null } }), NOW);
  assert.equal(s.lastFix.source, 'saved');
  assert.equal(s.lastFix.captured_at, null);
  assert.equal(s.latest.gps_fix, false);
});
test('fix recovery updates the latest position; reboot keeps previous position until then', () => {
  const s = T.createSession(); acquire(s);
  T.applyMessage(s, { schema: 'beacon.prototype.v1', type: 'hub_ready' }, NOW + 1000);
  assert.equal(s.lastFix.latitude, 31.9539);
  assert.equal(s.latest, null);
  T.applyMessage(s, message({ gps_fix: true, gps_state: 'fixed', latitude: 32, longitude: 36,
    gps_age_ms: 0, satellites: 9, hdop: 1.1 }), NOW + 2000);
  assert.equal(s.lastFix.latitude, 32);
  assert.equal(s.lastFix.hdop, 1.1);
});
test('module failures and malformed fixes preserve GPS history', () => {
  const s = T.createSession(); acquire(s);
  T.applyMessage(s, message({ lora_connected: false, lora_error_code: -2 }), NOW + 1000);
  assert.equal(s.lastFix.latitude, 31.9539);
  assert.ok(s.logs.some(r => r.details.message === 'Ra-02 module error' && r.details.error_code === -2));
  assert.throws(() => T.applyMessage(s, message({ gps_fix: true, latitude: null, longitude: null }), NOW + 2000));
  assert.throws(() => T.applyMessage(s, message({ gps_fix: true, latitude: 91, longitude: 35 }), NOW + 2000));
  assert.equal(s.lastFix.latitude, 31.9539);
});
test('logs keep every reading including no-fix diagnostics; export is valid JSONL', () => {
  const s = T.createSession();
  for (let i = 0; i < T.MAX_LOGS + 50; i++)
    T.applyMessage(s, message({ gps_checksum_failed: i, hub_uptime_ms: i * 1000 }), NOW + i * 1000);
  assert.equal(s.logs.length, T.MAX_LOGS);
  const rows = T.exportLines(s).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].record_type, 'latest_fix');
  assert.equal(rows.at(-1).details.gps_checksum_failed, T.MAX_LOGS + 49);
});
test('preview cannot be saved over the real cache and its export is labeled sample', () => {
  const live = T.createSession(); acquire(live);
  const preview = T.createSession(null, true); acquire(preview);
  assert.throws(() => T.cache(preview), /Preview/);
  assert.equal(live.logs.every(row => row.sample === false), true);
  assert.equal(T.exportLines(preview).trim().split('\n').map(JSON.parse).every(row => row.sample === true), true);
});
