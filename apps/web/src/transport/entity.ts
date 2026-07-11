export interface AircraftEnrichment {
  kind: 'aircraft';
  icao24: string;
  registration?: string | null;
  type?: string | null;
  icao_type?: string | null;
  operator?: string | null;
  manufacturer?: string | null;
  country_origin?: string | null;
  mode_s?: string | null;
  /** ICAO 3-letter airline prefix parsed from the live callsign (e.g. "DAL"). */
  operator_callsign?: string | null;
  /** IATA 2-letter airline code derived from the callsign prefix (e.g. "DL"). */
  operator_iata?: string | null;
  /** Planespotters thumbnail photo URL — direct-hotlinkable, credit required. */
  photo_thumb_url?: string | null;
  /** Larger Planespotters photo (when available); falls back to thumbnail. */
  photo_full_url?: string | null;
  /** Planespotters photographer name (used in the credit caption). */
  photo_photographer?: string | null;
  /** Planespotters photo permalink (click-through for full credit). */
  photo_link?: string | null;
  /** Planespotters license string (e.g. "CC BY-SA 4.0"). */
  photo_license?: string | null;
  /** Departure airport (adsbdb route lookup by callsign). */
  origin?: Airport | null;
  /** Destination airport — its lat/lon drives the ETA / distance-to-go calc. */
  destination?: Airport | null;
  /** Operating airline name from the route lookup. */
  route_airline?: string | null;
  source?: string;
}

/** Airport from the adsbdb flightroute lookup. */
export interface Airport {
  icao?: string | null;
  iata?: string | null;
  name?: string | null;
  municipality?: string | null;
  country?: string | null;
  lat?: number | null;
  lon?: number | null;
}
export interface VesselEnrichment {
  kind: 'vessel';
  mmsi: string;
  name?: string | null;
  imo?: string | null;
  callsign?: string | null;
  flag?: string | null;
  gear_type?: string | null;
  vessel_type?: string | null;
  length_m?: number | null;
  width_m?: number | null;
  first_seen?: string | null;
  last_seen?: string | null;
  /** Flag state derived from MMSI's first 3 digits (ITU-R M.585 MID table). */
  flag_country?: string | null;
  /** Human-readable place name nearest the vessel's last AIS position. */
  nearest_port?: string | null;
  /** Distance in km from vessel position to the centroid of `nearest_port`. */
  nearest_port_distance_km?: number | null;
  /** Wikidata link if OSM has one for the nearest place. */
  wikidata_url?: string | null;
  /** Wikipedia thumbnail URL — for the ship article when GFW gives a name,
   *  else the nearest-port article so the user has a visual anchor. */
  photo_thumb_url?: string | null;
  /** Wikipedia extract (plain text blurb) — first sentence(s) of the article. */
  description?: string | null;
  /** Source label for the photo credit caption (e.g. "Wikipedia"). */
  photo_credit?: string | null;
  /** Wikipedia article permalink for the photo / blurb. */
  photo_link?: string | null;
  source?: string;
  note?: string;
}
export interface QuakeEnrichment {
  kind: 'quake';
  id: string;
  mag?: number | null;
  place?: string | null;
  time?: number | null;
  url?: string | null;
  alert?: string | null;
  tsunami?: boolean;
  depth_km?: number | null;
  mmi?: number | null;
  cdi?: number | null;
  felt?: number | null;
  source?: string;
}
/** A single physical runway from OurAirports + FAA NASR (ils_rf.txt). */
export interface Runway {
  le_ident?: string | null;
  he_ident?: string | null;
  length_ft?: number | null;
  width_ft?: number | null;
  surface?: string | null;
  lighted?: boolean | null;
  closed?: boolean | null;
  /** Best (lowest) ILS CAT seen on this runway; US-only — null elsewhere. */
  ils_category?: string | null;
  /** Per-end CAT — differs from `ils_category` when the two ends aren't equipped alike. */
  ils_category_le?: string | null;
  ils_category_he?: string | null;
}
export interface Frequency {
  type?: string | null;
  desc?: string | null;
  mhz?: number | null;
}
export interface AirportEnrichment {
  kind: 'airport';
  icao: string;
  iata?: string | null;
  name?: string | null;
  lat?: number | null;
  lon?: number | null;
  elevation_ft?: number | null;
  municipality?: string | null;
  iso?: string | null;
  atype?: string | null;
  scheduled_service?: boolean;
  /** Best-effort regex flag off the name (AFB/NAS/MCAS/…) — no source flag exists. */
  military?: boolean;
  runways?: Runway[];
  frequencies?: Frequency[];
  /** Derived capability PROXIES only (never a fabricated capacity number). */
  runway_count?: number;
  max_runway_length_ft?: number | null;
  /** Worldwide DERIVED landing-capability tier (the non-US counterpart to the
   * NASR CAT badge) — always flagged derived, never a CAT I/II/III string. */
  approach_capability?: string | null;
  approach_capability_derived?: boolean;
  approach_capability_basis?: string[];
  /** ILS presence-on-record (NASR cats or OSM navigation aids) — no category. */
  ils_present?: boolean;
  /** https://www.liveatc.net/search/?icao=… — Cloudflare-403s server-side, linkout only. */
  liveatc_url?: string | null;
  /** Guessed mount URLs, NOT enumerated/verified — label as experimental. */
  candidate_mounts?: string[];
  candidate_mounts_best_effort?: boolean;
  source?: string;
}
export interface PortEnrichment {
  kind: 'port';
  wpi: string;
  name?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** Always "Unknown" today — NGA WPI carries no live closure feed (§7). */
  op_status?: string;
  harborSize?: string | null;
  harborType?: string | null;
  shelter?: string | null;
  repairs?: string | null;
  dryDock?: string | null;
  railway?: string | null;
  portSecurity?: string | null;
  harborUse?: string | null;
  cargoPierDepth?: number | null;
  channelDepth?: number | null;
  maxVesselLength?: number | null;
  maxVesselBeam?: number | null;
  maxVesselDraft?: number | null;
  source?: string;
}
export interface SatelliteEnrichment {
  kind: 'satellite';
  norad_cat_id: string;
  object_name?: string | null;
  object_type?: string | null;
  ops_status_code?: string | null;
  owner?: string | null;
  launch_date?: string | null;
  launch_site?: string | null;
  decay_date?: string | null;
  period?: number | null;
  inclination?: number | null;
  apogee?: number | null;
  perigee?: number | null;
  rcs?: number | null;
  source?: string;
}
export type Enrichment =
  | AircraftEnrichment
  | VesselEnrichment
  | QuakeEnrichment
  | AirportEnrichment
  | PortEnrichment
  | SatelliteEnrichment
  | { kind: string; [k: string]: unknown };

/** One station row from the aviationweather.gov METAR passthrough
 * (`GET /api/weather/metar`) — fields are the upstream JSON as-is (no
 * renaming), see apps/api/tests/fixtures/metar_kjfk.json for a live sample.
 * `wdir` is a number except for the literal string "VRB" (variable);
 * `visib` is usually a number of statute miles but can be a string like
 * "10+" — never coerce either without checking `typeof`. */
export interface Metar {
  icaoId?: string;
  wdir?: number | string | null;
  wspd?: number | null;
  visib?: number | string | null;
  altim?: number | null;
  temp?: number | null;
  dewp?: number | null;
  clouds?: { cover?: string; base?: number | null }[];
  /** Flight category: VFR / MVFR / IFR / LIFR — absent for non-reporting stations. */
  fltCat?: string | null;
  rawOb?: string;
  name?: string;
  lat?: number;
  lon?: number;
  elev?: number;
}

import { apiFetch } from './http.js';

export async function fetchEnrichment(
  eid: string,
  signal?: AbortSignal,
  hints?: { callsign?: string | null },
): Promise<Enrichment | null> {
  const params = new URLSearchParams();
  if (hints?.callsign) params.set('callsign', hints.callsign);
  const qs = params.toString();
  const path = `/api/entity/${encodeURIComponent(eid)}${qs ? `?${qs}` : ''}`;
  const r = await apiFetch(path, signal ? { signal } : {});
  if (!r.ok) return null;
  return (await r.json()) as Enrichment;
}

/** Live METAR for one ICAO station (AirportCard's weather block). Returns
 * null on any failure or when the station simply has no current report
 * (`data` empty — a non-reporting airfield, not an error) so callers can
 * render a graceful "unavailable" state instead of crashing. */
export async function fetchMetar(icao: string, signal?: AbortSignal): Promise<Metar | null> {
  const path = `/api/weather/metar?ids=${encodeURIComponent(icao)}`;
  const r = await apiFetch(path, signal ? { signal } : {});
  if (!r.ok) return null;
  const body = (await r.json()) as { data?: Metar[] };
  return body.data && body.data.length > 0 ? body.data[0]! : null;
}
