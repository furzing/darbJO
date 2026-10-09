# DarbJo — pitch interface

A hero-only landing page and a local GPS console for the DarbJo pitch. Editorial typography, warm sand, olive, and a generated Jordan-inspired landscape; no decorative icon set or external fonts.

## Pages

- Home: `/#/` — brand hero.
- Live console: `/#/console` — GPS map, latest fix details, readings and events on the right.
- Hardware: `/#/hardware` — a health check for the hub, GPS and radio: status, what to do when something is wrong, key readings, and wiring under More details. The console shows the same three statuses in a strip under the map.

Until there is a position, the console map shows a three-step setup guide (plug in, connect, wait for satellites) with a search timer and wiring hints for GPS errors.

Pages share one serial session. Navigation between them keeps the connection running. Reloading the document closes it; reconnect to resume.

## Run

Requires Node.js 18 or newer. No dependency installation or build step is needed.

Run `npm start` from this folder and open http://127.0.0.1:4173 in desktop Chrome or Edge. Connect to the ESP32 USB port at 115200 baud. Close Arduino Serial Monitor first.

The latest valid coordinates and map marker remain visible as LAST KNOWN when reception is lost, USB disconnects, or the browser reloads. Acquisition time, satellites and HDOP at the fix are retained separately from current reception diagnostics. Hub flash can also provide an earlier fix after reboot. The map uses GPS data from the hub, never browser geolocation. With no valid fix there is no position marker.

The map follows new fixes. Drag the map to stop following; use Follow fix or Locate fix to return. Olive marks a live reading; clay marks a historical one. Sample markers are labeled explicitly. The map draws the current trip's trail: solid while there is a fix, dashed across signal gaps. A trip ends after 30 minutes without readings.

This trip shows distance moved (steps under 8 m are treated as GPS jitter, implied speeds over 12 m/s and gaps over 60 s are skipped), share of time with a fix, and whether the device is moving or stopped (live fix only). The signal timeline colors the trip by fix, searching, lost, and no data. Accuracy is a Good/Fair/Poor rating of HDOP (≤2, ≤5, above), not meters.

Logs retain the newest 2,000 real records locally; the field log is one feed, newest first: runs of readings with the same GPS state (one entry each) plus hub and connection events, 60 entries shown. Expand a reading entry for its details and raw JSON, or Export the retained JSONL log. Clear asks for a second click and keeps the last known position. Keep the same browser and localhost port for saved records. Browser storage failure is reported, and Export remains available.

The status bar at the top says what is happening now (Live, Searching, Signal lost, Hub stopped sending…). The Live hub / Sample switch picks the data source. Sample runs acquisition → valid fix → loss → recovery with a walking position, plus a module error. It keeps sample records separate and never overwrites real saved fixes/logs.

Before the pitch, get a real outdoor fix, allow a minute for the hub flash checkpoint or move indoors while powered, and export logs as backup.

The serial contract is in [docs/serial-interface.md](docs/serial-interface.md).

This repository contains software only. Firmware, hardware captures, exported GPS logs, and business/presentation files are excluded. The current pitch firmware presets LoRa readiness; the dashboard displays the supplied status without independently verifying hardware.

## GitHub setup

Create an empty GitHub repository, then run from this folder:

```sh
git commit -m "Initial DarbJo dashboard"
git remote add origin <your-github-repository-url>
git push -u origin main
```

No remote repository or public deployment is configured. USB serial requires localhost or an HTTPS secure context and a supported browser. `npm start` serves locally on 127.0.0.1.

## Map dependencies and offline use

Leaflet 1.9.4 and its BSD license are vendored in `vendor/`. Online, OpenStreetMap tiles are the basemap; tile requests disclose the viewed area to the tile provider.

Offline (no internet, e.g. a closed pitch venue), failed tiles are hidden and a bundled offline map shows instead: OpenStreetMap roads, paths, buildings, water and green areas for the regions in `maps/regions.json` (pitch venue UJ / Academy and Petra). The map says "Offline map · <region>"; outside those regions the marker, trail, coordinates and logs still work on a plain background. No tiles are bulk-downloaded.

To add or refresh a region (needs internet): add its `[south, west, north, east]` bounds to `maps/regions.json`, then run `node tools/fetch-offline-map.js [region-id]`. Data © OpenStreetMap contributors, ODbL 1.0.

Before an indoor pitch: get a real fix outdoors near the venue, let the hub checkpoint it, and confirm the console shows it as LAST KNOWN on the offline map with the internet off.

References: [Leaflet](https://leafletjs.com/reference.html), [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/).

Run the state/error-handling checks with:
node --test tests/telemetry-state.test.js
