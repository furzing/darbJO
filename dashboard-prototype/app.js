const byId = function (id) { return document.getElementById(id); };
const Telemetry = window.BeaconTelemetry;
const CACHE_KEY = 'beacon-hub-pitch-v2';
const GPS_LABELS = {
  starting: 'GPS starting', acquiring: 'Acquiring satellites',
  acquisition_timeout: 'Still waiting for a fix', fixed: 'Live fix available',
  fix_lost: 'GPS fix lost', uart_silent: 'No GPS UART data', data_error: 'GPS data error'
};
const REASONS = {
  none: 'Valid position available', receiver_no_fix: 'Receiver reports no position fix',
  uart_silent: 'No recent data from GPS UART', invalid_nmea: 'No recent valid NMEA sentences',
  stale_location: 'No fresh position update'
};
let port = null, reader = null, reading = false, connecting = false;
let preview = null, previewTimer = null, previewTick = 0, previewFix = null;
let toastTimer = null, cacheDirty = false, storageProblem = false;
let live;
try {
  const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  live = Telemetry.createSession(cache && cache.version === 2 ? cache : null, false);
} catch (_) {
  live = Telemetry.createSession(null, false);
  storageProblem = true;
}
if (live.lastFix) Telemetry.log(live, 'event', { message: 'Last valid fix restored from this browser' }, Date.now());

function activeSession() { return preview || live; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function label(value, decimals) { return number(value) === null ? '—' : value.toFixed(decimals || 0); }
function elapsed(ms) {
  if (number(ms) === null || ms < 0) return 'Unknown';
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? seconds + ' s' : seconds < 3600 ? Math.floor(seconds / 60) + ' m ' + seconds % 60 + ' s' : Math.floor(seconds / 3600) + ' h ' + Math.floor(seconds % 3600 / 60) + ' m';
}
function timeLabel(value) { return value ? new Date(value).toLocaleString() : 'Unknown'; }
function setConnection(labelText) {
  const connected = Boolean(port || preview);
  byId('connectionBox').classList.toggle('connected', connected);
  byId('connectButton').textContent = port ? 'Disconnect' : 'Connect hub';
  byId('connectButton').classList.toggle('disconnect', Boolean(port));
  byId('connectButton').disabled = connecting;
  byId('connectionText').textContent = labelText || (preview ? 'Preview · sample data' : port ? 'USB connected' : 'Not connected');
}
function toast(message) {
  byId('toast').textContent = message;
  byId('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { byId('toast').classList.remove('show'); }, 4500);
}
function flushCache() {
  if (!cacheDirty) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Telemetry.cache(live)));
    cacheDirty = false;
    storageProblem = false;
  } catch (_) {
    if (!storageProblem) toast('Browser storage is unavailable or full. Download logs to keep this session.');
    storageProblem = true;
  }
}
function event(message, details) {
  Telemetry.log(activeSession(), 'event', Object.assign({ message: message }, details || {}), Date.now());
  if (!preview) cacheDirty = true;
  renderLogs();
}
function renderSummary() {
  const session = activeSession(), data = session.latest || {}, fix = session.lastFix;
  const streamLive = session.stream === 'active';
  const current = streamLive && data.gps_fix === true && Boolean(fix);
  const sinceMessage = session.lastMessageAt === null ? 0 : Math.max(0, Date.now() - session.lastMessageAt);
  byId('modeNote').textContent = preview
    ? 'Sample session · acquisition, fix, loss, recovery.'
    : 'Your latest position, kept in view.';
  byId('modeNote').classList.toggle('sample', Boolean(preview));
  const radioKnown = typeof data.lora_connected === 'boolean';
  byId('loraSummary').textContent = !radioKnown ? 'Awaiting hub' : streamLive
    ? data.lora_connected ? 'Ready over SPI' : 'Module error'
    : data.lora_connected ? 'Last check: ready' : 'Last check: error';
  byId('loraSummary').classList.toggle('warning', radioKnown && (!streamLive || !data.lora_connected));
  byId('loraDetail').textContent = !radioKnown ? 'Awaiting module status' : !streamLive
    ? data.lora_connected ? 'Last observed: detected' : 'Last observed: module error'
    : data.lora_connected ? 'Detected and initialized' : 'Check wiring and module power';
  byId('loraCode').textContent = label(data.lora_error_code);
  byId('loraVersion').textContent = number(data.lora_chip_version) === null || data.lora_chip_version < 0
    ? '—' : '0x' + data.lora_chip_version.toString(16).toUpperCase().padStart(2, '0');
  byId('loraChecked').textContent = number(data.lora_check_age_ms) === null ? '—' : elapsed(data.lora_check_age_ms + sinceMessage);
  byId('gpsSummary').textContent = session.stream === 'stale' ? 'Hub stream stopped' : session.stream === 'disconnected' ? 'USB disconnected' : GPS_LABELS[data.gps_state] || 'Awaiting GPS status';
  byId('gpsSummary').classList.toggle('warning', Boolean(data.gps_state) && !current);
  byId('gpsReason').textContent = !streamLive ? 'Awaiting fresh receiver status' : REASONS[data.gps_reason] || 'Awaiting receiver data';
  let detail = 'A clear view of the sky helps the receiver acquire satellites.';
  if (data.gps_state === 'starting' || data.gps_state === 'acquiring')
    detail = 'Satellite acquisition is in progress. A cold start can take longer; an underground room may block reception.';
  if (data.gps_state === 'acquisition_timeout')
    detail = 'No fix after two minutes. Reception may be blocked indoors; acquisition continues and any saved position stays available.';
  if (data.gps_state === 'fix_lost')
    detail = 'Reception is unavailable. The position card retains the last valid reading and its acquisition details.';
  if (data.gps_reason === 'uart_silent')
    detail = 'No recent UART data. Check GPS power, TX-to-GPIO16 wiring, and the configured 9600 baud rate.';
  if (data.gps_reason === 'invalid_nmea')
    detail = 'Bytes are arriving without recent valid NMEA sentences. Check baud rate, wiring, and checksum failures.';
  if (!streamLive && session.latest)
    detail = 'Fresh hub status is unavailable. Any retained position is historical; reconnect the hub to resume diagnostics.';
  byId('gpsDetail').textContent = detail;
  byId('satelliteSummary').textContent = streamLive ? label(data.satellites) : '—';
  byId('lastPacket').textContent = session.lastMessageAt === null ? '—' : new Date(session.lastMessageAt).toLocaleTimeString();
  byId('waitTime').textContent = number(data.acquisition_ms) === null ? '—' : elapsed(data.acquisition_ms);
  byId('uartAge').textContent = number(data.uart_age_ms) === null ? '—' : elapsed(data.uart_age_ms + sinceMessage);
  byId('hdop').textContent = streamLive ? label(data.hdop, 1) : '—';
  byId('nmeaCount').textContent = label(data.gps_sentences_passed);
  byId('checksumCount').textContent = label(data.gps_checksum_failed);
  byId('byteCount').textContent = label(data.gps_chars_processed);
  byId('storageState').textContent = 'Hub fix storage: ' + (data.storage_status || 'awaiting status');
  byId('gpsState').classList.toggle('good', current);
  byId('gpsState').classList.toggle('historical', Boolean(fix) && !current);
  byId('gpsState').textContent = current ? 'LIVE FIX' : fix ? 'LAST KNOWN' : 'NO FIX YET';
  byId('positionLabel').textContent = current ? 'CURRENT GPS POSITION' : fix ? 'RETAINED GPS POSITION' : 'NO POSITION ACQUIRED';
  byId('coordinates').textContent = fix ? fix.latitude.toFixed(6) + '°, ' + fix.longitude.toFixed(6) + '°' : 'Waiting for a GPS fix';
  byId('fixSatellites').textContent = fix ? label(fix.satellites) : '—';
  byId('fixHdop').textContent = fix ? label(fix.hdop, 1) : '—';
  byId('gpsAge').textContent = !fix ? '—' : fix.captured_at ? elapsed(Date.now() - Date.parse(fix.captured_at)) : 'Unknown · saved fix';
  byId('fixTimestamp').textContent = !fix ? 'No acquisition timestamp yet' : 'Acquired ' + timeLabel(fix.gps_time_utc || fix.captured_at) + (fix.gps_time_utc ? ' · GPS time' : ' · hub receipt time');
  byId('positionNote').textContent = current
    ? (preview ? 'Sample coordinates · live hardware records stay separate.' : 'Fresh coordinates from your hub’s GPS receiver.')
    : fix ? 'Last valid fix retained. Current position is unconfirmed.'
    : 'Your last valid fix stays here when reception drops.';
  byId('cacheStatus').textContent = preview ? 'Preview data is never saved over real GPS records.'
    : storageProblem ? 'Browser save unavailable · download logs to keep them.'
    : fix ? 'Last fix and logs saved in this browser; hub also checkpoints valid fixes.' : 'Waiting for a valid position to save.';
  byId('messageCount').textContent = session.messageCount + ' readings this session';
  byId('logCount').textContent = session.logs.length + ' / ' + Telemetry.MAX_LOGS + ' stored records';
  window.DarbMap.update(fix, current, Boolean(preview));
}
const LOG_LABELS = {
  starting: 'GPS starting', acquiring: 'Acquiring', acquisition_timeout: 'Acquisition delayed',
  fixed: 'Position acquired', fix_lost: 'Fix lost', uart_silent: 'UART silent', data_error: 'Data error'
};
function renderLogs() {
  const session = activeSession();
  const rows = session.logs.filter(function (row) { return row.record_type === 'gps_status'; }).slice(-60).reverse();
  const list = byId('logBody');
  const scrollTop = list.scrollTop, scrollHeight = list.scrollHeight, focused = document.activeElement;
  const existing = new Map(Array.from(list.querySelectorAll('.log-entry')).map(function (item) { return [item.dataset.key, item]; }));
  const fragment = document.createDocumentFragment();
  if (!rows.length) {
    const empty = document.createElement('p'); empty.className = 'empty-log';
    empty.textContent = 'Your readings will appear here.'; fragment.append(empty);
  }
  rows.forEach(function (row) {
    const d = row.details;
    const key = String(row.sample) + row.received_at + d.hub_uptime_ms;
    let details = existing.get(key);
    if (!details) {
      details = document.createElement('details'); details.className = 'log-entry'; details.dataset.key = key;
      const summary = document.createElement('summary'), heading = document.createElement('div');
      heading.className = 'log-row';
      const state = document.createElement('span'), time = document.createElement('time');
      state.className = 'log-state ' + (LOG_LABELS[d.gps_state] ? d.gps_state : '');
      state.textContent = LOG_LABELS[d.gps_state] || d.gps_state;
      time.dateTime = row.received_at; time.textContent = new Date(row.received_at).toLocaleTimeString();
      heading.append(state, time);
      const coordinates = document.createElement('p'); coordinates.className = 'log-coordinate';
      coordinates.textContent = d.gps_fix && Telemetry.position(d) ? d.latitude.toFixed(6) + '°, ' + d.longitude.toFixed(6) + '°' : 'No live position';
      const meta = document.createElement('p'); meta.className = 'log-meta';
      meta.textContent = label(d.satellites) + ' satellites · HDOP ' + label(d.hdop, 1);
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(row, null, 2);
      summary.append(heading, coordinates, meta); details.append(summary, pre);
    }
    fragment.append(details);
  });
  list.replaceChildren(fragment);
  if (list.contains(focused)) focused.focus({ preventScroll: true });
  if (scrollTop > 0) list.scrollTop = scrollTop + Math.max(0, list.scrollHeight - scrollHeight);
  const events = byId('activityList'); const eventScroll = events.scrollTop;
  events.replaceChildren();
  const eventRows = session.logs.filter(function (row) { return row.record_type === 'event'; }).slice(-60).reverse();
  if (!eventRows.length) {
    const empty = document.createElement('p'); empty.className = 'empty-log';
    empty.textContent = 'Connection and reception changes will appear here.'; events.append(empty);
  }
  eventRows.forEach(function (row) {
    const item = document.createElement('div'); item.className = 'activity-item';
    const text = document.createElement('span'), time = document.createElement('time');
    text.textContent = row.details.message + (row.details.reason ? ' · ' + row.details.reason : '');
    time.dateTime = row.received_at; time.textContent = new Date(row.received_at).toLocaleTimeString();
    item.append(text, time); events.append(item);
  });
  events.scrollTop = eventScroll;
  renderSummary();
}
function processLine(line) {
  if (!line.trim()) return;
  if (!line.trimStart().startsWith('{')) {
    event('Serial diagnostic', { line: line.slice(0, 512) });
    renderLogs();
    return;
  }
  try {
    Telemetry.applyMessage(live, JSON.parse(line), Date.now());
    cacheDirty = true;
    setConnection('Receiving hub status');
  } catch (error) {
    event('Invalid serial message ignored', { error: error.message, line: line.slice(0, 512) });
    toast(error.message);
  }
  renderLogs();
}
async function readSerial(openPort) {
  const decoder = new TextDecoder();
  let buffer = '';
  reading = true;
  try {
    reader = openPort.readable.getReader();
    while (reading) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      lines.forEach(processLine);
      if (buffer.length > 65536) { buffer = ''; event('Oversized serial line ignored'); }
    }
  } catch (error) {
    if (reading) toast('Serial connection ended: ' + error.message);
  } finally {
    reading = false;
    if (reader) reader.releaseLock();
    reader = null;
    Telemetry.markUnavailable(live, 'disconnected', Date.now());
    cacheDirty = true; flushCache();
    port = null;
    try { await openPort.close(); } catch (_) { /* Device may be unplugged. */ }
    connecting = false;
    setConnection(); renderLogs();
  }
}
async function connectHub() {
  if (preview) { toast('Stop the preview before connecting to the hub.'); return; }
  if (connecting) return;
  if (port) {
    connecting = true; setConnection('Disconnecting');
    reading = false;
    try { await reader.cancel(); } catch (_) { /* Reader may have ended. */ }
    return;
  }
  if (!navigator.serial) { toast('Open the dashboard in desktop Chrome or Edge on localhost to connect to USB serial.'); return; }
  connecting = true; setConnection('Choose the ESP32 USB port');
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
    live.stream = 'waiting';
    connecting = false;
    setConnection('USB connected · waiting for status');
    event('USB connected');
    readSerial(port);
  } catch (error) {
    if (port) { try { await port.close(); } catch (_) {} }
    port = null; connecting = false; setConnection();
    if (error.name !== 'NotFoundError') toast('Could not connect: ' + error.message);
  }
}
function previewStep() {
  const t = previewTick++ % 36, now = Date.now();
  const fixed = (t >= 10 && t < 18) || t >= 26;
  if (fixed) previewFix = {
    latitude: 31.9539 + t / 1000000, longitude: 35.9106, satellites: 8, hdop: 1.2,
    gps_time_utc: new Date(now).toISOString(), source: 'current_session', age_ms: 0, acquired: now
  };
  const state = t < 5 ? 'starting' : t < 10 ? 'acquiring' : fixed ? 'fixed' : 'fix_lost';
  const snapshot = previewFix ? Object.assign({}, previewFix, { age_ms: now - previewFix.acquired }) : null;
  Telemetry.applyMessage(preview, {
    schema: 'beacon.prototype.v1', type: 'gps_status', hub_uptime_ms: previewTick * 1000,
    gps_state: state, gps_reason: fixed ? 'none' : 'receiver_no_fix', gps_fix: fixed,
    latitude: fixed ? previewFix.latitude : null, longitude: fixed ? previewFix.longitude : null,
    satellites: fixed ? 8 : 0, hdop: fixed ? 1.2 : null, gps_age_ms: snapshot ? snapshot.age_ms : null,
    acquisition_ms: fixed ? 0 : t * 1000, uart_age_ms: 50, nmea_age_ms: 50,
    gps_chars_processed: t * 500, gps_sentences_passed: t * 6, gps_checksum_failed: 0,
    lora_connected: !(t >= 28 && t < 31), lora_status: t >= 28 && t < 31 ? 'error' : 'ready',
    lora_error_code: t >= 28 && t < 31 ? -2 : 0, lora_chip_version: 18, lora_check_age_ms: 500,
    storage_status: 'ready', last_fix: snapshot
  }, now);
  renderLogs();
}
byId('connectButton').addEventListener('click', connectHub);
byId('previewButton').addEventListener('click', function () {
  if (preview) {
    clearInterval(previewTimer); previewTimer = null; preview = null;
    byId('previewButton').textContent = 'Preview';
    setConnection(); renderLogs(); return;
  }
  if (port || connecting) { toast('Disconnect the hub before previewing sample data.'); return; }
  preview = Telemetry.createSession(null, true);
  previewTick = 0; previewFix = null;
  byId('previewButton').textContent = 'Stop preview';
  setConnection();
  previewStep();
  previewTimer = setInterval(previewStep, 1000);
});
byId('exportLogs').addEventListener('click', function () {
  const url = URL.createObjectURL(new Blob([Telemetry.exportLines(activeSession())], { type: 'application/x-ndjson' }));
  const link = document.createElement('a'); link.href = url;
  link.download = 'darbjo-' + (preview ? 'preview-' : 'hub-') + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl';
  link.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
});
byId('clearLogs').addEventListener('click', function () {
  activeSession().logs = [];
  if (!preview) { cacheDirty = true; flushCache(); }
  renderLogs();
});
window.addEventListener('beforeunload', flushCache);
setInterval(function () {
  if (port && live.lastMessageAt !== null && Date.now() - live.lastMessageAt > 5000) {
    Telemetry.markUnavailable(live, 'stale', Date.now());
    cacheDirty = true; setConnection('USB open · status messages stopped');
  }
  renderSummary();
}, 1000);
setInterval(flushCache, 5000);
function selectLogTab(events) {
  byId('logBody').hidden = events;
  byId('activityList').hidden = !events;
  byId('readingsTab').classList.toggle('selected', !events);
  byId('eventsTab').classList.toggle('selected', events);
  byId('readingsTab').setAttribute('aria-pressed', String(!events));
  byId('eventsTab').setAttribute('aria-pressed', String(events));
}
byId('readingsTab').addEventListener('click', function () { selectLogTab(false); });
byId('eventsTab').addEventListener('click', function () { selectLogTab(true); });
function route(focus) {
  const requested = location.hash.replace(/^#\/?/, '');
  const page = ['console', 'hardware'].includes(requested) ? requested : 'home';
  document.body.dataset.page = page;
  document.querySelectorAll('[data-view]').forEach(function (view) { view.hidden = view.dataset.view !== page; });
  document.querySelectorAll('[data-route]').forEach(function (link) {
    if (link.dataset.route === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  byId('sessionToolbar').hidden = page === 'home';
  document.title = page === 'home' ? 'DarbJo — Go further. Stay close.' : 'DarbJo — ' + (page === 'console' ? 'Live console' : 'Hardware');
  if (page === 'console') window.DarbMap.show();
  if (focus) {
    const heading = document.querySelector('[data-view="' + page + '"] h1');
    heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}
document.querySelector('.skip-link').addEventListener('click', function (event) {
  event.preventDefault(); byId('main').setAttribute('tabindex', '-1'); byId('main').focus();
});
window.addEventListener('hashchange', function () { route(true); });
setConnection(); renderLogs(); route(false);
