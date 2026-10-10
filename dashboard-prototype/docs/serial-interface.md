# Final-day two-board firmware

The ESP32-S3 node reads GPS and sends emergency requests through its Ra-02 to
the classic ESP32 hub. The hub reports actual local SPI health and remote node
link state. The JSON schema remains compatible; see the final-day extension
below for node-link fields, emergency locations and local seen status.

# Earlier GPS-only fallback note

The GPS-only pitch firmware presets LoRa connected/ready with error code 0, chip version -1, and check age 0. It performs no SPI radio check. GPS status and retained coordinates are actual receiver data. The general protocol below also describes the original hardware-check firmware for future integration.

# Pitch Hub — Software Interface

## Hardware and purpose

One classic ESP32 hub checks its attached Ra-02 SPI module and reads its GY-NEO6MV2 GPS. USB serial carries module/GPS status to the laptop. The Ra-02 connection indicator means the local module is responding to the ESP32; it does not represent a connection to another radio.

The dashboard must show GPS acquisition and failures while preserving the most recent valid coordinates, timestamps, reception details, and logs. A startup indoors may have no fix at all. Cold start and blocked satellite reception cannot be conclusively distinguished from these measurements, so use "acquiring / possible cold start", not a claimed cold-start diagnosis.

## Transport

UTF-8 JSON Lines at 115200 baud, 8-N-1. Ignore blank lines and report malformed/unsupported messages without crashing. Firmware reports GPS status approximately once per second and checks the radio every five seconds. A radio error is retried without halting GPS. Dashboard marks the stream stale if status messages stop for five seconds.

The schema remains beacon.prototype.v1, with the expanded fields below. Older dashboard code must be updated to support these fields and retained fixes.

## Startup

~~~json
{"schema":"beacon.prototype.v1","type":"hub_ready"}
~~~

This announces firmware startup. Module readiness is determined from the next gps_status message. Keep the previous fix when the hub reboots.

## Live GPS status example

~~~json
{
  "schema":"beacon.prototype.v1",
  "type":"gps_status",
  "hub_uptime_ms":30000,
  "gps_state":"fixed",
  "gps_reason":"none",
  "gps_fix":true,
  "acquisition_ms":0,
  "latitude":31.953900,
  "longitude":35.910600,
  "satellites":8,
  "hdop":1.2,
  "gps_age_ms":350,
  "uart_age_ms":25,
  "nmea_age_ms":50,
  "gps_chars_processed":15000,
  "gps_sentences_passed":180,
  "gps_checksum_failed":0,
  "lora_connected":true,
  "lora_status":"ready",
  "lora_error_code":0,
  "lora_chip_version":18,
  "lora_check_age_ms":500,
  "storage_status":"ready",
  "last_fix":{
    "latitude":31.953900,
    "longitude":35.910600,
    "satellites":8,
    "hdop":1.2,
    "gps_time_utc":"2026-10-06T12:00:00Z",
    "source":"current_session",
    "age_ms":350
  }
}
~~~

## GPS states

| gps_state | Meaning and display |
|---|---|
| starting | First startup seconds before valid GPS data arrives. |
| acquiring | Valid NMEA arrives, but no fresh location yet. Show "Acquiring satellites / possible cold start". |
| acquisition_timeout | No first fix after 120 seconds while valid NMEA continues. Show a reception warning, keep searching, retain saved coordinates. |
| fixed | A location no older than 10 seconds, valid NMEA within five seconds, and the receiver has not subsequently reported no fix. |
| fix_lost | A fix was acquired this boot and is now unavailable. Keep the last fix visible with a historical label. |
| uart_silent | No first fix and no UART bytes within five seconds after the initial grace period. Check power, TX/RX wiring, and baud. |
| data_error | UART bytes arrive, but no checksum-valid NMEA within five seconds. Show parse/baud/wiring error details. |

gps_reason supplies none, receiver_no_fix, uart_silent, invalid_nmea, or stale_location. It distinguishes a receiver reporting no fix from serial silence and parsing failure. Latest valid GGA quality or RMC status can mark a fix lost immediately; the library's latched location.isValid() alone is insufficient.

## Field meanings

| Field | Meaning |
|---|---|
| hub_uptime_ms | Milliseconds since hub boot; a decrease signals a new boot. |
| gps_fix | True only for a fresh current-session fix. Saved fixes do not make this true. |
| latitude, longitude | Live decimal degrees; null when gps_fix is false. |
| satellites | Satellites used, as reported in GGA; null when unavailable/stale. This is not satellites in view. |
| hdop | Horizontal dilution of precision; null when unavailable/stale. It is not accuracy in meters. |
| gps_age_ms | Age of the current-session latest position; null if none acquired this boot. |
| acquisition_ms | Time spent waiting since boot or loss; zero while fixed. |
| uart_age_ms, nmea_age_ms | Time since the last UART byte / valid NMEA sentence, or null before available. |
| gps_chars_processed | Cumulative GPS UART characters parsed this boot. |
| gps_sentences_passed, gps_checksum_failed | Cumulative checksum successes/failures this boot. |
| lora_connected | Successful initialization and a matching chip-version register response on the latest check. |
| lora_status | ready or error. A local hardware status. |
| lora_error_code | RadioLib result code. Zero is success. Preserve the numeric failure code in logs. |
| lora_chip_version | Latest register value, or -1 when unknown. 18 is hexadecimal 0x12. |
| lora_check_age_ms | Age of the latest SPI check. |
| storage_status | ready, unavailable, or write_error for hub flash storage. |
| last_fix | Most recent valid fix object, or null before any fix has been captured/restored. |

last_fix contains coordinates, satellites and HDOP at capture, optional GPS UTC time, source, and age_ms. source is current_session or saved. age_ms is null for a flash-restored fix because uptime from an earlier boot cannot establish its age. If GPS UTC is missing, show an unknown acquisition time rather than inventing one.

On reception loss, live latitude/longitude become null and last_fix remains populated. On an indoor reboot, last_fix may restore from flash while gps_state is acquiring. The UI must display LAST KNOWN or SAVED FIX and never call these coordinates live.

## Retention and logs

- Preserve the latest valid position across no-fix messages, receiver errors, malformed serial lines, radio errors, USB disconnect, reboot, and page reload.
- Save real fixes and the newest 2,000 log records in local browser storage. Storage failure must keep the current session working and prompt log export.
- Keep detailed readings: laptop receive time, GPS UTC when available, coordinates and fix state, satellites, HDOP, fix age, acquisition wait, UART/NMEA ages, checksum counters, module code and chip version.
- Log startup, module changes, GPS loss/recovery, and serial failures. Download logs as JSON Lines.
- Label preview records as sample and keep them separate from real cache/logs.
- The hub checkpoints a valid fix on first acquisition, about once a minute while updating, and on reception loss. The browser saves every five seconds and on disconnect/close when possible. A sudden power loss can lose updates since the last checkpoint.
- The dashboard shows the newest 60 GPS rows while export includes all retained records.

## API references

[RadioLib SX1278 reference](https://jgromes.github.io/RadioLib/class_s_x1278.html) documents initialization, standby, and getChipVersion.
[TinyGPSPlus implementation](https://github.com/mikalhart/TinyGPSPlus/blob/master/src/TinyGPS%2B%2B.cpp) documents committed locations, checksum statistics, and GGA satellites used.

## Final-day node link and emergency extension

All fields are additive to `beacon.prototype.v1` / `gps_status`. Old GPS-only
status messages without `emergency` continue to work. Consume the classic hub's
USB port, not the S3 diagnostic output. Status remains approximately 1 Hz;
remote node packets normally arrive every five seconds.

- `node_link`: `waiting`, `online`, `offline`; offline after 12 s without a packet.
- `node_age_ms`: null before a packet, otherwise age of the last accepted packet.
- `node_id`: `node-01`; `node_boot_id`, `node_sequence`, `node_uptime_ms`.
- `rssi_dbm`, `snr_db`: last accepted packet measurements, null before reception.
- `radio_packets`, `radio_rejected`, `radio_receive_code`: hub reception diagnostics.
- `node_storage_status`: ready, unavailable, write_error, or unknown before reception.
- `gps_reason`: additionally `awaiting_node` or `radio_silent`.
- `emergency`: null before any received/restored request; otherwise the object below.

Example request (illustrative coordinates):

```json
{
  "id": "da7b000000000001",
  "node_id": "node-01",
  "trigger_boot_id": 12345,
  "trigger_uptime_ms": 18000,
  "location_source": "live_at_trigger",
  "latitude": 31.953914,
  "longitude": 35.910600,
  "position_age_ms_at_capture": 350,
  "position_time_utc": "2026-10-10T10:00:00Z"
}
```

The ID is a nonzero 16-character hexadecimal string, stable for the request.
Deduplicate repeated IDs. Three distinct debounced presses within two seconds
on a normally open S3 GPIO4-to-GND button generate a new ID. The request sends
immediately when radio is available and repeats in routine status packets.

| location_source | Meaning |
|---|---|
| live_at_trigger | Fresh node fix at the third press. |
| last_known | Earlier retained position; current location unconfirmed. Age can be null after reboot. |
| unavailable | No acquired location. latitude, longitude and position time are null. Show the request without a marker. |
| after_trigger | First live fix after an unlocated request; it is not a claimed position at the button time. |

The location is a snapshot. Later normal fixes cannot move it. The same ID may
transition from unavailable to a located request once. `position_time_utc` is
GPS time of the location, not button time; null if GPS supplied no date/time.
Trigger uptime belongs to trigger boot ID and can refer to an earlier node boot.
Record laptop first-receive time separately. `position_age_ms_at_capture` remains
the age when the snapshot was taken, not a continuously increasing age.

Retain received requests across ordinary status messages with no emergency,
GPS/radio loss, hub restart, USB disconnect, and browser reload. Node and hub each
persist only their latest request in flash; the browser retains the newest 50.
New requests and newly available request locations save immediately in browser
storage. Repeated IDs must not reset `seen_at` or create duplicate event rows.

Display a red map marker and persistent banner; an unlocated request still gets
a banner. Mark seen sets local browser `seen_at`, persists it, and logs viewing.
It does not send a command, acknowledge delivery to the node, clear its request,
or dispatch a responder. Export includes request records and local seen state;
Clear removes ordinary logs while retaining requests. Storage failures should
prompt export without dropping in-memory records. Preview samples remain separate.

The RF wire packet is version 2 (183 bytes). Both final-day sketches must be
uploaded together; the previous 120-byte pair is incompatible. The dashboard's
USB JSON schema name stays the same. Neither transport authenticates requests;
this is a one-node direct-link pitch prototype, with no mesh or dispatch service.