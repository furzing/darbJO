// Downloads OpenStreetMap geometry for the offline map regions into maps/<id>.json.
// Run with internet before going to a venue: node tools/fetch-offline-map.js [region-id]
// Data © OpenStreetMap contributors, ODbL 1.0. One small Overpass query per region.
const fs = require('node:fs');
const path = require('node:path');

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const REGIONS = require('../maps/regions.json');

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const PATHS = new Set(['footway', 'path', 'track', 'steps', 'pedestrian', 'cycleway', 'bridleway']);
const GREEN = new Set(['park', 'garden', 'grass', 'recreation_ground', 'pitch', 'forest', 'meadow', 'orchard', 'cemetery', 'wood', 'scrub']);

function query(bounds) {
  const box = bounds.join(',');
  return '[out:json][timeout:90];(' +
    'way["highway"](' + box + ');' +
    'way["building"](' + box + ');' +
    'way["natural"~"water|wood|scrub"](' + box + ');' +
    'way["waterway"](' + box + ');' +
    'way["landuse"~"grass|forest|meadow|orchard|cemetery|recreation_ground"](' + box + ');' +
    'way["leisure"~"park|garden|pitch"](' + box + ');' +
    ');out geom;';
}

function layer(tags) {
  if (tags.highway) return MAJOR.has(tags.highway) ? 'major' : PATHS.has(tags.highway) ? 'paths' : 'minor';
  if (tags.building) return 'buildings';
  if (tags.waterway || tags.natural === 'water') return 'water';
  if (GREEN.has(tags.leisure) || GREEN.has(tags.landuse) || GREEN.has(tags.natural)) return 'green';
  return null;
}

// Public Overpass servers are often busy, so try each one up to twice.
async function download(region) {
  const errors = [];
  for (const endpoint of ENDPOINTS.concat(ENDPOINTS)) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'DarbJo-dashboard/0.1 offline-map-prep' },
        body: 'data=' + encodeURIComponent(query(region.bounds))
      });
      if (!response.ok) throw new Error(endpoint + ' returned ' + response.status);
      return await response.json();
    } catch (error) {
      errors.push(error.message);
      await new Promise(function (resolve) { setTimeout(resolve, 5000); });
    }
  }
  throw new Error(errors.join('; '));
}

async function build(region) {
  const data = await download(region);
  const layers = { green: [], water: [], buildings: [], paths: [], minor: [], major: [] };
  data.elements.forEach(function (way) {
    const name = way.tags && layer(way.tags);
    if (!name || !way.geometry || way.geometry.length < 2) return;
    // Flat [lat, lon, lat, lon, ...] at 5 decimals (about 1 m).
    layers[name].push(way.geometry.flatMap(function (p) { return [+p.lat.toFixed(5), +p.lon.toFixed(5)]; }));
  });
  const output = {
    id: region.id, name: region.name, bounds: region.bounds,
    downloaded: new Date().toISOString().slice(0, 10),
    attribution: '© OpenStreetMap contributors, ODbL 1.0',
    layers: layers
  };
  const file = path.join(__dirname, '..', 'maps', region.id + '.json');
  fs.writeFileSync(file, JSON.stringify(output));
  const counts = Object.keys(layers).map(function (key) { return key + ' ' + layers[key].length; }).join(', ');
  process.stdout.write(region.id + ': ' + counts + ' · ' + Math.round(fs.statSync(file).size / 1024) + ' KB\n');
}

(async function () {
  const only = process.argv[2];
  const regions = REGIONS.filter(function (region) { return !only || region.id === only; });
  if (!regions.length) throw new Error('Unknown region ' + only);
  for (const region of regions) await build(region);
})().catch(function (error) {
  process.stderr.write('Offline map download failed: ' + error.message + '\n');
  process.exitCode = 1;
});
