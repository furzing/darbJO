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
test('plain-language accuracy and satellite levels', () => {
  assert.equal(T.accuracy(1.2), 'good');
  assert.equal(T.accuracy(2), 'good');
  assert.equal(T.accuracy(3.5), 'fair');
  assert.equal(T.accuracy(9), 'poor');
  assert.equal(T.accuracy(null), null);
  assert.equal(T.accuracy(0), null);
  assert.equal(T.satelliteLevel(8), 3);
  assert.equal(T.satelliteLevel(5), 2);
  assert.equal(T.satelliteLevel(2), 1);
  assert.equal(T.satelliteLevel(0), 0);
  assert.equal(T.satelliteLevel(null), null);
});
// One reading per second; lat offsets are in meters north of the start point.
function walk(steps, start = NOW) {
  return steps.map((step, i) => ({
    record_type: 'gps_status', received_at: new Date((step.at ?? start + i * 1000)).toISOString(),
    details: step.fix === false
      ? { gps_state: step.state || 'fix_lost', gps_fix: false, latitude: null, longitude: null }
      : { gps_state: 'fixed', gps_fix: true, latitude: 31.95 + (step.north || 0) / 111195, longitude: 35.91 }
  }));
}
test('repeated readings collapse into state segments; silence splits them', () => {
  const rows = walk([{}, {}, {}, { fix: false }, { fix: false }, { at: NOW + 60000, fix: false }]);
  const s = T.segments(rows);
  assert.deepEqual(s.map(x => [x.state, x.count]), [['fixed', 3], ['fix_lost', 2], ['fix_lost', 1]]);
  assert.equal(s[0].end, s[1].start, 'segments touch when there is no gap');
  assert.equal(s[1].end, NOW + 4000, 'a silent hub is not shown as lost signal');
});
test('trail breaks at signal loss; trip starts after a long silence', () => {
  const old = walk([{}, {}], NOW - 2 * 3600 * 1000);
  const rows = old.concat(walk([{}, { north: 10 }, { fix: false }, { north: 20 }, { north: 30 }]));
  const trip = T.tripReadings(rows);
  assert.equal(trip.length, 5);
  assert.deepEqual(T.trail(trip).map(p => p.length), [2, 2]);
});
test('trip distance ignores jitter and glitches; signal time and stop time are tracked', () => {
  const jitter = walk([{}, { north: 3 }, { north: -2 }, { north: 4 }, { north: 1 }]);
  assert.equal(T.tripStats(jitter).distance, 0);
  const moving = walk([{}, { north: 5 }, { north: 10 }, { north: 15 }, { north: 5000 }, { north: 20 }]);
  const stats = T.tripStats(moving);
  assert.ok(Math.abs(stats.distance - 20) < 0.5, 'counts 20 m and skips the 5 km jump: ' + stats.distance);
  assert.equal(stats.fixMs, 5000);
  assert.equal(stats.movedAt, NOW + 5000);
  assert.ok(Math.abs(T.meters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) - 111195) < 10);
});
test('preview cannot be saved over the real cache and its export is labeled sample', () => {
  const live = T.createSession(); acquire(live);
  const preview = T.createSession(null, true); acquire(preview);
  assert.throws(() => T.cache(preview), /Preview/);
  assert.equal(live.logs.every(row => row.sample === false), true);
  assert.equal(T.exportLines(preview).trim().split('\n').map(JSON.parse).every(row => row.sample === true), true);
});
