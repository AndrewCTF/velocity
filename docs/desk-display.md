# Desk display: what's overhead

`GET /api/overhead` answers "which planes are near this point right now" in a few hundred bytes of flat JSON, small enough for an ESP32 or an e-ink desk display to parse.

It reads the aircraft snapshot Velocity already keeps in memory, the same one the globe draws. It makes no request to any aggregator, so a display polling every 10 seconds costs them nothing and costs your instance very little.

## Ask

```bash
curl 'http://192.168.1.50:8000/api/overhead?lat=51.5074&lon=-0.1278&radius_km=25&limit=3'
```

| Parameter   | Default  | Range     | Meaning                         |
| ----------- | -------- | --------- | ------------------------------- |
| `lat`       | required | -90..90   | Your latitude, decimal degrees  |
| `lon`       | required | -180..180 | Your longitude, decimal degrees |
| `radius_km` | 25       | 1..250    | How far out to look             |
| `limit`     | 5        | 1..20     | Most aircraft to return         |

Anything outside those ranges is a `422`.

## Answer

Illustrative values, one aircraft shown. Measured sizes: about 440 bytes for three aircraft, 680 for five, 2.5 KB for the maximum of twenty.

```json
{
  "as_of": 1792222938,
  "center": [51.5074, -0.1278],
  "radius_km": 25.0,
  "aircraft": [
    {
      "id": "406a2f",
      "callsign": "BAW117",
      "type": "A320",
      "alt_ft": 3200,
      "gs_kt": 168,
      "dist_km": 5.0,
      "bearing_deg": 36.8,
      "age_s": 3
    }
  ]
}
```

- `as_of`: the server clock when the answer was built, epoch seconds.
- `center`: your point, `[lat, lon]`.
- `aircraft`: nearest first. Each entry:
  - `id`: the aircraft's ICAO24 address, lower-case hex.
  - `callsign`: the flight callsign, or the registration for a plane that sends none.
  - `type`: ICAO type code such as `A320`.
  - `alt_ft`: barometric altitude in feet (geometric if that is all the feed has).
    Barometric altitude is pressure altitude, so on a high-pressure day an
    aircraft on final approach can read a few hundred feet below zero.
  - `gs_kt`: ground speed in knots.
  - `dist_km`: great-circle distance from your point.
  - `bearing_deg`: compass bearing from you to the plane. 0 is north, 90 is east.
  - `age_s`: how old the position fix is, in seconds, at `as_of`.

A field the feed did not report is `null`, not `0`. Check for it before you print.

## What is in the list

- Airborne aircraft only. A plane parked at a nearby airport is not overhead, and near one it would fill the list.
- Fixes up to 120 seconds old. The globe keeps older contacts and dims them; a text list cannot dim, so a plane whose last known position is older than that is left out rather than reported as overhead.

## When it fails

- `503` with `{"detail":"aircraft feed is not live"}`: nothing was found and the server's snapshot has stopped refreshing. That is "no data", not "empty sky", so show an error instead of "nothing overhead".
- `401`: your instance has an `API_KEY` and the request did not carry it.
- `422`: a parameter was out of range.

## Auth

A keyless instance needs nothing. If yours sets `API_KEY`, send it as `X-API-Key: <key>`. Over plain HTTP the key crosses your network in the clear, so keep the display on your LAN or put the instance behind HTTPS.

## Polling

The snapshot refreshes every 1 to 5 seconds, so polling faster than every few seconds gains nothing. Every 10 seconds is plenty.

## ESP32 sketch

Arduino core for ESP32 with ArduinoJson 7. It polls every 10 seconds and prints the nearest three; replace the `Serial` calls with your display library's.

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASS = "your-password";
const char* URL = "http://192.168.1.50:8000/api/overhead?lat=51.5074&lon=-0.1278&radius_km=25&limit=3";
const char* API_KEY = "";  // set only if your instance has API_KEY

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(250);
}

void loop() {
  HTTPClient http;
  http.begin(URL);
  if (API_KEY[0]) http.addHeader("X-API-Key", API_KEY);
  int code = http.GET();
  if (code == 200) {
    JsonDocument doc;
    if (deserializeJson(doc, http.getString()) == DeserializationError::Ok) {
      JsonArray planes = doc["aircraft"];
      if (planes.size() == 0) Serial.println("nothing overhead");
      for (JsonObject p : planes) {
        char alt[8] = "?", spd[8] = "?";  // null means not reported: print ?, never 0
        if (!p["alt_ft"].isNull()) snprintf(alt, sizeof(alt), "%d", p["alt_ft"].as<int>());
        if (!p["gs_kt"].isNull()) snprintf(spd, sizeof(spd), "%d", p["gs_kt"].as<int>());
        Serial.printf("%-8s %-4s %5s ft %3s kt %5.1f km @ %3.0f deg\n",
                      p["callsign"] | "?", p["type"] | "?", alt, spd,
                      p["dist_km"].as<float>(), p["bearing_deg"].as<float>());
      }
    }
  } else {
    Serial.printf("overhead: HTTP %d\n", code);  // 503 means the feed is down
  }
  http.end();
  delay(10000);
}
```
