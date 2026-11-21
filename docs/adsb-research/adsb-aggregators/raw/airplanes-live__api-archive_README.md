![Docker Build Status](https://github.com/ADSB-One/api/actions/workflows/docker.yml/badge.svg)

# ADSB One API

The ADSB One API lives at https://api.adsb.one. Use the table below for endpoints. To make switching easy, all responses conform to the ADSBExchange v2 API.

# Endpoints

**NOTE**: Replace `[var]` with your value. Do not include the brackets in your API call.

| Endpoint                       | Method | Description                                                                                                                     |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| /v2/hex/[hex]                  | GET    | Return all aircraft with an exact match on one of the given Mode S hex ids (limited to 1000)                                    |
| /v2/callsign/[callsign]        | GET    | Returns all aircraft with an exact match on one of the given callsigns (limited to 1000 or 8000 characters for the request)     |
| /v2/reg/[reg]                  | GET    | Returns all aircraft with an exact match on one of the given registrations (limited to 1000 or 8000 characters for the request) |
| /v2/type/[type]                | GET    | Returns all aircraft that have one of the specified ICAO type codes (A321, B738, etc.)                                          |
| /v2/squawk/[squawk]            | GET    | Returns all aircraft that are squawking the specified value                                                                     |
| /v2/mil/                       | GET    | Returns all aircraft tagged as military                                                                                         |
| /v2/ladd/                      | GET    | Returns all aircraft tagged as LADD                                                                                             |
| /v2/pia/                       | GET    | Returns all aircraft tagged as PIA                                                                                              |
| /v2/point/[lat]/[lon]/[radius] | GET    | Returns all aircraft within a certain radius of a given point up to 250 nm                                                      |

## Example Usage

`curl https://api.adsb.one/v2/hex/A9CEE9`

```json
{
  "ac": [
    {
      "hex": "a9cee9",
      "type": "adsb_icao",
      "flight": "N731BP  ",
      "alt_baro": 38000,
      "alt_geom": 38275,
      "gs": 338.9,
      "track": 276.1,
      "baro_rate": 0,
      "squawk": "3301",
      "emergency": "none",
      "category": "A2",
      "nav_qnh": 1013.6,
      "nav_altitude_mcp": 38016,
      "nav_heading": 280.55,
      "nav_modes": ["autopilot", "althold", "lnav"],
      "lat": 37.358322,
      "lon": -93.374147,
      "nic": 9,
      "rc": 75,
      "seen_pos": 3.486,
      "version": 2,
      "nic_baro": 1,
      "nac_p": 10,
      "nac_v": 2,
      "sil": 3,
      "sil_type": "perhour",
      "gva": 2,
      "sda": 3,
      "alert": 0,
      "spi": 0,
      "mlat": [],
      "tisb": [],
      "messages": 24844,
      "seen": 0.7,
      "rssi": -15.8
    }
  ],
  "msg": "No error",
  "now": 1675633671226,
  "total": 1,
  "ctime": 1675633671226,
  "ptime": 0
}
```

## Rate Limiting

The ADSB One API is rate limited to 1 request per second.
