# DarbJo — pitch interface

A hero-only landing page and a local GPS console for the DarbJo pitch. Editorial typography, warm sand, olive, and a generated Jordan-inspired landscape; no decorative icon set or external fonts.

## Pages

- Home: `/#/` — brand hero.
- Live console: `/#/console` — GPS map, latest fix details, readings and events on the right.
- Hardware: `/#/hardware` — Ra-02 SPI status, GPS reception diagnostics, storage status, and the proposed wiring.

Pages share one serial session. Navigation between them keeps the connection running. Reloading the document closes it; reconnect to resume.

## Run

Requires Node.js 18 or newer. No dependency installation or build step is needed.

Run `npm start` from this folder and open http://127.0.0.1:4173 in desktop Chrome or Edge. Connect to the ESP32 USB port at 115200 baud. Close Arduino Serial Monitor first.

The latest valid coordinates and map marker remain visible as LAST KNOWN when reception is lost, USB disconnects, or the browser reloads. Acquisition time, satellites and HDOP at the fix are retained separately from current reception diagnostics. Hub flash can also provide an earlier fix after reboot. The map uses GPS data from the hub, never browser geolocation. With no valid fix there is no position marker.

The map follows new fixes. Drag the map to stop following; use Follow fix or Locate fix to return. Olive marks a live reading; clay marks a historical one. Sample markers are labeled explicitly.

Logs retain the newest 2,000 real records locally; the console shows the newest 60 GPS readings or events. Expand a reading for the complete JSON message, or Export the retained JSONL log. Keep the same browser and localhost port for saved records. Browser storage failure is reported, and Export remains available.

Preview runs sample acquisition → valid fix → loss → recovery, plus a module error. It keeps sample records separate and never overwrites real saved fixes/logs.

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

## Map dependencies and indoor use

Leaflet 1.9.4 and its BSD license are vendored in `vendor/`. OpenStreetMap supplies the basemap and attribution is visible on the map. Normal tile requests require internet and disclose the viewed map area to the tile provider; GPS records are stored locally. No bulk tile download or offline tile cache is implemented.

If tiles fail, the console shows a basemap warning. The coordinate readout, GPS marker, details, and logs continue to work. Use the pre-pitch outdoor fix for an underground venue. The hero image and map library are served locally.

References: [Leaflet](https://leafletjs.com/reference.html), [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/).

Run the state/error-handling checks with:
node --test tests/telemetry-state.test.js
