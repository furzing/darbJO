(function (root) {
  'use strict';
  const SCHEMA = 'beacon.prototype.v1';
  const MAX_LOGS = 2000;
  const MAX_EMERGENCIES = 50;
  const EMERGENCY_SOURCES = ['unavailable', 'live_at_trigger', 'last_known', 'after_trigger'];

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
      emergencies: cache && Array.isArray(cache.emergencies) ? cache.emergencies.map(function (value) {
        const record = normalizeEmergency(value, Date.now());
        if (record) {
          record.received_at = timestamp(value.received_at) || record.received_at;
          record.seen_at = timestamp(value.seen_at);
        }
        return record;
      }).filter(Boolean).slice(-MAX_EMERGENCIES) : [],
      logs: cache && Array.isArray(cache.logs)
        ? cache.logs.filter(function (row) { return row && timestamp(row.received_at) && row.details; }).slice(-MAX_LOGS) : []
    };
  }

  function normalizeEmergency(value, at) {
    if (!value || typeof value.id !== 'string' || !/^[0-9a-f]{16}$/i.test(value.id) ||
        /^0{16}$/.test(value.id) || value.node_id !== 'node-01' ||
        !EMERGENCY_SOURCES.includes(value.location_source)) return null;
    const located = value.location_source !== 'unavailable';
    if (located && !position(value)) return null;
    const age = number(value.position_age_ms_at_capture);
    return {
      id: value.id.toLowerCase(), node_id: value.node_id,
      trigger_boot_id: number(value.trigger_boot_id), trigger_uptime_ms: number(value.trigger_uptime_ms),
      location_source: value.location_source,
      latitude: located ? value.latitude : null, longitude: located ? value.longitude : null,
      position_age_ms_at_capture: age !== null && age >= 0 ? age : null,
      position_time_utc: timestamp(value.position_time_utc),
      received_at: new Date(at).toISOString(), seen_at: null
    };
  }

  function mergeEmergency(session, incoming, at) {
    if (!incoming) return;
    const previous = session.emergencies.find(function (item) { return item.id === incoming.id; });
    if (!previous) {
      session.emergencies.push(incoming);
      if (session.emergencies.length > MAX_EMERGENCIES) session.emergencies.shift();
      log(session, 'event', { message: 'Emergency request received', emergency: Object.assign({}, incoming) }, at);
    } else if (previous.location_source === 'unavailable' && position(incoming)) {
      Object.assign(previous, incoming, { received_at: previous.received_at, seen_at: previous.seen_at });
      log(session, 'event', { message: 'Emergency location now available', emergency: Object.assign({}, previous) }, at);
    }
  }

  function acknowledgeEmergency(session, id, at) {
    const record = session.emergencies.find(function (item) { return item.id === id; });
    if (!record || record.seen_at) return;
    record.seen_at = new Date(at).toISOString();
    log(session, 'event', { message: 'Emergency marked seen on this laptop', emergency_id: id }, at);
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
    const emergency = data.emergency == null ? null : normalizeEmergency(data.emergency, at);
    if (data.emergency != null && !emergency) throw new Error('Emergency request has invalid data');

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

    mergeEmergency(session, emergency, at);
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
    return { version: 2, last_fix: session.lastFix, logs: session.logs, emergencies: session.emergencies };
  }

  function exportLines(session) {
    const rows = [{ record_type: 'latest_fix', sample: session.sample, details: session.lastFix }];
    session.emergencies.forEach(function (record) {
      rows.push({ record_type: 'emergency', sample: session.sample, details: record });
    });
    return rows.concat(session.logs).map(function (row) { return JSON.stringify(row); }).join('\n') + '\n';
  }

  const TRIP_GAP_MS = 30 * 60 * 1000;  // a longer silence starts a new trip
  const DATA_GAP_MS = 10 * 1000;       // a longer silence is shown as "no data"
  const FIX_GAP_MS = 60 * 1000;        // distance is not counted across longer fix gaps
  const JITTER_M = 8;                  // smaller steps are treated as GPS jitter
  const MAX_SPEED_MS = 12;             // faster implied speeds are treated as glitches

  function meters(a, b) {
    const rad = Math.PI / 180, dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function readingTime(row) { return Date.parse(row.received_at); }

  // GPS readings of the most recent trip, oldest first.
  function tripReadings(logs) {
    const rows = logs.filter(function (row) { return row.record_type === 'gps_status' && row.details; });
    let start = rows.length - 1;
    while (start > 0 && readingTime(rows[start]) - readingTime(rows[start - 1]) <= TRIP_GAP_MS) start--;
    return rows.slice(Math.max(start, 0));
  }

  // Consecutive readings with the same GPS state, merged. A segment runs until the next
  // one starts, unless the hub went silent in between.
  function segments(rows) {
    const out = [];
    rows.forEach(function (row) {
      const at = readingTime(row), state = row.details.gps_state, last = out[out.length - 1];
      if (last && last.state === state && at - last.end <= DATA_GAP_MS) {
        last.end = at; last.count += 1; last.last = row;
        return;
      }
      if (last && at - last.end <= DATA_GAP_MS) last.end = at;
      out.push({ state: state, start: at, end: at, count: 1, first: row, last: row });
    });
    return out;
  }

  // Runs of consecutive fixes as [[lat, lon], ...] lists; a reading without a fix ends a run.
  function trail(rows) {
    const parts = [];
    let current = null, lastAt = null;
    rows.forEach(function (row) {
      const d = row.details, at = readingTime(row);
      if (d.gps_fix === true && position(d)) {
        if (!current || at - lastAt > DATA_GAP_MS) { current = []; parts.push(current); }
        current.push([d.latitude, d.longitude]);
        lastAt = at;
      } else current = null;
    });
    return parts;
  }

  function tripStats(rows) {
    let distance = 0, fixMs = 0, anchor = null, lastFixAt = null, movedAt = null, previous = null;
    rows.forEach(function (row) {
      const d = row.details, at = readingTime(row), fix = d.gps_fix === true && position(d);
      if (previous && previous.fix && at - previous.at <= DATA_GAP_MS) fixMs += at - previous.at;
      if (fix) {
        if (!anchor || at - lastFixAt > FIX_GAP_MS) {
          anchor = { latitude: d.latitude, longitude: d.longitude, at: at };
          if (movedAt === null) movedAt = at;
        } else {
          const step = meters(anchor, d), speed = step / Math.max((at - anchor.at) / 1000, 1);
          if (step >= JITTER_M && speed <= MAX_SPEED_MS) {
            distance += step;
            anchor = { latitude: d.latitude, longitude: d.longitude, at: at };
            movedAt = at;
          }
        }
        lastFixAt = at;
      }
      previous = { at: at, fix: fix };
    });
    const start = rows.length ? readingTime(rows[0]) : null, end = rows.length ? readingTime(rows[rows.length - 1]) : null;
    return { distance: distance, fixMs: fixMs, durationMs: rows.length ? end - start : 0, start: start, end: end, movedAt: movedAt };
  }

  // Plain-language rating of HDOP. Not an accuracy in meters.
  function accuracy(hdop) {
    const value = number(hdop);
    if (value === null || value <= 0) return null;
    return value <= 2 ? 'good' : value <= 5 ? 'fair' : 'poor';
  }

  // 0–3 bars from satellites used in the fix.
  function satelliteLevel(satellites) {
    const value = number(satellites);
    if (value === null) return null;
    return value >= 7 ? 3 : value >= 4 ? 2 : value >= 1 ? 1 : 0;
  }

  const api = { MAX_LOGS: MAX_LOGS, createSession: createSession, applyMessage: applyMessage,
    markUnavailable: markUnavailable, log: log, cache: cache, exportLines: exportLines, position: position,
    acknowledgeEmergency: acknowledgeEmergency, accuracy: accuracy, satelliteLevel: satelliteLevel, meters: meters, tripReadings: tripReadings,
    segments: segments, trail: trail, tripStats: tripStats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BeaconTelemetry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
