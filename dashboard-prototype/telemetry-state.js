(function (root) {
  'use strict';
  const SCHEMA = 'beacon.prototype.v1';
  const MAX_LOGS = 2000;

  function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function position(value) {
    return Boolean(value && number(value.latitude) !== null && number(value.longitude) !== null &&
      Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180);
  }

  function timestamp(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  }

  function normalizeFix(value, at) {
    if (!position(value)) return null;
    const age = number(value.age_ms);
    const source = value.source === 'current_session' ? 'current_session' : 'saved';
    return {
      latitude: value.latitude, longitude: value.longitude,
      satellites: number(value.satellites), hdop: number(value.hdop),
      gps_time_utc: timestamp(value.gps_time_utc),
      captured_at: source === 'current_session' && age !== null && age >= 0
        ? new Date(at - age).toISOString() : timestamp(value.gps_time_utc),
      source: source
    };
  }

  function createSession(cache, sample) {
    const saved = cache && position(cache.last_fix) ? Object.assign({}, cache.last_fix, { source: 'browser_cache' }) : null;
    return {
      sample: Boolean(sample), lastFix: saved, latest: null, stream: 'waiting',
      lastMessageAt: null, messageCount: 0, lastUptime: null,
      logs: cache && Array.isArray(cache.logs)
        ? cache.logs.filter(function (row) { return row && timestamp(row.received_at) && row.details; }).slice(-MAX_LOGS) : []
    };
  }

  function log(session, type, details, at) {
    session.logs.push({ record_type: type, received_at: new Date(at).toISOString(), sample: session.sample, details: details });
    if (session.logs.length > MAX_LOGS) session.logs.splice(0, session.logs.length - MAX_LOGS);
  }

  function applyMessage(session, data, at) {
    if (!data || data.schema !== SCHEMA || typeof data.type !== 'string') throw new Error('Unsupported message schema');
    if (data.type === 'hub_ready') {
      log(session, 'event', { message: 'Hub started; previous fix retained' }, at);
      session.latest = null;
      session.stream = 'waiting';
      return;
    }
    if (data.type !== 'gps_status') return;
    if (typeof data.gps_fix !== 'boolean' || typeof data.gps_state !== 'string')
      throw new Error('GPS message is missing fix status');
    if (data.gps_fix && !position(data)) throw new Error('GPS fix has invalid coordinates');

    const previous = session.latest;
    if (session.stream !== 'active') log(session, 'event', { message: 'Hub status stream active' }, at);
    const uptime = number(data.hub_uptime_ms);
    if (uptime !== null && session.lastUptime !== null && uptime < session.lastUptime)
      log(session, 'event', { message: 'Hub reboot detected; previous fix retained' }, at);
    if (!previous || previous.gps_state !== data.gps_state || previous.gps_reason !== data.gps_reason)
      log(session, 'event', { message: 'GPS: ' + data.gps_state, reason: data.gps_reason }, at);
    if (!previous || previous.lora_connected !== data.lora_connected || previous.lora_error_code !== data.lora_error_code)
      log(session, 'event', {
        message: data.lora_connected === true ? 'Ra-02 responds over SPI' : 'Ra-02 module error',
        error_code: data.lora_error_code, chip_version: data.lora_chip_version
      }, at);

    const incoming = normalizeFix(data.last_fix, at);
    if (data.gps_fix) {
      session.lastFix = Object.assign(
        normalizeFix(Object.assign({}, data, { source: 'current_session', age_ms: data.gps_age_ms }), at),
        incoming && incoming.latitude === data.latitude && incoming.longitude === data.longitude ? incoming : {}
      );
    } else if (incoming) {
      const oldTime = session.lastFix && Date.parse(session.lastFix.gps_time_utc || session.lastFix.captured_at);
      const newTime = Date.parse(incoming.gps_time_utc || incoming.captured_at);
      if (!session.lastFix || (Number.isFinite(newTime) && (!Number.isFinite(oldTime) || newTime > oldTime)))
        session.lastFix = incoming;
    }

    session.latest = Object.assign({}, data);
    session.stream = 'active';
    session.lastMessageAt = at;
    session.lastUptime = uptime;
    session.messageCount += 1;
    log(session, 'gps_status', Object.assign({}, data), at);
  }

  function markUnavailable(session, state, at) {
    if (session.stream !== state) log(session, 'event', { message: state === 'stale' ? 'Hub stream timed out; latest fix retained' : 'USB disconnected; latest fix retained' }, at);
    session.stream = state;
  }

  function cache(session) {
    if (session.sample) throw new Error('Preview data cannot overwrite the live cache');
    return { version: 2, last_fix: session.lastFix, logs: session.logs };
  }

  function exportLines(session) {
    const rows = [{ record_type: 'latest_fix', sample: session.sample, details: session.lastFix }];
    return rows.concat(session.logs).map(function (row) { return JSON.stringify(row); }).join('\n') + '\n';
  }

  const api = { MAX_LOGS: MAX_LOGS, createSession: createSession, applyMessage: applyMessage,
    markUnavailable: markUnavailable, log: log, cache: cache, exportLines: exportLines, position: position };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BeaconTelemetry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
