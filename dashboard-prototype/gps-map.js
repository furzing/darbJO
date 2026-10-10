(function () {
  'use strict';
  let map = null, marker = null, latestFix = null, following = true, context = null;
  let lastPoint = null, tileErrors = 0, tilesFailing = false, trailLayer = null, trailParts = [], trailKey = '';
  let regions = [], offlineLayers = [], offlineRenderer = null;
  let emergencies = [], centeredEmergency = null;
  const emergencyMarkers = new Map();
  const sourceLabels = { live_at_trigger: 'GPS fix at request', last_known: 'Last known fix · position unconfirmed',
    after_trigger: 'First GPS fix after request', unavailable: 'Location unavailable' };
  const el = function (id) { return document.getElementById(id); };

  // Offline basemap colors, from the console palette.
  const OFFLINE_STYLE = {
    green: { stroke: false, fillColor: '#dfe4cb', fillOpacity: 1 },
    water: { color: '#a9c4c9', weight: 2, fillColor: '#c6d8da', fillOpacity: 1 },
    buildings: { color: '#d4ccb9', weight: 1, fillColor: '#e4ddcd', fillOpacity: 1 },
    paths: { color: '#a99d85', weight: 1.5, dashArray: '2 4' },
    minorCasing: { color: '#d8d1c1', weight: 6 },
    minor: { color: '#fbfaf6', weight: 4 },
    majorCasing: { color: '#cfb27a', weight: 9 },
    major: { color: '#efd9a6', weight: 7 }
  };

  function notice(message) {
    el('mapNotice').textContent = message;
    el('mapNotice').hidden = !message;
  }
  function regionAt(point) {
    return regions.find(function (region) {
      const b = region.bounds;
      return point && point[0] >= b[0] && point[0] <= b[2] && point[1] >= b[1] && point[1] <= b[3];
    }) || null;
  }
  // Only matters once there is a position on the map; the setup guide covers it before that.
  function renderNotice() {
    if (!tilesFailing || !latestFix) { notice(''); return; }
    const region = regionAt([latestFix.latitude, latestFix.longitude]);
    notice(region && region.loaded ? 'Offline map · ' + region.name : 'No offline map for this area · position still shown');
  }
  function setFollowing(value) {
    following = value;
    el('followMap').setAttribute('aria-pressed', String(value));
    el('followMap').textContent = value ? 'Following' : 'Follow';
  }

  // Draws OpenStreetMap geometry from maps/<id>.json below the online tiles. Online tiles cover it;
  // failed tiles are hidden, so it shows wherever the internet map is missing.
  function loadOfflineMaps() {
    map.createPane('offline').style.zIndex = 150;
    offlineRenderer = L.canvas({ pane: 'offline', padding: 0.5 });
    fetch('maps/regions.json').then(function (response) { return response.json(); }).then(function (list) {
      regions = list;
      return Promise.all(list.map(function (region) {
        return fetch('maps/' + region.id + '.json')
          .then(function (response) { if (!response.ok) throw new Error(response.status); return response.json(); })
          .then(function (data) { drawRegion(data); region.loaded = true; })
          .catch(function () { region.loaded = false; });
      }));
    }).then(renderNotice).catch(function () { regions = []; });
  }
  function drawRegion(data) {
    const options = function (name) { return Object.assign({ renderer: offlineRenderer, interactive: false, lineCap: 'round', lineJoin: 'round' }, OFFLINE_STYLE[name]); };
    const points = function (flat) {
      const out = [];
      for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
      return out;
    };
    const group = L.layerGroup();
    const add = function (layer, style, polygon) {
      (data.layers[layer] || []).forEach(function (flat) {
        const shape = polygon ? L.polygon(points(flat), options(style)) : L.polyline(points(flat), options(style));
        shape.baseWeight = OFFLINE_STYLE[style].weight;
        group.addLayer(shape);
      });
    };
    add('green', 'green', true);
    add('water', 'water', true);
    add('buildings', 'buildings', true);
    add('paths', 'paths', false);
    add('minor', 'minorCasing', false);
    add('major', 'majorCasing', false);
    add('minor', 'minor', false);
    add('major', 'major', false);
    group.addTo(map);
    offlineLayers.push(group);
    scaleOffline();
  }
  // Fixed pixel road widths crowd the map when zoomed out.
  function scaleOffline() {
    const zoom = map.getZoom(), scale = zoom >= 17 ? 1.3 : zoom >= 16 ? 1 : zoom >= 15 ? 0.7 : 0.45;
    offlineLayers.forEach(function (group) {
      group.eachLayer(function (shape) { if (shape.baseWeight) shape.setStyle({ weight: shape.baseWeight * scale }); });
    });
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
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      detectRetina: false
    });
    tiles.on('loading', function () { tileErrors = 0; });
    tiles.on('tileerror', function (event) {
      event.tile.style.visibility = 'hidden';
      tileErrors += 1;
      if (!tilesFailing) { tilesFailing = true; renderNotice(); }
    });
    tiles.on('tileload', function (event) { event.tile.style.visibility = ''; });
    tiles.on('load', function () {
      tilesFailing = tileErrors > 0;
      renderNotice();
    });
    tiles.addTo(map);
    loadOfflineMaps();
    trailLayer = L.layerGroup().addTo(map);
    map.on('zoomend', scaleOffline);
    map.on('dragstart', function () { setFollowing(false); });
    el('gpsMap').addEventListener('keydown', function (event) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '-'].includes(event.key)) setFollowing(false);
    });
    el('mapZoomIn').addEventListener('click', function () { map.zoomIn(); });
    el('mapZoomOut').addEventListener('click', function () { map.zoomOut(); });
    el('followMap').addEventListener('click', function () {
      setFollowing(!following);
      if (following && latestFix) map.setView([latestFix.latitude, latestFix.longitude], Math.max(map.getZoom(), 16), { animate: false });
    });
    renderTrail();
    renderMarker();
    renderEmergencies();
  }
  // Solid lines are runs of consecutive fixes; dashed lines bridge signal gaps.
  function renderTrail() {
    if (!map) return;
    const last = trailParts.length ? trailParts[trailParts.length - 1] : null;
    const key = trailParts.map(function (part) { return part.length; }).join(',') + (last ? ':' + last[last.length - 1].join(',') : '');
    if (key === trailKey) return;
    trailKey = key;
    trailLayer.clearLayers();
    trailParts.forEach(function (part, i) {
      if (i > 0) {
        const previous = trailParts[i - 1];
        L.polyline([previous[previous.length - 1], part[0]], { color: '#8a6a4f', weight: 2, opacity: .7, dashArray: '3 7', interactive: false }).addTo(trailLayer);
      }
      if (part.length > 1) L.polyline(part, { color: '#58664b', weight: 4, opacity: .75, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(trailLayer);
    });
    if (marker) marker.bringToFront();
  }
  function renderMarker() {
    const anyPosition = Boolean(latestFix) || emergencies.some(window.BeaconTelemetry.position);
    el('mapEmpty').hidden = anyPosition;
    el('mapTools').hidden = !anyPosition;
    el('followMap').disabled = !latestFix;
    if (!map) return;
    if (!latestFix) {
      if (marker) { marker.remove(); marker = null; }
      lastPoint = null;
      renderNotice();
      return;
    }
    const point = [latestFix.latitude, latestFix.longitude];
    const live = context && context.current;
    const caption = live ? 'Live' : 'Last known';
    const color = live ? '#25352b' : '#a65032';
    if (!marker) {
      marker = L.circleMarker(point, { radius: 9, weight: 4, color: '#fbfaf6', fillColor: color, fillOpacity: 1 }).addTo(map);
      marker.bindTooltip(caption, { permanent: true, direction: 'right', offset: [14, 0], className: 'fix-tooltip' });
    } else {
      marker.setLatLng(point).setStyle({ fillColor: color });
      marker.setTooltipContent(caption);
    }
    el('gpsMap').setAttribute('aria-label', (context && context.sample ? 'Sample ' : '') + caption + ' GPS position: latitude ' + point[0].toFixed(6) + ', longitude ' + point[1].toFixed(6));
    if (!lastPoint) map.setView(point, 17, { animate: false });
    else if (following && (point[0] !== lastPoint[0] || point[1] !== lastPoint[1])) map.panTo(point, { animate: false });
    if (!lastPoint || regionAt(point) !== regionAt(lastPoint)) renderNotice();
    lastPoint = point;
  }
  function locateEmergency(id) {
    const record = emergencies.find(function (item) { return item.id === id; });
    if (!map || !window.BeaconTelemetry.position(record)) return;
    setFollowing(false);
    map.setView([record.latitude, record.longitude], Math.max(map.getZoom(), 14), { animate: false });
    const entry = emergencyMarkers.get(id);
    if (entry) entry.marker.openPopup();
  }
  function popup(record) {
    const box = document.createElement('div'); box.className = 'emergency-popup';
    const title = document.createElement('strong');
    title.textContent = (context.sample ? 'Sample · ' : '') + 'Emergency request'; box.append(title);
    [record.node_id + (record.seen_at ? ' · Seen' : ' · Unseen'), sourceLabels[record.location_source],
      record.latitude.toFixed(6) + '°, ' + record.longitude.toFixed(6) + '°',
      'Received ' + new Date(record.received_at).toLocaleString(),
      record.position_time_utc ? 'GPS fix ' + new Date(record.position_time_utc).toLocaleString() : 'GPS fix time unavailable'
    ].forEach(function (text) { const p = document.createElement('p'); p.textContent = text; box.append(p); });
    return box;
  }
  function renderEmergencies() {
    if (!map) return;
    const located = emergencies.filter(window.BeaconTelemetry.position);
    const ids = new Set(located.map(function (record) { return record.id; }));
    emergencyMarkers.forEach(function (entry, id) {
      if (!ids.has(id)) { entry.marker.remove(); emergencyMarkers.delete(id); }
    });
    located.forEach(function (record) {
      let entry = emergencyMarkers.get(record.id);
      const signature = [record.location_source, record.latitude, record.longitude, record.seen_at].join('|');
      if (!entry) {
        const dot = L.circleMarker([record.latitude, record.longitude], {
          radius:14, weight:3, color:'#fbfaf6', fillColor:'#9c302b', fillOpacity:1
        }).addTo(map);
        dot.bindTooltip((context.sample ? 'Sample · ' : '') + 'Emergency request', { className:'emergency-tooltip', direction:'top' });
        dot.bindPopup(popup(record));
        const path = dot.getElement();
        if (path) {
          path.setAttribute('tabindex', '0'); path.setAttribute('role', 'button');
          path.setAttribute('aria-label', 'Emergency request from ' + record.node_id + ' at ' + record.latitude + ', ' + record.longitude);
          path.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); dot.openPopup(); }
          });
        }
        entry = { marker:dot, signature:signature }; emergencyMarkers.set(record.id, entry);
      } else if (entry.signature !== signature) {
        entry.marker.setLatLng([record.latitude, record.longitude]).setPopupContent(popup(record));
        entry.signature = signature;
      }
      entry.marker.setStyle({ fillOpacity:record.seen_at ? .6 : 1 });
      entry.marker.bringToFront();
    });
    const newest = located.filter(function (record) { return !record.seen_at; }).slice(-1)[0];
    if (newest && newest.id !== centeredEmergency) {
      centeredEmergency = newest.id;
      locateEmergency(newest.id);
    }
    if (located.length) el('gpsMap').setAttribute('aria-label', 'GPS position map with ' + located.length + ' emergency request locations.');
  }
  function update(fix, current, sample, trail, alerts) {
    const switched = context && context.sample !== sample;
    context = { current: current, sample: sample };
    latestFix = window.BeaconTelemetry.position(fix) ? fix : null;
    emergencies = Array.isArray(alerts) ? alerts : [];
    if (switched) {
      lastPoint = null; centeredEmergency = null; setFollowing(true);
      emergencyMarkers.forEach(function (entry) { entry.marker.remove(); }); emergencyMarkers.clear();
    }
    trailParts = trail || [];
    renderTrail();
    if (!latestFix) el('gpsMap').setAttribute('aria-label', 'GPS position map. No valid position acquired.');
    renderMarker();
    renderEmergencies();
  }
  window.DarbMap = { show: initialize, update: update, locateEmergency: locateEmergency };
})();
