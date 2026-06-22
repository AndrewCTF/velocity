import type { LayerDescriptor } from '@osint/shared';
import type { LayerRegistry } from './LayerRegistry.js';

// Phase 1 / Wave 2 default layer set. Each layer registers a backend route
// (key-hidden, server-cached). visibleByDefault controls what's on at boot;
// power-users can enable the rest from the LayerRail.
export const defaultLayers: readonly LayerDescriptor[] = [
  // ── HAZARDS ──────────────────────────────────────────────────────────
  {
    id: 'hazards.usgs.quakes',
    group: 'hazards',
    title: 'Quakes — USGS (24h)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/eq?range=day',
    refresh: { mode: 'pull', ttlSec: 60 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'USGS / public domain',
    opacity: 1,
    visibleByDefault: true,
    emits: ['quake'],
  },
  {
    id: 'hazards.emsc.quakes',
    group: 'hazards',
    title: 'Quakes — EMSC (24h, M≥2.5)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/seismic/emsc?minmag=2.5&hours=24',
    refresh: { mode: 'pull', ttlSec: 60 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'EMSC',
    opacity: 1,
    visibleByDefault: false,
    emits: ['quake'],
  },
  // CLAUDE.md guardrail: FIRMS must stay REGISTERED (degrades gracefully to
  // an empty collection + note when FIRMS_MAP_KEY is unset). Off by default
  // to save memory on high-volume sessions — operators enable it from the
  // LayerRail.
  {
    id: 'hazards.nasa.firms',
    group: 'hazards',
    title: 'Fires — NASA FIRMS VIIRS',
    kind: 'geojson',
    auth: 'apikey',
    endpoint: '/api/firms?source=VIIRS_SNPP_NRT&days=1',
    refresh: { mode: 'pull', ttlSec: 600 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'NASA (CC0 / cite)',
    opacity: 1,
    visibleByDefault: false,
    emits: ['fire'],
  },
  {
    id: 'hazards.nasa.eonet',
    group: 'hazards',
    title: 'Events — NASA EONET (open)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/events/eonet?status=open&limit=500',
    refresh: { mode: 'pull', ttlSec: 900 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'NASA',
    opacity: 1,
    visibleByDefault: false,
    emits: ['event'],
  },
  {
    id: 'hazards.nws.alerts',
    group: 'hazards',
    title: 'NWS — Active alerts (US)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/weather/alerts',
    refresh: { mode: 'pull', ttlSec: 120 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'NOAA NWS',
    opacity: 1,
    visibleByDefault: false,
    emits: ['event'],
  },

  // ── AVIATION ─────────────────────────────────────────────────────────
  // Primary: multi-source ADS-B grid (airplanes.live + ADSB.lol). No auth,
  // no daily quota — survives all-day operator use.
  {
    id: 'aviation.adsb.global',
    group: 'aviation',
    title: 'Aircraft — Global (multi-source ADS-B)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/adsb/global',
    // 1s pull for a steady cadence: the backend sticky snapshot refreshes on a
    // 2s target cycle and the hot route returns it in microseconds (no fan-out
    // per request), so a 1s poll is cheap and consistent. Motion BETWEEN polls
    // is interpolated and rendered every frame (GlobeCanvas maximumRenderTime-
    // Change), so positions glide rather than hop once per poll.
    refresh: { mode: 'pull', ttlSec: 1 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'ADSB.lol / airplanes.live (NC)',
    opacity: 1,
    visibleByDefault: true,
    emits: ['aircraft'],
  },
  // Backup: adsb.fi global snapshot.
  {
    id: 'aviation.adsb.fi.global',
    group: 'aviation',
    title: 'Aircraft — adsb.fi (global snapshot)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/adsb/fi/global',
    refresh: { mode: 'pull', ttlSec: 30 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'adsb.fi (NC)',
    opacity: 1,
    visibleByDefault: false,
    emits: ['aircraft'],
  },
  // Authenticated alternative — only useful with creds, off by default.
  {
    id: 'aviation.opensky.states',
    group: 'aviation',
    title: 'Aircraft — OpenSky (auth optional)',
    kind: 'geojson',
    auth: 'oauth2-cc',
    endpoint: '/api/aviation/states',
    refresh: { mode: 'pull', ttlSec: 12 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'OpenSky ToS (non-commercial)',
    opacity: 1,
    visibleByDefault: false,
    emits: ['aircraft'],
  },
  {
    id: 'aviation.adsb.live.mil',
    group: 'aviation',
    title: 'Aircraft — Military (airplanes.live)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/adsb/live/mil',
    refresh: { mode: 'pull', ttlSec: 30 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'airplanes.live (NC)',
    opacity: 1,
    visibleByDefault: true,
    emits: ['aircraft'],
  },
  {
    id: 'aviation.adsb.live.emergencies',
    group: 'aviation',
    title: 'Aircraft — Emergency squawks (7500/7600/7700)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/adsb/live/emergencies',
    refresh: { mode: 'pull', ttlSec: 15 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'airplanes.live (NC)',
    opacity: 1,
    visibleByDefault: true,
    emits: ['aircraft'],
  },

  // ── ENV / RF ─────────────────────────────────────────────────────────
  // GPS jamming heat layer per research_updated.md §2.7 + §5 — buckets
  // aircraft with nac_p<8 or nic<7 into 1° cells, just like GPSJam.org's
  // hex bins (we use 1° because it's dep-free and good enough for the
  // analyst). Off by default — only meaningful in active conflict
  // theatres (Hormuz, Baltic, Black Sea).
  {
    id: 'env.jamming.nacp',
    group: 'env',
    title: 'GPS jamming — ADS-B NACp cells',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/jamming/nacp',
    refresh: { mode: 'pull', ttlSec: 60 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'derived (ADSB.lol / airplanes.live)',
    opacity: 0.75,
    visibleByDefault: false,
    emits: ['outage'],
  },

  // ── MARITIME ─────────────────────────────────────────────────────────
  // No-key Baltic vessel feed (Digitraffic Finland, CC BY 4.0). Default on
  // so the operator sees ships without setting up AISStream first.
  {
    id: 'maritime.digitraffic',
    group: 'maritime',
    title: 'Vessels — Digitraffic Baltic (no key)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/maritime/digitraffic',
    refresh: { mode: 'pull', ttlSec: 30 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'CC BY 4.0 / Fintraffic',
    opacity: 1,
    // Off by default now that maritime.keyless unions this Baltic set with the
    // Norwegian coast (Kystdatahuset). Keeping both visible would double-paint
    // Baltic MMSIs across two layers. Toggle on for a Baltic-only view.
    visibleByDefault: false,
    emits: ['vessel'],
  },
  // Consolidated no-key vessel feed: Digitraffic (Baltic / Gulf of Finland) ∪
  // Kystdatahuset (Norwegian coast / North Sea / Arctic), deduped by MMSI,
  // freshest fix wins. Measured this run via TestClient GET /api/maritime/keyless:
  // 4,539 distinct vessels = 994 Digitraffic (Baltic) + 3,545 Kystdatahuset
  // (Norway), bbox lon[-8.4, 34.1] lat[56.1, 80.6]. Regional Northern-Europe
  // coverage — the Med, Black Sea, Americas, and APAC have no keyless live point
  // feed reachable from this egress and still need AISStream (key). Default
  // vessel layer so a fresh install shows the Baltic + Norwegian coast, no key.
  {
    id: 'maritime.keyless',
    group: 'maritime',
    title: 'Vessels — live (all AIS sources, 24/7)',
    kind: 'geojson',
    auth: 'none',
    // Unified vessel store: latest fix per MMSI across EVERY AIS source
    // (Digitraffic ∪ Kystverket/Kystdatahuset ∪ AISStream when keyed), fed 24/7
    // by background pollers + the always-on firehoses and accumulated within the
    // store retention window. Keyless = Northern Europe (~few k); with an
    // AISStream key + AISSTREAM_FIREHOSE the same layer grows global as the
    // capped stream accumulates over time.
    endpoint: '/api/maritime/snapshot',
    refresh: { mode: 'pull', ttlSec: 30 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'CC BY 4.0 Fintraffic + Kystverket/Kystdatahuset',
    opacity: 1,
    visibleByDefault: true,
    emits: ['vessel'],
  },
  // Parking mode: stationary vessels only (SOG < 0.5 kn — anchored / moored /
  // drifting), retained up to 12h server-side since a parked ship's old fix is
  // still accurate. Surfaces port congestion, STS staging and loitering /
  // shadow-fleet behaviour that the live layer ages out. Vessels render with the
  // existing anchored (muted) paint. Off by default — toggle for parking mode.
  {
    id: 'maritime.parked',
    group: 'maritime',
    title: 'Parking mode — parked / anchored ships',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/maritime/snapshot?parked=1',
    refresh: { mode: 'pull', ttlSec: 60 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'CC BY 4.0 Fintraffic + Kystverket/Kystdatahuset',
    opacity: 1,
    visibleByDefault: false,
    emits: ['vessel'],
  },
  {
    id: 'maritime.aisstream',
    group: 'maritime',
    title: 'Vessels — AISStream (live)',
    kind: 'websocket',
    auth: 'apikey',
    endpoint: '/ws/ais',
    refresh: { mode: 'push' },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'AISStream beta (NC)',
    opacity: 1,
    // Off by default — overlaps with maritime.digitraffic in the Baltic and is
    // only useful with an AISSTREAM_KEY configured. Operators with the key
    // flip it on from the LayerRail (and typically turn Digitraffic off so
    // they don't see the same vessel twice). Keeping the no-key Digitraffic
    // feed as the default vessel layer means a fresh install renders ships
    // without any setup, while not double-painting MMSIs once the key arrives.
    visibleByDefault: false,
    emits: ['vessel'],
  },
  // Keyless vessel coverage for the Strait of Hormuz, where Digitraffic (Baltic
  // only) and AISStream (needs a key) show nothing. Sentinel-1 SAR detects
  // ship-sized backscatter targets regardless of AIS; targets with no nearby
  // AIS report render as red dark-vessel diamonds (darkCandidate). Uses the
  // operator's CDSE credentials. Detection is heavy (SAR fetch + CFAR) and
  // Sentinel-1 revisits are ~12h, so this polls slowly. Off by default; flip on
  // from the LayerRail when watching Hormuz.
  {
    id: 'maritime.sar.hormuz',
    group: 'maritime',
    title: 'Vessels — Sentinel-1 SAR (Hormuz, no key)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/intel/dark-vessels/sar?aoi=hormuz',
    refresh: { mode: 'pull', ttlSec: 6 * 3600 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'Contains modified Copernicus Sentinel data',
    opacity: 1,
    visibleByDefault: false,
    emits: ['vessel'],
  },
  // Additional keyless Sentinel-1 SAR dark-vessel AOIs over maritime chokepoints
  // where the keyless AIS feeds (Northern Europe only) show nothing. Each maps
  // to a server-side AOI key (validated in sar_vessels.AOIS; unknown -> 400) and
  // shares maritime.sar.hormuz's treatment: 6h pull, off by default, emits vessel.
  {
    id: 'maritime.sar.bab-el-mandeb',
    group: 'maritime',
    title: 'Vessels — Sentinel-1 SAR (Bab-el-Mandeb, no key)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/intel/dark-vessels/sar?aoi=bab-el-mandeb',
    refresh: { mode: 'pull', ttlSec: 6 * 3600 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'Contains modified Copernicus Sentinel data',
    opacity: 1,
    visibleByDefault: false,
    emits: ['vessel'],
  },
  {
    id: 'maritime.sar.gulf-of-aden',
    group: 'maritime',
    title: 'Vessels — Sentinel-1 SAR (Gulf of Aden, no key)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/intel/dark-vessels/sar?aoi=gulf-of-aden',
    refresh: { mode: 'pull', ttlSec: 6 * 3600 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'Contains modified Copernicus Sentinel data',
    opacity: 1,
    visibleByDefault: false,
    emits: ['vessel'],
  },
  {
    id: 'maritime.sar.suez-gulf-approach',
    group: 'maritime',
    title: 'Vessels — Sentinel-1 SAR (Suez approach, no key)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/intel/dark-vessels/sar?aoi=suez-gulf-approach',
    refresh: { mode: 'pull', ttlSec: 6 * 3600 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'Contains modified Copernicus Sentinel data',
    opacity: 1,
    visibleByDefault: false,
    emits: ['vessel'],
  },
  {
    id: 'maritime.sar.kerch-strait',
    group: 'maritime',
    title: 'Vessels — Sentinel-1 SAR (Kerch Strait, no key)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/intel/dark-vessels/sar?aoi=kerch-strait',
    refresh: { mode: 'pull', ttlSec: 6 * 3600 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'Contains modified Copernicus Sentinel data',
    opacity: 1,
    visibleByDefault: false,
    emits: ['vessel'],
  },
  {
    id: 'maritime.sar.taiwan-strait',
    group: 'maritime',
    title: 'Vessels — Sentinel-1 SAR (Taiwan Strait, no key)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/intel/dark-vessels/sar?aoi=taiwan-strait',
    refresh: { mode: 'pull', ttlSec: 6 * 3600 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'Contains modified Copernicus Sentinel data',
    opacity: 1,
    visibleByDefault: false,
    emits: ['vessel'],
  },

  // ── EVENTS / NEWS ────────────────────────────────────────────────────
  {
    id: 'news.gdelt.events',
    group: 'news',
    title: 'GDELT 2.0 — 24h events',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/events/gdelt?timespan=24h',
    refresh: { mode: 'pull', ttlSec: 900 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'GDELT',
    opacity: 0.85,
    visibleByDefault: false,
    emits: ['event'],
  },
  {
    id: 'news.acled.events',
    group: 'news',
    title: 'ACLED conflict events (7d)',
    kind: 'geojson',
    auth: 'apikey',
    endpoint: '/api/events/acled?days=7',
    refresh: { mode: 'pull', ttlSec: 1800 },
    time: { temporal: true },
    crs: 'EPSG:4326',
    license: 'ACLED (NC, academic)',
    opacity: 1,
    visibleByDefault: false,
    emits: ['event'],
  },

  // ── SPACE ────────────────────────────────────────────────────────────
  // Curated CelesTrak groups, each a separate toggle (all off by default).
  // Positions are SGP4-propagated client-side from these TLEs (SatelliteAdapter)
  // and interpolated by Cesium for smooth motion. limit is set explicitly
  // because the route default is only 2000. Starlink is capped at MAX_SATS
  // (4000) in the adapter — the title makes no completeness claim.
  {
    // Notional MIL-STD-2525 Common Operational Picture — illustrative ground
    // laydown (units + FLOT lines + AO ring). Rendered by MilSymbolAdapter in
    // its own CustomDataSource; off by default. Data is notional, not a feed.
    id: 'mil.cop.notional',
    group: 'reference',
    title: 'COP — Notional units (MIL-STD-2525)',
    kind: 'geojson',
    auth: 'none',
    endpoint: 'notional://cop',
    refresh: { mode: 'static' },
    time: { temporal: false },
    crs: 'EPSG:4326',
    license: 'Notional / illustrative',
    opacity: 1,
    visibleByDefault: false,
    emits: ['event'],
  },
  {
    id: 'space.celestrak.stations',
    group: 'space',
    title: 'Satellites — Space stations (ISS)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/space/gp?group=stations&limit=4000',
    refresh: { mode: 'pull', ttlSec: 7200 },
    time: { temporal: true },
    crs: 'ECI',
    license: 'CelesTrak / public',
    opacity: 1,
    visibleByDefault: false,
    emits: ['satellite'],
  },
  {
    id: 'space.celestrak.starlink',
    group: 'space',
    title: 'Satellites — Starlink',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/space/gp?group=starlink&limit=4000',
    refresh: { mode: 'pull', ttlSec: 7200 },
    time: { temporal: true },
    crs: 'ECI',
    license: 'CelesTrak / public',
    opacity: 1,
    visibleByDefault: false,
    emits: ['satellite'],
  },
  {
    id: 'space.celestrak.gps',
    group: 'space',
    title: 'Satellites — GPS',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/space/gp?group=gps-ops&limit=4000',
    refresh: { mode: 'pull', ttlSec: 7200 },
    time: { temporal: true },
    crs: 'ECI',
    license: 'CelesTrak / public',
    opacity: 1,
    visibleByDefault: false,
    emits: ['satellite'],
  },
  {
    id: 'space.celestrak.visual',
    group: 'space',
    title: 'Satellites — Visual (brightest)',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/space/gp?group=visual&limit=4000',
    refresh: { mode: 'pull', ttlSec: 7200 },
    time: { temporal: true },
    crs: 'ECI',
    license: 'CelesTrak / public',
    opacity: 1,
    visibleByDefault: false,
    emits: ['satellite'],
  },

  // ── INFRASTRUCTURE ───────────────────────────────────────────────────
  {
    id: 'infra.cables.lines',
    group: 'infra',
    title: 'Submarine cables',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/cables',
    refresh: { mode: 'pull', ttlSec: 24 * 3600 },
    time: { temporal: false },
    crs: 'EPSG:4326',
    license: 'TeleGeography (CC BY-NC-SA 3.0)',
    opacity: 0.6,
    visibleByDefault: false,
  },
  {
    id: 'infra.cables.landings',
    group: 'infra',
    title: 'Cable landing points',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/cables/landings',
    refresh: { mode: 'pull', ttlSec: 24 * 3600 },
    time: { temporal: false },
    crs: 'EPSG:4326',
    license: 'TeleGeography (CC BY-NC-SA 3.0)',
    opacity: 1,
    visibleByDefault: false,
  },
  // Public webcams — owner-published gov road/weather cams + curated list.
  // Off by default; cam markers are city furniture, not contacts.
  {
    id: 'infra.cams.public',
    group: 'infra',
    title: 'CCTV — public road/weather cams',
    kind: 'geojson',
    auth: 'none',
    endpoint: '/api/cams',
    refresh: { mode: 'pull', ttlSec: 3600 },
    time: { temporal: false },
    crs: 'EPSG:4326',
    license: 'Fintraffic CC BY 4.0 / Caltrans public / curated',
    opacity: 1,
    visibleByDefault: false,
    emits: ['camera'],
  },
] as const;

export function registerDefaults(registry: LayerRegistry): void {
  for (const l of defaultLayers) {
    if (!registry.get(l.id)) registry.register(l);
  }
}
