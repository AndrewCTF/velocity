// Asset recommender for a watch item: every candidate is a real thing that can
// look at the item. Aircraft are live ADS-B tracks near it (distance and time
// to target are great-circle over the reported ground speed); satellites are
// the curated sensor catalogue propagated with SGP4 over the item's position
// (time to target is the next pass). Ranking is a weighted sum of the metrics
// the operator sets in the metrics dialog; a metric with no source for an
// asset contributes nothing.

import { apiFetch } from "../../../transport/http.js";
import { sensorOf, type SensorKind } from "../../../registry/sensorSats.js";
import { passesOverAoi } from "../../../sim/tasking.js";
import { distNm } from "./geo.js";

export const METRICS = [
  "sensor",
  "ttt",
  "dist",
  "station",
  "fuel",
  "passes",
] as const;
export type Metric = (typeof METRICS)[number];
export const METRIC_LABEL: Record<Metric, string> = {
  sensor: "Sensor Match (Revisit Priority)",
  ttt: "Time to Target",
  dist: "Distance",
  station: "Time on Station",
  fuel: "Fuel",
  passes: "Sensor Passes",
};
/** Why a metric scores nothing for some assets (shown on its tile). */
export const METRIC_GAP: Partial<Record<Metric, string>> = {
  fuel: "No fuel source for any asset: this weight has no effect.",
  station: "Satellites only: ADS-B carries no endurance.",
  passes: "Satellites only.",
  dist: "Aircraft only: a satellite pass has no ground distance.",
};
export type Weights = Record<Metric, number>;

export interface Asset {
  id: string;
  kind: "air" | "sat";
  label: string;
  /** Payload chip: `ADS-B follow (1x)`, `SAR pass (3x)`. */
  chip: string;
  taskType: string;
  source: string;
  lat?: number;
  lon?: number;
  altFt?: number | null;
  kmh?: number;
  kt?: number;
  trk?: number | null;
  /** Seconds since the last position (ADS-B). */
  seenS?: number;
  /** When the facts were read, ms. */
  at: number;
  distNm?: number;
  tttS?: number;
  sensor?: SensorKind;
  passes?: number;
  passStartMs?: number;
  passDurS?: number;
  /** The satellite's two-line elements, for drawing its orbit. */
  tle?: [string, string];
}

export interface Ranked {
  asset: Asset;
  score: number;
  /** Bar width fraction against the top match. */
  bar: number;
  match: "Top Match" | "Strong Match" | "Fair Match";
}

// How well a sensor suits a vessel or aircraft watch item. SAR images through
// cloud and at night, optical needs daylight and clear sky, RF needs an
// emitter; a manned aircraft can follow anything it reaches.
const SENSOR_FIT: Record<SensorKind, number> = {
  SAR: 1,
  EO: 0.6,
  MSI: 0.6,
  RF: 0.3,
};

/** Each metric as 0..1, higher is better; null when the asset has no source. */
export function metricValues(a: Asset): Record<Metric, number | null> {
  return {
    sensor: a.kind === "sat" ? SENSOR_FIT[a.sensor ?? "EO"] : 0.5,
    ttt: a.tttS !== undefined ? 1 / (1 + a.tttS / 3600) : null,
    dist: a.distNm !== undefined ? 1 / (1 + a.distNm / 100) : null,
    station: a.passDurS !== undefined ? Math.min(1, a.passDurS / 600) : null,
    fuel: null,
    passes: a.passes !== undefined ? Math.min(1, a.passes / 6) : null,
  };
}

export function rank(assets: Asset[], w: Weights): Ranked[] {
  const total = METRICS.reduce((s, m) => s + Math.max(0, w[m]), 0) || 1;
  const scored = assets
    .map((asset) => {
      const v = metricValues(asset);
      const score =
        METRICS.reduce((s, m) => s + Math.max(0, w[m]) * (v[m] ?? 0), 0) /
        total;
      return { asset, score };
    })
    .sort((a, b) => b.score - a.score);
  const top = scored[0]?.score || 1;
  return scored.map((s, i) => ({
    ...s,
    bar: s.score / top,
    match:
      i === 0
        ? "Top Match"
        : s.score >= 0.8 * top
          ? "Strong Match"
          : "Fair Match",
  }));
}

interface AdsbFeature {
  id: string;
  geometry: { coordinates: [number, number, number?] };
  properties: {
    callsign?: string | null;
    registration?: string | null;
    icao24?: string;
    on_ground?: boolean;
    velocity_ms?: number | null;
    track_deg?: number | null;
    baro_alt_m?: number | null;
    geo_alt_m?: number | null;
    seen_pos_s?: number | null;
  };
}

/** Live airborne ADS-B tracks within `boxDeg` of the item. Throws on HTTP. */
export async function aircraftNear(
  lat: number,
  lon: number,
  boxDeg = 4,
): Promise<Asset[]> {
  const q = `lamin=${(lat - boxDeg).toFixed(2)}&lomin=${(lon - boxDeg).toFixed(2)}&lamax=${(lat + boxDeg).toFixed(2)}&lomax=${(lon + boxDeg).toFixed(2)}`;
  const r = await apiFetch(`/api/adsb/global?${q}`);
  if (!r.ok) throw new Error(`ADS-B unavailable (HTTP ${r.status})`);
  const j = (await r.json()) as { features?: AdsbFeature[] };
  const now = Date.now();
  const out: Asset[] = [];
  for (const f of j.features ?? []) {
    const p = f.properties;
    const v = p.velocity_ms ?? 0;
    if (p.on_ground || v < 20) continue; // parked or taxiing: not an asset
    const [alon, alat] = f.geometry.coordinates;
    const d = distNm(alat, alon, lat, lon);
    const alt = p.baro_alt_m ?? p.geo_alt_m ?? null;
    out.push({
      id: f.id,
      kind: "air",
      label: (p.callsign || p.registration || p.icao24 || f.id).trim(),
      chip: "ADS-B follow (1x)",
      taskType: "VISUAL FOLLOW",
      source: "ADS-B",
      lat: alat,
      lon: alon,
      altFt: alt === null ? null : Math.round(alt * 3.28084),
      kmh: Math.round(v * 3.6),
      kt: Math.round(v * 1.94384),
      trk: p.track_deg ?? null,
      seenS: p.seen_pos_s ?? 0,
      at: now,
      distNm: d,
      tttS: (d * 1852) / v,
    });
  }
  return out;
}

interface OmmRecord {
  OBJECT_NAME?: string;
  NORAD_CAT_ID?: number | string;
  TLE_LINE1?: string;
  TLE_LINE2?: string;
}

const SAT_TASK: Record<SensorKind, string> = {
  SAR: "SAR PASS",
  EO: "EO PASS",
  MSI: "MSI PASS",
  RF: "RF COLLECT",
};

// The active catalogue is ~3.5 MB; elements age in hours, so one pull serves
// every detection the operator opens for half an hour.
const GP_TTL_MS = 30 * 60_000;
let gp: { at: number; p: Promise<{ items?: OmmRecord[] }> } | null = null;
function activeElements(): Promise<{ items?: OmmRecord[] }> {
  if (gp && Date.now() - gp.at < GP_TTL_MS) return gp.p;
  const p = apiFetch("/api/space/gp?group=active&limit=20000").then((r) => {
    if (!r.ok)
      throw new Error(`Satellite elements unavailable (HTTP ${r.status})`);
    return r.json() as Promise<{ items?: OmmRecord[] }>;
  });
  gp = { at: Date.now(), p };
  p.catch(() => {
    if (gp?.p === p) gp = null; // a failed pull is retried next time
  });
  return p;
}

/** Catalogue sensor satellites with a pass over the item in the next `hours`.
 *  Same pull and propagation as the collection planner (tasking/TaskingPanel). */
export async function satellitesOver(
  lat: number,
  lon: number,
  hours = 12,
): Promise<Asset[]> {
  const j = await activeElements();
  const now = Date.now();
  const win = { startMs: now, endMs: now + hours * 3600_000 };
  const seen = new Set<string>();
  const out: Asset[] = [];
  let i = 0;
  for (const it of j.items ?? []) {
    if (!it.TLE_LINE1 || !it.TLE_LINE2) continue;
    const name = (it.OBJECT_NAME ?? "").trim();
    const norad = Number(it.NORAD_CAT_ID);
    const hit = sensorOf(name, isFinite(norad) ? norad : undefined);
    if (!hit) continue;
    const key = String(it.NORAD_CAT_ID ?? name);
    if (seen.has(key)) continue;
    seen.add(key);
    const passes = passesOverAoi(
      it.TLE_LINE1,
      it.TLE_LINE2,
      { lat, lon },
      win,
      60,
      10,
      name,
    );
    if (++i % 6 === 0) await new Promise((res) => setTimeout(res, 0));
    const next = passes[0];
    if (!next) continue;
    out.push({
      id: `sat:${key}`,
      kind: "sat",
      label: name || hit.name,
      chip: `${hit.sensor} pass (${passes.length}x)`,
      taskType: SAT_TASK[hit.sensor],
      source: hit.operator,
      at: now,
      sensor: hit.sensor,
      passes: passes.length,
      passStartMs: next.startMs,
      passDurS: next.durationS,
      tttS: Math.max(0, (next.startMs - now) / 1000),
      tle: [it.TLE_LINE1, it.TLE_LINE2],
    });
  }
  return out;
}
