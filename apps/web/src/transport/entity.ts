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
  source?: string;
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
export type Enrichment = AircraftEnrichment | VesselEnrichment | QuakeEnrichment | { kind: string; [k: string]: unknown };

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
