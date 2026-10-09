const byId = function (id) { return document.getElementById(id); };
const Telemetry = window.BeaconTelemetry;
const CACHE_KEY = 'beacon-hub-pitch-v2';
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
function timeLabel(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString() : date.toLocaleString();
}
function ago(at) { return Date.now() - at < 2000 ? 'just now' : elapsed(Date.now() - at) + ' ago'; }
function setConnection() {
  byId('connectButton').textContent = port ? 'Disconnect' : 'Connect hub';
  byId('connectButton').classList.toggle('button-primary', !port);
  byId('connectButton').classList.toggle('button-secondary', Boolean(port));
  byId('connectButton').disabled = connecting;
  byId('connectButton').hidden = Boolean(preview);
  byId('liveMode').setAttribute('aria-pressed', String(!preview));
  byId('previewMode').setAttribute('aria-pressed', String(Boolean(preview)));
  byId('sampleTag').hidden = !preview;
  renderStatus();
}
// One answer to "what is happening right now", shown in the status bar.
function statusModel() {
  const session = activeSession(), data = session.latest || {}, fix = session.lastFix;
  const lastFix = !fix ? 'No position yet' : fix.captured_at ? 'Last fix ' + ago(Date.parse(fix.captured_at)) : 'Last known position shown';
  if (connecting) return port
    ? { tone: 'pending', title: 'Disconnecting', detail: 'Closing the USB port' }
    : { tone: 'pending', title: 'Connecting', detail: 'Choose the ESP32 USB port in the browser dialog' };
  if (!preview && !port) return session.stream === 'disconnected'
    ? { tone: 'bad', title: 'Hub disconnected', detail: lastFix + ' · reconnect to resume' }
    : { tone: 'idle', title: 'Not connected', detail: fix ? lastFix + ' · connect the hub to resume' : 'Connect the hub to start' };
  if (session.stream === 'stale') return { tone: 'bad', title: 'Hub stopped sending', detail: 'Last message ' + ago(session.lastMessageAt) + ' · check the USB cable' };
  if (session.stream !== 'active') return { tone: 'pending', title: 'Waiting for the hub', detail: 'USB connected · no GPS status yet' };
  if (data.gps_fix === true && fix) return { tone: 'good', title: 'Live', detail: 'Updated ' + ago(session.lastMessageAt) };
  switch (data.gps_state) {
    case 'starting': case 'acquiring':
      return { tone: 'pending', title: 'Searching for satellites',
        detail: (number(data.acquisition_ms) === null ? '' : elapsed(data.acquisition_ms) + ' so far · ') + 'can take 1–2 min outdoors' };
    case 'acquisition_timeout':
      return { tone: 'warn', title: 'Still searching', detail: 'No fix after 2 min · move to a clearer view of the sky' };
    case 'fix_lost': return { tone: 'bad', title: 'Signal lost', detail: lastFix };
    case 'uart_silent': return { tone: 'bad', title: 'GPS not responding', detail: 'Check GPS power and wiring' };
    case 'data_error': return { tone: 'bad', title: 'GPS data unreadable', detail: 'Check GPS wiring and baud rate' };
    default: return { tone: 'pending', title: 'Waiting for position', detail: lastFix };
  }
}
function renderStatus() {
  const status = statusModel();
  byId('statusBar').dataset.tone = status.tone;
  if (byId('statusTitle').textContent !== status.title) byId('statusTitle').textContent = status.title;
  byId('statusDetail').textContent = status.detail;
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
  const current = session.stream === 'active' && data.gps_fix === true && Boolean(fix);
  byId('gpsState').classList.toggle('good', current);
  byId('gpsState').classList.toggle('historical', Boolean(fix) && !current);
  byId('gpsState').textContent = current ? 'Live' : fix ? 'Last known' : 'No fix yet';
  byId('coordinates').textContent = fix ? fix.latitude.toFixed(6) + '°, ' + fix.longitude.toFixed(6) + '°' : 'Waiting for a GPS fix';
  renderPositionActions(fix, current);
  renderSatellites(fix ? fix.satellites : null);
  const rating = fix ? Telemetry.accuracy(fix.hdop) : null;
  byId('fixAccuracy').textContent = rating ? ACCURACY_LABELS[rating] : '—';
  byId('fixAccuracy').className = rating ? 'accuracy-' + rating : '';
  byId('fixHdop').textContent = rating ? 'HDOP ' + fix.hdop.toFixed(1) : '';
  byId('gpsAge').textContent = !fix ? '—' : fix.captured_at ? ago(Date.parse(fix.captured_at)) : 'Unknown';
  const acquired = fix && (fix.gps_time_utc || fix.captured_at);
  byId('fixTimestamp').textContent = acquired ? timeLabel(acquired) : fix ? 'Saved fix, time unknown' : '';
  byId('fixTimestamp').title = acquired ? (fix.gps_time_utc ? 'GPS time' : 'Time the hub received it') : '';
  byId('positionNote').hidden = !fix || current;
  byId('positionNote').textContent = fix && !current ? 'Last valid fix kept. Current position is unconfirmed.' : '';
  document.querySelectorAll('[data-group=fix]').forEach(function (cell) { cell.hidden = !fix; });
  byId('logCount').textContent = session.logs.length.toLocaleString() + ' of ' + Telemetry.MAX_LOGS.toLocaleString() + ' records saved' + (preview ? ' · sample only' : '');
  renderStatus();
  renderGuide(fix);
  renderHardware();
  const trip = Telemetry.tripReadings(session.logs);
  renderTrip(trip, current);
  byId('statGrid').hidden = !fix && !trip.length;
  window.DarbMap.update(fix, current, Boolean(preview), Telemetry.trail(trip));
}
// Health of each hardware part, in plain language. Used by the hardware page and the console strip.
function hardwareModel() {
  const session = activeSession(), data = session.latest || {}, fresh = session.stream === 'active';
  const since = session.lastMessageAt === null ? 0 : Math.max(0, Date.now() - session.lastMessageAt);
  const linked = Boolean(preview || port);
  const lastMessage = session.lastMessageAt === null ? '—' : ago(session.lastMessageAt);
  let hub;
  if (connecting) hub = { tone: 'pending', pill: 'Connecting', text: 'Choose the ESP32 USB port in the browser dialog.' };
  else if (!linked) hub = session.stream === 'disconnected'
    ? { tone: 'bad', pill: 'Disconnected', text: 'The USB connection closed.', fix: 'Check the cable, then press Connect hub.' }
    : { tone: 'idle', pill: 'Not connected', text: 'The console is not connected to a hub.' };
  else if (session.stream === 'stale') hub = { tone: 'bad', pill: 'Silent', text: 'The hub stopped sending status ' + lastMessage + '.', fix: 'Check the USB cable. If the hub restarted, wait a few seconds.' };
  else if (!fresh) hub = { tone: 'pending', pill: 'Waiting', text: 'USB is open. Waiting for the first status message.' };
  else hub = { tone: 'ok', pill: preview ? 'Sample' : 'Working', text: preview ? 'Showing sample data, not the real hub.' : 'Sending status about once a second.' };
  if (fresh && data.storage_status && data.storage_status !== 'ready' && hub.tone === 'ok')
    hub = { tone: 'warn', pill: 'Storage issue', text: 'The hub cannot save fixes to its flash memory.', fix: 'The console still keeps the last fix in this browser.' };
  hub.facts = [
    ['Connection', preview ? 'Sample data' : port ? 'USB · 115200 baud' : 'Not connected'],
    ['Last message', lastMessage],
    ['Fix saved on hub', { ready: 'Yes', unavailable: 'Unavailable', write_error: 'Write error' }[data.storage_status] || '—'],
    ['Saved in this browser', preview ? 'Sample is not saved' : storageProblem ? 'Failed · export the log' : session.logs.length.toLocaleString() + ' records']
  ];
  hub.more = [['USB settings', '115200 baud, 8-N-1'], ['Message format', 'JSON lines'],
    ['Hub uptime', number(data.hub_uptime_ms) === null ? '—' : elapsed(data.hub_uptime_ms)],
    ['Readings this session', session.messageCount.toLocaleString()]];

  const state = data.gps_state;
  let gps;
  if (!fresh) gps = { tone: 'idle', pill: session.latest ? 'No fresh data' : 'Unknown', text: session.latest ? 'Showing the last values the hub reported.' : 'Waiting for the hub.' };
  else if (state === 'fixed') gps = { tone: 'ok', pill: 'Live fix', text: 'Receiving a position from ' + label(data.satellites) + ' satellites.' };
  else if (state === 'starting' || state === 'acquiring') gps = { tone: 'pending', pill: 'Searching', text: 'Looking for satellites. Outdoors this usually takes 1–2 minutes.', fix: 'Indoors the GPS may not find satellites at all. The last known position stays on the console.' };
  else if (state === 'acquisition_timeout') gps = { tone: 'warn', pill: 'Still searching', text: 'No fix after 2 minutes.', fix: 'Move to open sky, away from buildings.' };
  else if (state === 'fix_lost') gps = { tone: 'warn', pill: 'Signal lost', text: 'The GPS had a fix and lost it.', fix: 'Normal indoors. The last known position stays on the console.' };
  else if (state === 'uart_silent') gps = { tone: 'bad', pill: 'Not responding', text: 'No data is coming from the GPS module.', fix: 'Check GPS power and the GPS TX → GPIO16 wire.' };
  else if (state === 'data_error') gps = { tone: 'bad', pill: 'Unreadable', text: 'Data arrives from the GPS but cannot be read.', fix: 'Check the wiring and that the GPS runs at 9600 baud.' };
  else gps = { tone: 'idle', pill: 'Unknown', text: 'Waiting for GPS status.' };
  const rating = Telemetry.accuracy(data.hdop);
  gps.facts = [
    ['Satellites now', fresh ? label(data.satellites) : '—'],
    ['Accuracy now', fresh && rating ? ACCURACY_LABELS[rating] + ' · HDOP ' + data.hdop.toFixed(1) : '—'],
    fresh && state === 'fixed'
      ? ['Position age', number(data.gps_age_ms) === null ? '—' : elapsed(data.gps_age_ms)]
      : ['Searching for', fresh && number(data.acquisition_ms) !== null ? elapsed(data.acquisition_ms) : '—'],
    ['Data from GPS', number(data.uart_age_ms) === null ? '—' : ago(Date.now() - data.uart_age_ms - since)]
  ];
  gps.more = [['Valid sentences', label(data.gps_sentences_passed)], ['Checksum errors', label(data.gps_checksum_failed)],
    ['Characters received', label(data.gps_chars_processed)], ['Status reason', REASONS[data.gps_reason] || '—'],
    ['Wiring', 'GPS TX → GPIO16, RX → GPIO17'], ['GPS serial', '9600 baud']];

  const chip = number(data.lora_chip_version), verified = chip !== null && chip >= 0;
  let radio;
  if (typeof data.lora_connected !== 'boolean') radio = { tone: 'idle', pill: 'Unknown', text: 'Waiting for the hub.' };
  else if (data.lora_connected) radio = { tone: fresh ? 'ok' : 'idle', pill: fresh ? 'Ready' : 'Last: ready',
    text: verified ? 'The hub can talk to its radio module.' : 'The hub firmware reports the radio as ready. This pitch firmware does not test it.' };
  else radio = { tone: fresh ? 'bad' : 'idle', pill: fresh ? 'Error' : 'Last: error',
    text: 'The hub could not talk to its radio module (code ' + label(data.lora_error_code) + ').', fix: 'Check the SPI wiring and the 3.3 V supply. GPS keeps working without the radio.' };
  radio.facts = [
    ['Chip version', verified ? '0x' + chip.toString(16).toUpperCase().padStart(2, '0') : chip === null ? '—' : 'Not reported'],
    ['Result code', number(data.lora_error_code) === null ? '—' : data.lora_error_code + (data.lora_error_code === 0 ? ' (OK)' : '')],
    ['Last checked', number(data.lora_check_age_ms) === null ? '—' : ago(Date.now() - data.lora_check_age_ms - since)]
  ];
  radio.more = [['SCK / MISO / MOSI', 'GPIO 18 / 19 / 23'], ['CS / RESET', 'GPIO 5 / 14'], ['DIO0 / DIO1', 'GPIO 26 / 27'], ['Power', '3.3 V + GND']];
  return { hub: hub, gps: gps, radio: radio, linked: linked, seen: Boolean(session.latest) };
}
function fillFacts(list, rows) {
  list.replaceChildren.apply(list, rows.map(function (row) {
    const item = document.createElement('div'), term = document.createElement('dt'), value = document.createElement('dd');
    term.textContent = row[0]; value.textContent = row[1];
    item.append(term, value);
    return item;
  }));
}
function renderHardware() {
  const model = hardwareModel();
  [['hwHub', 'chipHub', model.hub], ['hwGps', 'chipGps', model.gps], ['hwRadio', 'chipRadio', model.radio]].forEach(function (entry) {
    const card = byId(entry[0]), part = entry[2], pill = card.querySelector('.health-pill');
    card.dataset.tone = part.tone;
    pill.dataset.tone = part.tone; pill.textContent = part.pill;
    card.querySelector('.hardware-status').textContent = part.text;
    card.querySelector('.hardware-fix').hidden = !part.fix;
    card.querySelector('.hardware-fix').textContent = part.fix || '';
    fillFacts(card.querySelector('.hardware-facts'), part.facts);
    fillFacts(card.querySelector('.hardware-more'), part.more);
    const chip = byId(entry[1]);
    chip.dataset.tone = part.tone;
    chip.lastElementChild.textContent = part.pill;
  });
  const parts = [['Hub', model.hub], ['GPS', model.gps], ['Radio', model.radio]];
  const named = function (tones) { return parts.filter(function (p) { return tones.includes(p[1].tone); }).map(function (p) { return p[0]; }); };
  const bad = named(['bad']), waiting = named(['warn', 'pending']);
  byId('hardwareSummary').textContent = !model.linked && !model.seen ? 'Connect the hub to check the hardware.'
    : bad.length ? bad.join(' and ') + (bad.length > 1 ? ' need' : ' needs') + ' attention.'
    : waiting.length ? 'Working. Waiting on ' + waiting.join(' and ') + '.'
    : model.linked ? 'Everything is working.' : 'Showing the last values the hub reported.';
}
// Setup guide shown over the map until there is a position to show.
function renderGuide(fix) {
  if (fix) return;
  const session = activeSession(), data = session.latest || {};
  const linked = Boolean(preview || port);
  const receiving = session.stream === 'active';
  const setStep = function (id, state) { byId(id).dataset.state = state; };
  setStep('stepPlug', linked ? 'done' : 'current');
  setStep('stepConnect', linked ? 'done' : connecting ? 'current' : 'todo');
  byId('stepConnectText').textContent = connecting ? 'Choose the ESP32 USB port in the browser dialog.' : 'Press Connect hub and choose its USB port.';
  let fixTitle = 'Wait for satellites', fixText = 'Outdoors with open sky, usually 1–2 minutes.', fixState = linked ? 'current' : 'todo';
  if (linked && !receiving) fixText = session.stream === 'stale' ? 'The hub stopped sending. Check the USB cable.' : 'Waiting for the hub to report…';
  if (receiving && data.gps_state === 'acquisition_timeout') fixText = 'Still searching after 2 minutes. Move to open sky, away from buildings.';
  if (receiving && (data.gps_state === 'uart_silent' || data.gps_state === 'data_error')) {
    fixState = 'error';
    fixTitle = data.gps_state === 'uart_silent' ? 'GPS not responding' : 'GPS data unreadable';
    fixText = data.gps_state === 'uart_silent' ? 'Check GPS power and the TX → GPIO16 wire.' : 'Check the GPS wiring and its 9600 baud setting.';
  }
  setStep('stepFix', fixState);
  byId('stepFixTitle').textContent = fixTitle;
  byId('stepFixText').textContent = fixText;
  const waiting = receiving && fixState !== 'error' && number(data.acquisition_ms) !== null;
  byId('guideTimer').hidden = !waiting;
  if (waiting) byId('guideTimer').textContent = 'Searching for ' + elapsed(data.acquisition_ms);
  byId('guideTitle').textContent = linked ? 'Finding your position' : 'Get your first fix';
  byId('guideActions').hidden = linked || connecting;
}
const TIMELINE_STATES = {
  fixed: 'fixed', starting: 'searching', acquiring: 'searching', acquisition_timeout: 'searching',
  fix_lost: 'lost', uart_silent: 'lost', data_error: 'lost'
};
const TIMELINE_LABELS = { fixed: 'Fix', searching: 'Searching', lost: 'Lost or error' };
function distanceLabel(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km'; }
function shortTime(at) { return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function renderTrip(rows, current) {
  const stats = Telemetry.tripStats(rows), timeline = byId('signalTimeline');
  byId('tripBlock').hidden = !rows.length;
  document.querySelectorAll('[data-group=trip]').forEach(function (cell) { cell.hidden = !rows.length; });
  if (!rows.length) {
    byId('tripRange').textContent = 'No readings yet';
    ['tripDistance', 'tripSignal', 'tripMovement'].forEach(function (id) { byId(id).textContent = '—'; });
    byId('tripSignalNote').textContent = ''; byId('tripMovementNote').textContent = '';
    timeline.replaceChildren(); timeline.setAttribute('aria-label', 'Signal timeline: no readings yet');
    return;
  }
  const streamLive = activeSession().stream === 'active';
  byId('tripRange').textContent = 'Trip since ' + shortTime(stats.start) + (streamLive ? '' : ' · ended ' + shortTime(stats.end));
  byId('tripDistance').textContent = distanceLabel(stats.distance);
  const percent = stats.durationMs > 0 ? Math.round(stats.fixMs / stats.durationMs * 100) : 0;
  byId('tripSignal').textContent = stats.durationMs > 0 ? percent + '%' : '—';
  byId('tripSignalNote').textContent = stats.durationMs > 0 ? elapsed(stats.fixMs) + ' of ' + elapsed(stats.durationMs) : '';
  const stillFor = stats.movedAt === null ? null : Date.now() - stats.movedAt;
  byId('tripMovement').textContent = !current ? 'Unknown' : stillFor !== null && stillFor > 60000 ? 'Stopped' : 'Moving';
  byId('tripMovementNote').textContent = !current ? 'Needs a live fix' : stillFor !== null && stillFor > 60000 ? 'for ' + elapsed(stillFor) : 'in the last minute';
  // Each segment is placed by time, so silent periods stay empty ("No data").
  const groups = Telemetry.segments(rows), total = Math.max(stats.end - stats.start, 1);
  const spans = groups.map(function (group) {
    const kind = TIMELINE_STATES[group.state] || 'searching', span = document.createElement('span');
    span.className = 'timeline-' + kind;
    span.style.left = ((group.start - stats.start) / total * 100) + '%';
    span.style.width = Math.max((group.end - group.start) / total * 100, 0.6) + '%';
    span.title = TIMELINE_LABELS[kind] + ' · ' + shortTime(group.start) + ' · ' + elapsed(group.end - group.start);
    return span;
  });
  timeline.replaceChildren.apply(timeline, spans);
  const last = groups[groups.length - 1];
  timeline.setAttribute('aria-label', 'Signal timeline: ' + percent + '% of the trip with a GPS fix. Currently ' + (TIMELINE_LABELS[TIMELINE_STATES[last.state]] || 'searching').toLowerCase() + '.');
}
const ACCURACY_LABELS = { good: 'Good', fair: 'Fair', poor: 'Poor' };
function renderSatellites(satellites) {
  const target = byId('fixSatellites'), level = Telemetry.satelliteLevel(satellites);
  if (level === null) { target.textContent = '—'; target.title = ''; return; }
  const bars = document.createElement('span');
  bars.className = 'signal-bars'; bars.dataset.level = level; bars.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) bars.append(document.createElement('span'));
  target.replaceChildren(String(satellites), bars);
  target.title = ['No', 'Weak', 'Fair', 'Strong'][level] + ' satellite reception';
}
function positionText(fix) { return fix.latitude.toFixed(6) + ', ' + fix.longitude.toFixed(6); }
function mapsUrl(fix) { return 'https://www.google.com/maps/search/?api=1&query=' + fix.latitude.toFixed(6) + ',' + fix.longitude.toFixed(6); }
function renderPositionActions(fix, current) {
  byId('positionActions').hidden = !fix;
  if (!fix) return;
  byId('mapsLink').href = mapsUrl(fix);
  byId('copyPosition').dataset.state = current ? 'live' : 'last-known';
  byId('sharePosition').hidden = typeof navigator.share !== 'function';
}
const LOG_LABELS = {
  starting: 'GPS starting', acquiring: 'Searching for satellites', acquisition_timeout: 'Still searching',
  fixed: 'Position acquired', fix_lost: 'Signal lost', uart_silent: 'GPS not responding', data_error: 'GPS data unreadable'
};
// Event messages in plain words; GPS state changes are already shown as reading groups.
const EVENT_LABELS = {
  'Hub status stream active': ['Hub sending status', 'event'],
  'Hub started; previous fix retained': ['Hub started', 'event'],
  'Hub reboot detected; previous fix retained': ['Hub restarted', 'event'],
  'Ra-02 responds over SPI': ['Radio ready', 'event'],
  'Ra-02 module error': ['Radio error', 'bad'],
  'Hub stream timed out; latest fix retained': ['Hub stopped sending', 'bad'],
  'USB disconnected; latest fix retained': ['USB disconnected', 'bad'],
  'USB connected': ['USB connected', 'event'],
  'Last valid fix restored from this browser': ['Last fix restored from this browser', 'event'],
  'Serial diagnostic': ['Hub text message', 'event'],
  'Invalid serial message ignored': ['Unreadable message skipped', 'bad'],
  'Oversized serial line ignored': ['Oversized message skipped', 'bad']
};
function clockTime(at) { return new Date(at).toLocaleTimeString(); }
function feedRow(tag, className, text) { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; }
function fillReadingGroup(item, group) {
  const d = group.last.details, hasFix = d.gps_fix && Telemetry.position(d), rating = Telemetry.accuracy(d.hdop);
  item.dataset.tone = TIMELINE_STATES[d.gps_state] || 'searching';
  const details = item.firstElementChild, summary = details.firstElementChild;
  const head = document.createElement('span'); head.className = 'feed-head';
  const time = feedRow('time', '', clockTime(group.start)); time.dateTime = group.first.received_at;
  head.append(feedRow('span', 'feed-title', LOG_LABELS[d.gps_state] || d.gps_state), time);
  const duration = group.count === 1 ? '1 reading' : elapsed(group.end - group.start) + ' · ' + group.count + ' readings';
  const meta = feedRow('span', 'feed-meta', hasFix ? positionText(d) + ' · ' + duration : duration);
  summary.replaceChildren(head, meta);
  fillFacts(details.querySelector('.feed-facts'), [
    ['Started', clockTime(group.start)], ['Duration', group.count === 1 ? '—' : elapsed(group.end - group.start)],
    ['Readings', String(group.count)], ['Position', hasFix ? positionText(d) : 'None'],
    ['Satellites', label(d.satellites)], ['Accuracy', rating ? ACCURACY_LABELS[rating] + ' · HDOP ' + d.hdop.toFixed(1) : '—'],
    ['Reason', REASONS[d.gps_reason] || '—']
  ]);
  details.querySelector('pre').textContent = JSON.stringify(group.last, null, 2);
}
function readingGroupItem(key) {
  const item = document.createElement('li'); item.className = 'feed-item'; item.dataset.key = key;
  const details = document.createElement('details'), summary = document.createElement('summary');
  const facts = document.createElement('dl'); facts.className = 'feed-facts';
  const raw = document.createElement('details'); raw.className = 'feed-raw';
  raw.append(feedRow('summary', '', 'Raw message'), document.createElement('pre'));
  details.append(summary, facts, raw); item.append(details);
  return item;
}
function eventItem(row, key) {
  const known = EVENT_LABELS[row.details.message] || [row.details.message, 'event'];
  const item = document.createElement('li'); item.className = 'feed-item feed-event'; item.dataset.key = key; item.dataset.tone = known[1];
  const head = document.createElement('span'); head.className = 'feed-head';
  const time = feedRow('time', '', clockTime(Date.parse(row.received_at))); time.dateTime = row.received_at;
  head.append(feedRow('span', 'feed-title', known[0]), time);
  item.append(head);
  const extra = row.details.message === 'Ra-02 module error' && row.details.error_code !== undefined ? 'Code ' + row.details.error_code
    : row.details.line || row.details.error || '';
  if (extra) item.append(feedRow('span', 'feed-meta', extra));
  return item;
}
// One feed, newest first: runs of GPS readings plus hub and connection events.
function renderLogs() {
  const session = activeSession();
  const groups = Telemetry.segments(session.logs.filter(function (row) { return row.record_type === 'gps_status' && row.details; }));
  const entries = groups.map(function (group) {
    return { at: group.start, key: 'g' + group.first.sample + group.first.received_at + group.first.details.hub_uptime_ms, group: group };
  }).concat(session.logs.filter(function (row) {
    return row.record_type === 'event' && row.details && typeof row.details.message === 'string' && row.details.message.indexOf('GPS: ') !== 0;
  }).map(function (row, i) {
    return { at: Date.parse(row.received_at), key: 'e' + row.sample + row.received_at + row.details.message, row: row };
  })).sort(function (a, b) { return b.at - a.at; }).slice(0, 60);
  const list = byId('logBody');
  const scrollTop = list.scrollTop, scrollHeight = list.scrollHeight, focused = document.activeElement;
  const existing = new Map(Array.from(list.children).map(function (item) { return [item.dataset.key, item]; }));
  const fragment = document.createDocumentFragment();
  if (!entries.length) fragment.append(feedRow('li', 'empty-log', preview ? 'Sample readings will appear here.' : 'Readings and hub events will appear here.'));
  entries.forEach(function (entry) {
    let item = existing.get(entry.key);
    if (entry.group) {
      if (!item) item = readingGroupItem(entry.key);
      const signature = entry.group.count + ':' + entry.group.end;
      if (item.dataset.signature !== signature) { item.dataset.signature = signature; fillReadingGroup(item, entry.group); }
    } else if (!item) item = eventItem(entry.row, entry.key);
    fragment.append(item);
  });
  list.replaceChildren(fragment);
  if (list.contains(focused)) focused.focus({ preventScroll: true });
  if (scrollTop > 0) list.scrollTop = scrollTop + Math.max(0, list.scrollHeight - scrollHeight);
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
    setConnection();
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
    connecting = true; setConnection();
    reading = false;
    try { await reader.cancel(); } catch (_) { /* Reader may have ended. */ }
    return;
  }
  if (!navigator.serial) { toast('Open the dashboard in desktop Chrome or Edge on localhost to connect to USB serial.'); return; }
  connecting = true; setConnection();
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
    live.stream = 'waiting';
    connecting = false;
    setConnection();
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
  // The sample walker keeps moving at about 5 m/s on a 150 m loop, including while the signal is lost.
  const angle = previewTick * 5 / 150;
  if (fixed) previewFix = {
    latitude: 32.0205 + 150 * Math.sin(angle) / 111195, longitude: 35.8745 + 150 * (1 - Math.cos(angle)) / 94300,
    satellites: t < 13 ? 5 : 8, hdop: t < 13 ? 2.8 : 1.2,
    gps_time_utc: new Date(now).toISOString(), source: 'current_session', age_ms: 0, acquired: now
  };
  const state = t < 5 ? 'starting' : t < 10 ? 'acquiring' : fixed ? 'fixed' : 'fix_lost';
  const snapshot = previewFix ? Object.assign({}, previewFix, { age_ms: now - previewFix.acquired }) : null;
  Telemetry.applyMessage(preview, {
    schema: 'beacon.prototype.v1', type: 'gps_status', hub_uptime_ms: previewTick * 1000,
    gps_state: state, gps_reason: fixed ? 'none' : 'receiver_no_fix', gps_fix: fixed,
    latitude: fixed ? previewFix.latitude : null, longitude: fixed ? previewFix.longitude : null,
    satellites: fixed ? previewFix.satellites : 0, hdop: fixed ? previewFix.hdop : null, gps_age_ms: snapshot ? snapshot.age_ms : null,
    acquisition_ms: fixed ? 0 : t * 1000, uart_age_ms: 50, nmea_age_ms: 50,
    gps_chars_processed: t * 500, gps_sentences_passed: t * 6, gps_checksum_failed: 0,
    lora_connected: !(t >= 28 && t < 31), lora_status: t >= 28 && t < 31 ? 'error' : 'ready',
    lora_error_code: t >= 28 && t < 31 ? -2 : 0, lora_chip_version: 18, lora_check_age_ms: 500,
    storage_status: 'ready', last_fix: snapshot
  }, now);
  renderLogs();
}
byId('connectButton').addEventListener('click', connectHub);
byId('guideConnect').addEventListener('click', connectHub);
byId('guideSample').addEventListener('click', function () { byId('previewMode').click(); });
byId('liveMode').addEventListener('click', function () {
  if (!preview) return;
  clearInterval(previewTimer); previewTimer = null; preview = null;
  setConnection(); renderLogs();
});
byId('previewMode').addEventListener('click', function () {
  if (preview) return;
  if (port || connecting) { toast('Disconnect the hub before viewing sample data.'); return; }
  preview = Telemetry.createSession(null, true);
  previewTick = 0; previewFix = null;
  setConnection();
  previewStep();
  previewTimer = setInterval(previewStep, 1000);
});
byId('copyPosition').addEventListener('click', function () {
  const fix = activeSession().lastFix;
  if (!fix) return;
  const text = positionText(fix);
  const done = function () { toast('Copied ' + text); };
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(text).then(done, function () { toast('Copy unavailable. Coordinates: ' + text); });
  else toast('Copy unavailable. Coordinates: ' + text);
});
byId('sharePosition').addEventListener('click', function () {
  const fix = activeSession().lastFix;
  if (!fix || typeof navigator.share !== 'function') return;
  const state = byId('copyPosition').dataset.state === 'live' ? 'Live position' : 'Last known position';
  const when = fix.gps_time_utc || fix.captured_at;
  navigator.share({
    title: 'DarbJo position',
    text: (preview ? 'Sample · ' : '') + state + ': ' + positionText(fix) + (when ? ' (' + timeLabel(when) + ')' : ''),
    url: mapsUrl(fix)
  }).catch(function (error) { if (error.name !== 'AbortError') toast('Could not share: ' + error.message); });
});
byId('exportLogs').addEventListener('click', function () {
  const url = URL.createObjectURL(new Blob([Telemetry.exportLines(activeSession())], { type: 'application/x-ndjson' }));
  const link = document.createElement('a'); link.href = url;
  link.download = 'darbjo-' + (preview ? 'preview-' : 'hub-') + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl';
  link.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
});
// Clearing needs a second click within a few seconds; it removes saved records.
let clearTimer = null;
function disarmClear() {
  clearTimeout(clearTimer); clearTimer = null;
  byId('clearLogs').textContent = 'Clear';
  byId('clearLogs').classList.remove('armed');
}
byId('clearLogs').addEventListener('click', function () {
  if (!clearTimer) {
    byId('clearLogs').textContent = 'Clear all?';
    byId('clearLogs').classList.add('armed');
    clearTimer = setTimeout(disarmClear, 4000);
    toast('Press “Clear all?” again to delete ' + activeSession().logs.length + ' records. Export first to keep a copy.');
    return;
  }
  disarmClear();
  const count = activeSession().logs.length;
  activeSession().logs = [];
  if (!preview) { cacheDirty = true; flushCache(); }
  renderLogs();
  toast(count + ' records cleared. The last known position is kept.');
});
byId('clearLogs').addEventListener('blur', function () { if (clearTimer) disarmClear(); });
window.addEventListener('beforeunload', flushCache);
setInterval(function () {
  if (port && live.lastMessageAt !== null && Date.now() - live.lastMessageAt > 5000) {
    Telemetry.markUnavailable(live, 'stale', Date.now());
    cacheDirty = true;
  }
  renderSummary();
}, 1000);
setInterval(flushCache, 5000);
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
