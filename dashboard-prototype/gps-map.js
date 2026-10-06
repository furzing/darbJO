(function () {
  'use strict';
  let map = null, marker = null, latestFix = null, following = true, context = null;
  let lastPoint = null, tileErrors = 0;
  const el = function (id) { return document.getElementById(id); };
  function notice(message) {
    el('mapNotice').textContent = message;
    el('mapNotice').hidden = !message;
  }
  function setFollowing(value) {
    following = value;
    el('followMap').setAttribute('aria-pressed', String(value));
    el('followMap').textContent = value ? 'Following' : 'Follow fix';
  }
  function initialize() {
    if (map) { map.invalidateSize({ animate: false }); return; }
    if (!window.L) { notice('Map library unavailable. GPS coordinates and logs remain available below.'); return; }
    map = L.map('gpsMap', {
      zoomControl: false, scrollWheelZoom: false, center: [31.25, 36.2], zoom: 7,
      minZoom: 2, maxZoom: 19, zoomAnimation: false, fadeAnimation: false,
      markerZoomAnimation: false
    });
    map.attributionControl.setPrefix(false);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      detectRetina: false
    });
    tiles.on('loading', function () { tileErrors = 0; });
    tiles.on('tileerror', function () {
      tileErrors += 1;
      notice('Basemap unavailable. GPS coordinates, marker and logs are still available.');
    });
    tiles.on('load', function () {
      notice(tileErrors ? 'Some map tiles are unavailable. GPS coordinates and logs are still available.' : '');
    });
    tiles.addTo(map);
    map.on('dragstart', function () { setFollowing(false); });
    el('gpsMap').addEventListener('keydown', function (event) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '-'].includes(event.key)) setFollowing(false);
    });
    el('mapZoomIn').addEventListener('click', function () { map.zoomIn(); });
    el('mapZoomOut').addEventListener('click', function () { map.zoomOut(); });
    el('centerMap').addEventListener('click', function () {
      if (latestFix) { setFollowing(true); map.setView([latestFix.latitude, latestFix.longitude], Math.max(map.getZoom(), 14), { animate: false }); }
    });
    el('followMap').addEventListener('click', function () {
      setFollowing(!following);
      if (following && latestFix) map.panTo([latestFix.latitude, latestFix.longitude], { animate: false });
    });
    renderMarker();
  }
  function renderMarker() {
    el('mapEmpty').hidden = Boolean(latestFix);
    el('centerMap').disabled = !latestFix;
    el('followMap').disabled = !latestFix;
    if (!map) return;
    if (!latestFix) {
      if (marker) { marker.remove(); marker = null; }
      lastPoint = null;
      return;
    }
    const point = [latestFix.latitude, latestFix.longitude];
    const live = context && context.current;
    const caption = (context && context.sample ? 'Sample · ' : '') + (live ? 'Live GPS fix' : 'Last known fix');
    const color = live ? '#25352b' : '#a65032';
    if (!marker) {
      marker = L.circleMarker(point, { radius: 9, weight: 4, color: '#fbfaf6', fillColor: color, fillOpacity: 1 }).addTo(map);
      marker.bindTooltip(caption, { permanent: true, direction: 'right', offset: [14, 0], className: 'fix-tooltip' });
    } else {
      marker.setLatLng(point).setStyle({ fillColor: color });
      marker.setTooltipContent(caption);
    }
    el('gpsMap').setAttribute('aria-label', caption + ': latitude ' + point[0].toFixed(6) + ', longitude ' + point[1].toFixed(6));
    if (!lastPoint) map.setView(point, 14, { animate: false });
    else if (following && (point[0] !== lastPoint[0] || point[1] !== lastPoint[1])) map.panTo(point, { animate: false });
    lastPoint = point;
  }
  function update(fix, current, sample) {
    const switched = context && context.sample !== sample;
    context = { current: current, sample: sample };
    latestFix = window.BeaconTelemetry.position(fix) ? fix : null;
    if (switched) { lastPoint = null; setFollowing(true); }
    if (!latestFix) el('gpsMap').setAttribute('aria-label', 'GPS position map. No valid position acquired.');
    renderMarker();
  }
  window.DarbMap = { show: initialize, update: update };
})();
