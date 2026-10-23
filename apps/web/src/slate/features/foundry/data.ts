// Live data for the Foundry apps copy. Each value the copy page baked from its
// snapshot (gotham/docs/overlay/fx-live.json) is read here from the same :8000
// route the builder pulled (fetch_live, _build_foundry_apps.py:125), and the
// builder's derivations are ported as pure functions (tested in data.test.ts).
import { propagate, twoline2satrec } from "satellite.js";
import { fetchJson, resetCache, useJson, type Res } from "../aip/data.js";

export { fetchJson, resetCache, useJson, type Res };

/** The copy's honest empty state: the reason, with the code. */
export function why(label: string, r: Res<unknown> | null): string | null {
  if (!r) return null;
  if (r.ok) return null;
  return r.status
    ? `${label} unavailable (HTTP ${r.status})`
    : `${label} unavailable (network error)`;
}

// ---------------------------------------------------------------- route shapes
export interface Status {
  aircraft_count: number;
  vessel_count: number;
  generated_at: number;
}
export interface Schema {
  kinds: Record<string, Record<string, string>>;
  relations: Record<
    string,
    {
      forward: string;
      inverse: string;
      src_kinds: string[];
      dst_kinds: string[];
    }
  >;
}
export interface Dataset {
  id: string;
  name: string;
  row_count: number;
  schema: { name: string }[];
}
export interface Binding {
  id: string;
  dataset_id: string;
  object_kind: string;
  last_result: { minted: number } | null;
}
export interface Transform {
  id: string;
  name: string;
  inputs: string[];
  steps: Array<Record<string, unknown> & { type: string }>;
  updated_at: string;
}
export interface Block {
  type: string;
  title: string;
  config_schema: Array<{
    key: string;
    type: string;
    label: string;
    required: boolean;
    placeholder?: string;
    help?: string;
  }>;
}
export interface Route {
  src: string;
  dst: string;
}
export interface Airport {
  iata: string;
  name: string;
  city: string;
  country: string;
  lon: number;
  lat: number;
}
export interface Quake {
  mag: number;
  place: string;
  time: number;
  lon: number;
  lat: number;
}
export interface Ac {
  lon: number;
  lat: number;
  on_ground: boolean;
  track_deg: number | null;
  emergency: string | null;
}
export interface Ves {
  lon: number;
  lat: number;
  shipType: string | number | null;
}
export interface Gp {
  OBJECT_NAME: string;
  NORAD_CAT_ID: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
}
interface FC<P> {
  features: Array<{
    geometry: { coordinates: number[] } | null;
    properties: P;
  }>;
}

export const airportsOf = (
  fc: FC<{ iata?: string; name: string; city: string; country: string }>,
): Airport[] =>
  fc.features
    .filter((f) => f.properties.iata && f.geometry)
    .map((f) => ({
      iata: f.properties.iata!,
      name: f.properties.name,
      city: f.properties.city,
      country: f.properties.country,
      lon: f.geometry!.coordinates[0]!,
      lat: f.geometry!.coordinates[1]!,
    }));

export const quakesOf = (
  fc: FC<{ mag: number | null; place: string; time: number }>,
): Quake[] =>
  fc.features
    .filter(
      (f) =>
        f.properties.mag !== null &&
        f.properties.mag !== undefined &&
        f.geometry,
    )
    .map((f) => ({
      mag: f.properties.mag!,
      place: f.properties.place,
      time: f.properties.time,
      lon: f.geometry!.coordinates[0]!,
      lat: f.geometry!.coordinates[1]!,
    }));

export const aircraftOf = (
  fc: FC<{
    on_ground?: boolean;
    track_deg?: number | null;
    emergency?: string | null;
  }>,
): Ac[] =>
  fc.features
    .filter(
      (f) =>
        f.geometry &&
        f.geometry.coordinates[1] !== null &&
        f.geometry.coordinates[1] !== undefined,
    )
    .map((f) => ({
      lon: f.geometry!.coordinates[0]!,
      lat: f.geometry!.coordinates[1]!,
      on_ground: !!f.properties.on_ground,
      track_deg: f.properties.track_deg ?? null,
      emergency: f.properties.emergency ?? null,
    }));

export const vesselsOf = (
  fc: FC<{ shipType?: string | number | null }>,
): Ves[] =>
  fc.features
    .filter(
      (f) =>
        f.geometry &&
        f.geometry.coordinates[1] !== null &&
        f.geometry.coordinates[1] !== undefined,
    )
    .map((f) => ({
      lon: f.geometry!.coordinates[0]!,
      lat: f.geometry!.coordinates[1]!,
      shipType: f.properties.shipType ?? null,
    }));

// ---------------------------------------------------------------- geometry (builder lines 31-33, 185-188, 92-94)
export function wpx(lon: number, lat: number, zf: number): [number, number] {
  const s = 256 * 2 ** zf;
  return [
    ((lon + 180) / 360) * s,
    (0.5 -
      Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2)) /
        (2 * Math.PI)) *
      s,
  ];
}

export type Proj = (lon: number, lat: number) => [number, number];

/** raw_plate's projection: lon/lat to the W x H plate centred on lon0/lat0. */
export function proj(
  lon0: number,
  lat0: number,
  zf: number,
  W: number,
  H: number,
): Proj {
  const o = wpx(lon0, lat0, zf);
  return (lo, la) => {
    const p = wpx(lo, la, zf);
    return [p[0] - o[0] + W / 2, p[1] - o[1] + H / 2];
  };
}

export function KM(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const [la1, lo1, la2, lo2] = [a[1] * r, a[0] * r, b[1] * r, b[0] * r];
  const h =
    Math.sin((la2 - la1) / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

export const scaleBar = (lat: number, zf: number): number =>
  (40075.017 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zf);

const inside =
  (fn: Proj, W: number, H: number) =>
  (p: { lon: number; lat: number }): boolean => {
    const [x, y] = fn(p.lon, p.lat);
    return x > 0 && x < W && y > 0 && y < H;
  };

// ---------------------------------------------------------------- time (builder lines 862-865), UTC
const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const g = (t: number): Date => new Date(t * 1000);
const p2 = (n: number): string => String(n).padStart(2, "0");
export const fmt_d = (t: number): string =>
  `${MON[g(t).getUTCMonth()]} ${g(t).getUTCDate()}, ${g(t).getUTCFullYear()}`;
export function fmt_t(t: number): string {
  const d = g(t);
  const h = d.getUTCHours() % 12 || 12;
  return `${h}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCHours() < 12 ? "AM" : "PM"}`;
}
export const fmt_dt = (t: number): string => `${fmt_d(t)} ${fmt_t(t)}`;
export const fmt_slash = (t: number): string =>
  `${p2(g(t).getUTCMonth() + 1)}/${p2(g(t).getUTCDate())}/${g(t).getUTCFullYear()}, ${fmt_t(t)}`;
export const mmmdd = (t: number): string =>
  `${MON[g(t).getUTCMonth()]} ${p2(g(t).getUTCDate())}`;
export const hhmmZ = (t: number): string =>
  `${p2(g(t).getUTCHours())}:${p2(g(t).getUTCMinutes())}Z`;
export const nf = (n: number): string => n.toLocaleString("en-US");

// ---------------------------------------------------------------- airports and routes (builder lines 854-857)
export function depsOf(routes: Route[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of routes) m.set(r.src, (m.get(r.src) ?? 0) + 1);
  return m;
}
export const ofvOf = (
  airports: Airport[],
  deps: Map<string, number>,
): Airport[] => airports.filter((a) => (deps.get(a.iata) ?? 0) > 0);

const byDeps =
  (deps: Map<string, number>) =>
  (a: Airport, b: Airport): number =>
    (deps.get(b.iata) ?? 0) - (deps.get(a.iata) ?? 0);

/** sec_d192: top 85 airports in view, 50/80/95th percentile bins, radius selection. */
export function d192(
  ofv: Airport[],
  deps: Map<string, number>,
  fn: Proj,
  W: number,
  H: number,
) {
  const inview = ofv
    .filter(inside(fn, W, H))
    .sort(byDeps(deps))
    .slice(0, 85);
  if (!inview.length) return null;
  const cnts = inview.map((a) => deps.get(a.iata)!).sort((a, b) => a - b);
  const q = (p: number): number =>
    cnts[Math.min(cnts.length - 1, Math.floor(p * cnts.length))]!;
  const [e1, e2, e3] = [q(0.5), q(0.8), q(0.95)];
  const edges: [number, number][] = [
    [cnts[0]!, e1],
    [e1, e2],
    [e2, e3],
    [e3, cnts[cnts.length - 1]!],
  ];
  const bin = (n: number): number => (n < e1 ? 0 : n < e2 ? 1 : n < e3 ? 2 : 3);
  let best: [Airport, number] | null = null;
  for (const a of inview) {
    const ds = inview
      .map((b) => KM([a.lon, a.lat], [b.lon, b.lat]))
      .sort((x, y) => x - y);
    if (
      ds.length > 4 &&
      ds[3]! >= 170 &&
      ds[3]! <= 260 &&
      (best === null || deps.get(a.iata)! > deps.get(best[0].iata)!)
    )
      best = [a, ds[3]!];
  }
  if (!best)
    return { inview, edges, bin, ctr: null, rkm: 0, selected: [] as Airport[] };
  const [ctr, r4] = best;
  const rkm = r4 * 1.04;
  const selected = inview
    .filter((a) => KM([ctr.lon, ctr.lat], [a.lon, a.lat]) <= rkm)
    .sort(byDeps(deps));
  return { inview, edges, bin, ctr, rkm, selected };
}

/** sec_d196: one line per airport pair in view, longer than 650 km, thinned to ~140. */
export function d196(
  routes: Route[],
  ofv: Airport[],
  fn: Proj,
  W: number,
  H: number,
) {
  const iv = new Map(ofv.filter(inside(fn, W, H)).map((a) => [a.iata, a]));
  const seen = new Set<string>();
  let rts: Array<[number, Airport, Airport]> = [];
  for (const r of routes) {
    const k = [r.src, r.dst].sort().join("|");
    const a = iv.get(r.src);
    const b = iv.get(r.dst);
    if (a && b && !seen.has(k)) {
      seen.add(k);
      const d = KM([a.lon, a.lat], [b.lon, b.lat]);
      if (d > 650) rts.push([d, a, b]);
    }
  }
  rts.sort((x, y) =>
    x[1].iata < y[1].iata
      ? -1
      : x[1].iata > y[1].iata
        ? 1
        : x[2].iata < y[2].iata
          ? -1
          : x[2].iata > y[2].iata
            ? 1
            : 0,
  );
  const step = Math.max(1, Math.floor(rts.length / 140));
  rts = rts.filter((_, i) => i % step === 0);
  if (!rts.length) return null;
  const ds = rts.map((t) => t[0]);
  return { rts, step, dmin: Math.min(...ds), dmax: Math.max(...ds) };
}

const hex = (c: number[]): string =>
  "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** sec_d196 ramp() */
export function lengthRamp(v: number, dmin: number, dmax: number): string {
  const t = (v - dmin) / Math.max(1e-6, dmax - dmin);
  const stops: [number, number[]][] = [
    [0, [46, 139, 87]],
    [0.45, [150, 200, 120]],
    [0.7, [232, 210, 90]],
    [1, [200, 70, 60]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]!;
    const [t1, c1] = stops[i + 1]!;
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return hex(c0.map((c, j) => c + (c1[j]! - c) * f));
    }
  }
  return "#c8463c";
}

/** sec_d200: 60 busiest in view, 60th/90th percentile, ringed airport and its 3rd neighbour. */
export function d200(
  ofv: Airport[],
  deps: Map<string, number>,
  fn: Proj,
  W: number,
  H: number,
) {
  const inview = ofv
    .filter(inside(fn, W, H))
    .sort(byDeps(deps))
    .slice(0, 60);
  if (inview.length < 4) return null;
  const cn = inview.map((a) => deps.get(a.iata)!).sort((a, b) => a - b);
  const p60 = cn[Math.floor(0.6 * cn.length)]!;
  const p90 = cn[Math.floor(0.9 * cn.length)]!;
  const col = (n: number): string =>
    n >= p90 ? "#d04a3a" : n >= p60 ? "#2e9e55" : "#2d72d2";
  const sel = inview.find((a) => {
    const [x, y] = fn(a.lon, a.lat);
    return x > 110 && x < W - 110 && y > 110 && y < H - 70;
  });
  if (!sel) return null;
  const nb = inview
    .filter((a) => a !== sel)
    .sort(
      (a, b) =>
        KM([sel.lon, sel.lat], [a.lon, a.lat]) -
        KM([sel.lon, sel.lat], [b.lon, b.lat]),
    )[2]!;
  const rkm = KM([sel.lon, sel.lat], [nb.lon, nb.lat]) * 1.04;
  return { inview, p60, p90, col, sel, nb, rkm };
}

/** sec_d194: countries with airports of 15+ departures, ordered by airport count. */
export function countryOrder(
  ofv: Airport[],
  deps: Map<string, number>,
): string[] {
  const c = new Map<string, number>();
  for (const a of ofv)
    if ((deps.get(a.iata) ?? 0) >= 15)
      c.set(a.country, (c.get(a.country) ?? 0) + 1);
  // Python's sorted is stable: ties keep first-seen order, as Array.sort does
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

// ---------------------------------------------------------------- quakes (sec_d195)
export function quakeCell(qk: Quake[], spanLon: number): [number, number] {
  let best: [number, number] = [0, 0];
  let bn = -1;
  for (let lo = -180; lo < 180; lo += 5)
    for (let la = -50; la < 70; la += 5) {
      let n = 0;
      for (const e of qk)
        if (
          Math.abs(e.lon - lo) < spanLon / 2 &&
          Math.abs(e.lat - la) < spanLon * 0.31
        )
          n++;
      if (n > bn) {
        best = [lo, la];
        bn = n;
      }
    }
  return best;
}

export function magRamp(m: number, mlo: number, mhi: number): string {
  const t = (m - mlo) / Math.max(1e-6, mhi - mlo);
  const a = [247, 206, 107];
  const b = [230, 140, 60];
  const c = [196, 52, 52];
  const k = t * 2;
  const [p, q, f] = k < 1 ? [a, b, k] : [b, c, k - 1];
  return hex(p.map((v, i) => v + (q[i]! - v) * f));
}

/** sec_d201/d197 dens_center: the grid cell holding the most points. */
export function densCenter(
  zf: number,
  W: number,
  H: number,
  pool: Array<{ lon: number; lat: number }>,
): [number, number, number] {
  const sl = (W / (256 * 2 ** zf)) * 360;
  const sh = ((sl * H) / W) * 0.65;
  const cells = new Map<string, [number, number, number]>();
  for (const a of pool) {
    // Python round() is half-to-even; at these magnitudes ties are measure-zero
    const kx = Math.round(a.lon / (sl / 2));
    const ky = Math.round(a.lat / (sh / 2));
    const key = `${kx},${ky}`;
    const c = cells.get(key);
    if (c) c[2]++;
    else cells.set(key, [kx, ky, 1]);
  }
  let best: [number, number, number] = [0, 0, 0];
  for (const c of cells.values()) if (c[2] > best[2]) best = c;
  return [(best[0] * sl) / 2, (best[1] * sh) / 2, best[2]];
}

/** sec_d201 ais_type() */
export function aisType(t: string | number | null | undefined): string {
  if (t === null || t === undefined || t === "") return "No value";
  if (typeof t === "string" && !/^\d+$/.test(t)) return t;
  const n = Number(t);
  const m: Record<number, string> = {
    30: "Fishing",
    31: "Tug",
    32: "Tug",
    33: "Dredging",
    34: "Diving",
    35: "Military",
    36: "Sailing",
    37: "Pleasure craft",
    50: "Pilot",
    51: "SAR",
    52: "Tug",
    53: "Port tender",
    55: "Law enforcement",
  };
  if (m[n]) return m[n]!;
  return n >= 60 && n < 70
    ? "Passenger"
    : n >= 70 && n < 80
      ? "Cargo"
      : n >= 80 && n < 90
        ? "Tanker"
        : "Other";
}

// ---------------------------------------------------------------- satellites (sat_tracks, builder line 103)
export interface Track {
  name: string;
  norad: string;
  pts: [number, number][];
}

/** SGP4 sub-satellite points over the live elements, one orbit from t0 (s). */
export function satTracks(
  items: Gp[],
  t0: number,
  n = 14,
  minutes = 96,
  step = 0.75,
): Track[] {
  const out: Track[] = [];
  for (const it of items.slice(0, n)) {
    try {
      const s = twoline2satrec(it.TLE_LINE1, it.TLE_LINE2);
      const pts: [number, number][] = [];
      for (let i = 0; i <= Math.floor(minutes / step); i++) {
        const t = Math.floor(t0 + i * step * 60);
        const pv = propagate(s, new Date(t * 1000));
        const r = pv && typeof pv.position === "object" ? pv.position : null;
        if (!r) break;
        const jd = t / 86400 + 2440587.5;
        const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545.0)) % 360;
        const lon =
          (((((Math.atan2(r.y, r.x) * 180) / Math.PI - gmst + 180) % 360) +
            360) %
            360) -
          180;
        const lat = (Math.atan2(r.z, Math.hypot(r.x, r.y)) * 180) / Math.PI;
        pts.push([
          Math.round(lon * 1000) / 1000,
          Math.round(lat * 1000) / 1000,
        ]);
      }
      if (pts.length > 5)
        out.push({ name: it.OBJECT_NAME, norad: it.NORAD_CAT_ID, pts });
    } catch {
      continue;
    }
  }
  return out;
}

/** sec_d194: one icon per station (modules at the same position shown once). */
export function dedupeTracks(ts: Track[]): Track[] {
  const seen: [number, number][] = [];
  const out: Track[] = [];
  for (const s of ts) {
    const p0 = s.pts[0]!;
    if (
      seen.some((q) => Math.abs(p0[0] - q[0]) < 3 && Math.abs(p0[1] - q[1]) < 3)
    )
      continue;
    seen.push(p0);
    out.push(s);
  }
  return out;
}

export function splitWrap(pts: [number, number][]): [number, number][][] {
  const segs: [number, number][][] = [[pts[0]!]];
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i]![0] - pts[i - 1]![0]) > 180) segs.push([pts[i]!]);
    else segs[segs.length - 1]!.push(pts[i]!);
  }
  return segs;
}

/** Fit-to-surface zoom for a W x H frame (the copy scales each section). */
export const fitZoom = (cw: number, ch: number, W: number, H: number): number =>
  Math.min(cw / W, ch / H);
