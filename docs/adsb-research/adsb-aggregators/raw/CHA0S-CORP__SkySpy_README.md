<p align="center">
  <img src="docs/logo.png" alt="SkySpy Logo" width="200">
</p>

<h1 align="center">SkySpy</h1>

<p align="center">
  Real-time ADS-B aircraft tracking and monitoring system with a web-based dashboard.
</p>

![SkySpy Demo](docs/screenshots/desktop/map-overview.png)

## Overview

SkySpy is a sophisticated aircraft tracking platform that captures position data from 1090MHz Mode S and 978MHz UAT receivers, displays aircraft on an interactive map, monitors safety conditions, and provides advanced features like custom alerts, weather integration, and push notifications.

### Key Features

- **Real-Time Aircraft Tracking** - Live position updates from ADS-B receivers with distance, altitude, speed, and climb rate
- **Interactive Map Dashboard** - Canvas-based radar display with aircraft icons, flight paths, and detailed information panels
- **Safety Monitoring** - TCAS RA/TA detection, proximity alerts, extreme vertical speed warnings, and emergency squawk detection (7700/7600/7500)
- **Custom Alert Rules** - Flexible AND/OR logic conditions on ICAO, callsign, squawk, altitude, distance, aircraft type, and military status
- **Historical Data** - PostgreSQL-backed sighting history with session tracking and analytics
- **Aviation Weather** - METARs, TAFs, PIREPs, SIGMETs, and G-AIRMET integration
- **Push Notifications** - Apprise integration supporting 80+ services (Pushover, Telegram, Slack, Discord, email, etc.)
- **Aircraft Information** - Registration lookups, photos, airframe data, and operator information
- **ACARS/VDL2 Messages** - Aircraft communication message reception and display

## Screenshots

> The images below are generated automatically by the Playwright documentation
> pipeline (`npm run docs:generate` from `web/`) and cover every screen across
> desktop/tablet/mobile viewports. Do not edit between the marker comments — the
> pipeline rewrites those regions. See [`web/e2e/docs/README.md`](web/e2e/docs/README.md).

#### Live Map

<!-- SCREENSHOTS:map:START -->

![Map Aircraft Popup](docs/screenshots/desktop/map-aircraft-popup.png)
![Map Emergency Aircraft](docs/screenshots/desktop/map-emergency-aircraft.png)
![Map Filters](docs/screenshots/desktop/map-filters.png)
![Map Legend](docs/screenshots/desktop/map-legend.png)
![Map Overlays](docs/screenshots/desktop/map-overlays.png)
![Map Overview](docs/screenshots/desktop/map-overview.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:map:END -->

#### Aircraft List

<!-- SCREENSHOTS:aircraft:START -->

![Aircraft List Column Menu](docs/screenshots/desktop/aircraft-list-column-menu.png)
![Aircraft List Filtered](docs/screenshots/desktop/aircraft-list-filtered.png)
![Aircraft List Mobile](docs/screenshots/desktop/aircraft-list-mobile.png)
![Aircraft List Row Expanded](docs/screenshots/desktop/aircraft-list-row-expanded.png)
![Aircraft List Sorted](docs/screenshots/desktop/aircraft-list-sorted.png)
![Aircraft List Table](docs/screenshots/desktop/aircraft-list-table.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:aircraft:END -->

#### Aircraft Detail

<!-- SCREENSHOTS:airframe:START -->

![Airframe Communications Tab](docs/screenshots/desktop/airframe-communications-tab.png)
![Airframe Info Tab](docs/screenshots/desktop/airframe-info-tab.png)
![Airframe Overview](docs/screenshots/desktop/airframe-overview.png)
![Airframe Safety Tab](docs/screenshots/desktop/airframe-safety-tab.png)
![Airframe Track Tab](docs/screenshots/desktop/airframe-track-tab.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:airframe:END -->

#### Statistics

<!-- SCREENSHOTS:stats:START -->

![Stats Cards Overview](docs/screenshots/desktop/stats-cards-overview.png)
![Stats Charts](docs/screenshots/desktop/stats-charts.png)
![Stats Coverage](docs/screenshots/desktop/stats-coverage.png)
![Stats Dashboard](docs/screenshots/desktop/stats-dashboard.png)
![Stats Time Range](docs/screenshots/desktop/stats-time-range.png)
![Stats Top Aircraft](docs/screenshots/desktop/stats-top-aircraft.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:stats:END -->

#### Advanced Analytics

<!-- SCREENSHOTS:analytics:START -->

![Analytics Military](docs/screenshots/desktop/analytics-military.png)
![Analytics Overview](docs/screenshots/desktop/analytics-overview.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:analytics:END -->

#### Flight History

<!-- SCREENSHOTS:history:START -->

![History Acars](docs/screenshots/desktop/history-acars.png)
![History Archive](docs/screenshots/desktop/history-archive.png)
![History Notams](docs/screenshots/desktop/history-notams.png)
![History Pireps](docs/screenshots/desktop/history-pireps.png)
![History Safety Events](docs/screenshots/desktop/history-safety-events.png)
![History Sessions](docs/screenshots/desktop/history-sessions.png)
![History Sightings](docs/screenshots/desktop/history-sightings.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:history:END -->

#### Radio / ACARS

<!-- SCREENSHOTS:audio:START -->

![Audio Emergency](docs/screenshots/desktop/audio-emergency.png)
![Audio List](docs/screenshots/desktop/audio-list.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:audio:END -->

#### Alerts

<!-- SCREENSHOTS:alerts:START -->

![Alerts History](docs/screenshots/desktop/alerts-history.png)
![Alerts Notification Settings](docs/screenshots/desktop/alerts-notification-settings.png)
![Alerts Rule Builder](docs/screenshots/desktop/alerts-rule-builder.png)
![Alerts Rules List](docs/screenshots/desktop/alerts-rules-list.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:alerts:END -->

#### Safety Events

<!-- SCREENSHOTS:safety:START -->

![Safety Event Full](docs/screenshots/desktop/safety-event-full.png)
![Safety Event Map](docs/screenshots/desktop/safety-event-map.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:safety:END -->

#### System

<!-- SCREENSHOTS:system:START -->

![System Overview](docs/screenshots/desktop/system-overview.png)
![System Services](docs/screenshots/desktop/system-services.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:system:END -->

#### Assistant

<!-- SCREENSHOTS:assistant:START -->

![Assistant Overview](docs/screenshots/desktop/assistant-overview.png)
![Assistant Prompt](docs/screenshots/desktop/assistant-prompt.png)

<sub>Also captured for: animations, mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:assistant:END -->

#### Cannonball Mode

<!-- SCREENSHOTS:cannonball:START -->

![Cannonball Hud](docs/screenshots/desktop/cannonball-hud.png)
![Cannonball Scan](docs/screenshots/desktop/cannonball-scan.png)

<sub>Also captured for: animations, mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:cannonball:END -->

#### Login

<!-- SCREENSHOTS:login:START -->

![Login Form](docs/screenshots/desktop/login-form.png)

<sub>Also captured for: mobile, tablet (see `docs/screenshots/`).</sub>
<!-- SCREENSHOTS:login:END -->

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Ultrafeeder   │     │    dump978      │     │   ACARS Hub     │
│  (1090MHz ADS-B)│     │  (978MHz UAT)   │     │  (VDL2/ACARS)   │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │      SkySpy API         │
                    │    (FastAPI/Python)     │
                    │                         │
                    │  • Aircraft tracking    │
                    │  • Safety monitoring    │
                    │  • Alert engine         │
                    │  • Weather integration  │
                    │  • Socket.IO streaming  │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
    ┌─────────▼─────────┐ ┌──────▼──────┐ ┌────────▼────────┐
    │    PostgreSQL     │ │    Redis    │ │   Web Dashboard │
    │  (History/Alerts) │ │  (Pub/Sub)  │ │     (React)     │
    └───────────────────┘ └─────────────┘ └─────────────────┘
```

## Tech Stack

**Backend (skyspy_django)**

- Python 3.12+
- Django + Django REST Framework
- Django ASGI (Daphne) with Socket.IO for real-time streaming
- Celery for background tasks (6 queues)
- PostgreSQL (via PgBouncer) for data persistence
- Redis for cache and pub/sub messaging
- Apprise for notifications

**Frontend (web)**

- React 18
- Vite 5
- Canvas-based radar rendering
- Socket.IO client
- Lucide icons

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Python 3.12+ (for local development)
- Node.js 20+ (for local development)
- ADS-B receiver (Ultrafeeder/readsb/dump1090) — **optional**: run with no hardware on keyless open data ([guide](docs/22-open-data-feeds.md))

### Docker Compose (Recommended)

```bash
# Clone the repository
git clone https://github.com/your-org/skyspy.git
cd skyspy

# Copy environment template
cp .env.test.sample .env

# Edit .env with your configuration
# At minimum, set:
#   FEEDER_LAT=your_latitude
#   FEEDER_LON=your_longitude
#   ULTRAFEEDER_HOST=your_receiver_host

# Start all services
docker compose up -d

# Access the dashboard at http://localhost:3000
# API available at http://localhost:5000
```

### Development Environment

```bash
# Start development environment with mock data
make dev

# Services:
#   Dashboard: http://localhost:3000
#   API: http://localhost:5000
#   Mock Ultrafeeder: http://localhost:8080
#   Mock dump978: http://localhost:8081

# Stop services
make dev-down
```

### Local Development

```bash
# Backend
cd skyspy_django
uv sync
python manage.py migrate
python manage.py runserver 0.0.0.0:8000

# Frontend
cd web
npm install
npm run dev
```

## Configuration

### Required Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:***@localhost:5432/adsb

# ADS-B Receiver
ULTRAFEEDER_HOST=ultrafeeder    # readsb/dump1090 host
ULTRAFEEDER_PORT=80

# Feeder Location (for distance calculations)
FEEDER_LAT=47.9377
FEEDER_LON=-121.9687
```

### Optional Configuration

```bash
# UAT 978MHz Receiver
DUMP978_HOST=dump978
DUMP978_PORT=80

# Redis (for multi-worker deployments)
REDIS_URL=redis://localhost:6379

# Polling intervals
POLLING_INTERVAL=2              # seconds between aircraft polls
DB_STORE_INTERVAL=10            # seconds between DB writes

# Safety Monitoring
SAFETY_MONITORING_ENABLED=true
SAFETY_PROXIMITY_NM=1.0         # proximity alert distance (nm)
SAFETY_ALTITUDE_DIFF_FT=1000    # vertical separation threshold

# Push Notifications (Apprise URLs)
APPRISE_URLS=pushover://key@token;telegram://token/chatid
NOTIFICATION_COOLDOWN=300       # seconds between notifications

# ACARS/VDL2
ACARS_ENABLED=true
ACARS_PORT=5555

# Photo Caching
PHOTO_CACHE_ENABLED=true
PHOTO_CACHE_DIR=/data/photos

# S3 Storage (optional)
S3_ENABLED=false
S3_BUCKET=skyspy
S3_ENDPOINT_URL=https://s3.amazonaws.com
```

## API Reference

### Aircraft Data

| Endpoint                           | Description                    |
| ---------------------------------- | ------------------------------ |
| `GET /api/v1/aircraft`             | All tracked aircraft           |
| `GET /api/v1/aircraft/{hex}`       | Single aircraft by ICAO hex    |
| `GET /api/v1/aircraft/{hex}/info`  | Registration and airframe data |
| `GET /api/v1/aircraft/{hex}/photo` | Aircraft photo URLs            |
| `GET /api/v1/aircraft/stats`       | Aggregate statistics           |
| `GET /api/v1/uat/aircraft`         | UAT 978MHz aircraft            |

### Real-Time Streaming

| Endpoint                  | Description                                |
| ------------------------- | ------------------------------------------ |
| `Socket.IO /`             | WebSocket connection for real-time updates |
| `GET /api/v1/map/sse`     | Server-Sent Events stream                  |
| `GET /api/v1/map/geojson` | GeoJSON feature collection                 |

**Socket.IO Topics:** `aircraft`, `safety`, `alerts`, `acars`, `airspace`, `all`

### Historical Data

| Endpoint                        | Description                  |
| ------------------------------- | ---------------------------- |
| `GET /api/v1/history/sightings` | Query sightings with filters |
| `GET /api/v1/history/sessions`  | Tracking sessions            |

### Alerts

| Endpoint                           | Description       |
| ---------------------------------- | ----------------- |
| `GET /api/v1/alerts/rules`         | List alert rules  |
| `POST /api/v1/alerts/rules`        | Create alert rule |
| `PUT /api/v1/alerts/rules/{id}`    | Update alert rule |
| `DELETE /api/v1/alerts/rules/{id}` | Delete alert rule |

### Aviation Data

| Endpoint                         | Description                |
| -------------------------------- | -------------------------- |
| `GET /api/v1/aviation/metars`    | Weather observations       |
| `GET /api/v1/aviation/pireps`    | Pilot reports              |
| `GET /api/v1/aviation/sigmets`   | Hazardous weather          |
| `GET /api/v1/aviation/airspaces` | Active airspace advisories |

### System

| Endpoint             | Description     |
| -------------------- | --------------- |
| `GET /api/v1/health` | Health check    |
| `GET /api/v1/status` | System status   |
| `GET /api/v1/info`   | API information |

## Alert Rules

Create custom alerts using flexible condition logic:

```json
{
  "name": "Military Aircraft Alert",
  "enabled": true,
  "priority": "high",
  "conditions": {
    "operator": "AND",
    "conditions": [
      { "field": "military", "operator": "eq", "value": true },
      { "field": "distance", "operator": "lt", "value": 50 }
    ]
  },
  "notification_enabled": true
}
```

**Available Fields:** `icao`, `callsign`, `squawk`, `altitude`, `distance`, `type`, `military`, `registration`

**Operators:** `eq`, `ne`, `lt`, `gt`, `le`, `ge`, `contains`, `startswith`

## Safety Monitoring

SkySpy automatically monitors for safety-related events:

- **TCAS Alerts** - Resolution Advisory (RA) and Traffic Advisory (TA) detection
- **Proximity Warnings** - Aircraft within configurable distance threshold
- **Extreme Vertical Rates** - Climb/descent exceeding 4500 ft/min
- **Emergency Squawks** - 7700 (emergency), 7600 (comm failure), 7500 (hijack)

Safety events are logged, displayed on the dashboard, and can trigger push notifications.

## Testing

```bash
# Run tests in Docker
make test

# Run backend tests locally
cd skyspy_django
pytest

# Run with coverage
pytest --cov=skyspy --cov-report=html
```

## Project Structure

```
skyspy/
├── skyspy_django/            # Django backend API
│   ├── skyspy/
│   │   ├── settings.py       # Django settings
│   │   ├── models/           # Django models (by domain)
│   │   ├── api/              # DRF ViewSets (/api/v1/)
│   │   ├── serializers/      # DRF serializers
│   │   ├── services/         # Business logic layer
│   │   ├── tasks/            # Celery background tasks
│   │   ├── socketio/         # Socket.IO namespaces + mixins
│   │   └── tests/            # Test suite (pytest)
│   ├── manage.py
│   └── pytest.ini            # Test config (--reuse-db)
│
├── web/                      # Frontend dashboard
│   ├── src/
│   │   ├── components/       # React components
│   │   ├── hooks/            # Custom hooks
│   │   └── utils/            # Utilities
│   └── package.json          # Node dependencies
│
├── skyspy-go/                # Go CLI TUI radar client (Bubble Tea + Cobra)
├── skyspy_common/            # Shared Python package (libacars CFFI bindings)
│
├── test/                     # Test infrastructure
│   ├── mock-1090/            # Mock ADS-B receiver
│   └── acars-mock/           # Mock ACARS hub
│
├── docker-compose.yaml       # Production compose
├── docker-compose.test.yaml  # Test/dev compose
├── Makefile                  # Build commands
└── README.md
```

## Data Sources

- **Aircraft Positions:** Ultrafeeder (readsb/dump1090) JSON API, or keyless community feed (adsb.lol/adsb.fi/airplanes.live) via `AIRCRAFT_STREAM_MODE=adsblol` — no hardware
- **UAT Positions:** dump978 for 978MHz reception
- **Aircraft Info:** hexdb.io, OpenSky Network, Planespotters.net
- **Aviation Weather:** Aviation Weather Center (aviationweather.gov)
- **ACARS/VDL2:** dumpvdl2, acarsdec receivers, or the keyless airframes.io firehose via `AIRFRAMES_ACARS_ENABLED=True` — no hardware

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`make test`)
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Ultrafeeder](https://github.com/sdr-enthusiasts/docker-adsb-ultrafeeder) for ADS-B reception
- [OpenSky Network](https://opensky-network.org/) for aircraft database
- [Aviation Weather Center](https://aviationweather.gov/) for weather data
