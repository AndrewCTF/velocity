// Live data for the Europa copy (gotham/europa/features.html). Every value the
// copy baked from its snapshot (gotham/europa/overlay/eu-data.json, written by
// _eu_data.py) is read here from the same :8000 route, and the builder's
// derivations (_build_features.py, _eu_data.py, gotham/_fb_assets.py) are
// ported as pure functions below (tested in data.test.ts).
import {
  twoline2satrec,
  propagate,
  gstime,
  eciToEcf,
  type EciVec3,
  type Kilometer,
} from "satellite.js";
import { passesOverAoi, skyView } from "../../../sim/tasking.js";

export { useJson, fetchJson, unavailable, type Res } from "../aip/data.js";

// ── route shapes (only the fields the copy reads) ─────────────────────────────
export interface Pt<P> {
  id?: string;
  geometry: { type: string; coordinates: number[] } | null;
  properties: P;
}
export interface FC<P> {
  features: Pt<P>[];
}
export interface Choke {
  name: string;
  vessels: number;
  stationary: number;
  lat: number;
  lon: number;
}
export interface Evid {
  sha256: string;
  size_bytes: number;
  media_type: string;
  capture_method: string;
  source_context?: string | null;
  filename?: string | null;
  title: string;
  captured_by?: string | null;
  captured_at: string;
}
export interface Vessel {
  id: string;
  mmsi: number;
  lat: number;
  lon: number;
  ageS?: number | null;
  sog?: number | null;
  heading?: number | null;
  name?: string | null;
  shipType?: string | null;
  flag?: string | null;
}
export interface SweepAoi {
  aoi: string;
  label: string;
  detections: number;
  dark_candidates: number;
  swept_at: number;
}
export interface LinNode {
  id: string;
  type: "dataset" | "transform";
  name: string;
  kind?: string;
  stale?: boolean;
}
export interface Lineage {
  nodes: LinNode[];
  edges: { src: string; dst: string }[];
}
export interface FSummary {
  datasets: number;
  failed_builds_24h: number;
  recent_builds?: { status: string }[];
}
export interface OntoObj {
  id: string;
  kind: string;
  created_at?: string;
  props: Record<string, unknown>;
}
export interface Incident {
  id: string;
  threat: string | null;
  score: number | null;
  domains: string[];
}
export interface Omm {
  OBJECT_NAME?: string;
  NORAD_CAT_ID?: number | string;
  TLE_LINE1?: string;
  TLE_LINE2?: string;
}

export const chokesOf = (fc: FC<Omit<Choke, "lat" | "lon">> | null): Choke[] =>
  (fc?.features ?? [])
    .filter((f) => f.geometry)
    .map((f) => ({
      ...f.properties,
      lon: f.geometry!.coordinates[0]!,
      lat: f.geometry!.coordinates[1]!,
    }));

// ── time formatting (the builder's time.strftime patterns, UTC) ───────────────
const MON = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const p2 = (n: number): string => String(n).padStart(2, "0");
/** strftime subset in UTC: %H %M %S %d %-d %m %Y %b %B %I %p. `t` in seconds. */
export function UTC(t: number, f = "%H:%M"): string {
  const d = new Date(t * 1000);
  const h = d.getUTCHours();
  const m: Record<string, string> = {
    H: p2(h),
    M: p2(d.getUTCMinutes()),
    S: p2(d.getUTCSeconds()),
    d: p2(d.getUTCDate()),
    "-d": String(d.getUTCDate()),
    m: p2(d.getUTCMonth() + 1),
    Y: String(d.getUTCFullYear()),
    b: MON[d.getUTCMonth()]!.slice(0, 3),
    B: MON[d.getUTCMonth()]!,
    I: p2(h % 12 || 12),
    p: h < 12 ? "AM" : "PM",
  };
  return f.replace(/%(-d|[HMSdmYbBIp])/g, (_, k: string) => m[k]!);
}

// ── E3 Gaia world map (mercator) ──────────────────────────────────────────────
export const GX0 = 777.0;
export const GS = 1.94;
export const GYE = 537.0;
export const merc = (lat: number): number =>
  (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;
export const gx = (lon: number): number => GX0 + (lon + 168) * GS;
export const gy = (lat: number): number => GYE - merc(lat) * GS;

/** The NGA warnings the world map rings: 2024 and later, one per 9 px cell, newest first. */
export function warnRings(
  ws: { y: number; lon: number; lat: number }[],
): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const w of [...ws].sort((a, b) => b.y - a.y)) {
    const x = gx(w.lon);
    const y = gy(w.lat);
    const cell = `${Math.round(x / 9)},${Math.round(y / 9)}`;
    if (w.y < 2024 || seen.has(cell)) continue;
    seen.add(cell);
    if (x > 770 && x < 1600 && y > 306 && y < 656) out.push([x, y]);
  }
  return out;
}

/** The evidence row's label chips (title counts replace type/file/by when present). */
export function chipsOf(e: Evid): [string, string][] {
  let chips: [string, string][] = [
    ["Source", e.source_context || "n/a"],
    ["Method", e.capture_method],
    ["Size", `${(e.size_bytes / 1024).toFixed(1)} KB`],
    ["SHA-256", e.sha256.slice(0, 10)],
    ["Type", e.media_type],
    ["File", e.filename || "n/a"],
    ["Captured by", e.captured_by || "n/a"],
  ];
  const m = /(\d+) arrived, (\d+) departed, (\d+) stayed/.exec(e.title);
  if (m)
    chips = [
      chips[0]!,
      chips[1]!,
      ["Arrived", m[1]!],
      ["Departed", m[2]!],
      ["Stayed", m[3]!],
      chips[2]!,
    ];
  return chips
    .map(([a, b]): [string, string] => [a, b.length < 16 ? b : `${b.slice(0, 14)}…`])
    .slice(0, 5);
}

// ── satellite mosaic (Esri World Imagery z17) around Port Rashid, Dubai ───────
export const Z = 17;
const C: [number, number] = [25.27, 55.286];
const tileXY = (z: number, lat: number, lon: number): [number, number] => {
  const n = 2 ** z;
  return [
    ((lon + 180) / 360) * n,
    ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n,
  ];
};
const [cxT, cyT] = tileXY(Z, ...C);
export const X0 = Math.floor(cxT) - 3;
export const Y0 = Math.floor(cyT) - 2;
export const NX = 7;
export const NY = 5;
export const SATW = 256 * NX;
export const SATH = 256 * NY;
const tileLat = (y: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** Z))) * 180) / Math.PI;
export const SAT_BBOX = [
  (X0 / 2 ** Z) * 360 - 180,
  tileLat(Y0 + NY),
  ((X0 + NX) / 2 ** Z) * 360 - 180,
  tileLat(Y0),
] as const;
export const tileUrl = (i: number, j: number): string =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${Z}/${Y0 + j}/${X0 + i}`;
export function ll2px(lat: number, lon: number): [number, number] {
  const [x, y] = tileXY(Z, lat, lon);
  return [(x - X0) * 256, (y - Y0) * 256];
}
export type SatV = Vessel & { px: [number, number] };
export const withPx = (vs: Vessel[]): SatV[] =>
  vs.map((v) => ({ ...v, px: ll2px(v.lat, v.lon) }));

/** Greedy farthest-point pick of n live AIS vessels inside the view (blue ship markers). */
export function pickMarkers(
  vsAll: SatV[],
  n: number,
  view: [number, number, number, number],
): SatV[] {
  const [x0, y0, w, h] = view;
  const vs = vsAll.filter(
    (v) =>
      v.px[0] > x0 + 40 &&
      v.px[0] < x0 + w - 40 &&
      v.px[1] > y0 + 40 &&
      v.px[1] < y0 + h - 40 &&
      v.name,
  );
  if (!vs.length) return [];
  const argmax = (f: (v: SatV) => number): SatV =>
    vs.reduce((a, b) => (f(b) > f(a) ? b : a));
  const ch = [argmax((v) => v.px[0] + v.px[1] * 0.3)];
  while (ch.length < n && ch.length < vs.length)
    ch.push(
      argmax((v) =>
        Math.min(
          ...ch.map((c) => Math.hypot(v.px[0] - c.px[0], v.px[1] - c.px[1])),
        ),
      ),
    );
  return ch;
}

type XY = [number, number];
/** Monotone-chain convex hull (the builder's hull()). */
export function hull(ptsIn: XY[]): XY[] {
  const pts = [...new Map(ptsIn.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  if (pts.length < 3) return pts;
  const cr = (o: XY, a: XY, b: XY): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: XY[] = [];
  for (const p of pts) {
    while (lo.length >= 2 && cr(lo[lo.length - 2]!, lo[lo.length - 1]!, p) <= 0) lo.pop();
    lo.push(p);
  }
  const up: XY[] = [];
  for (const p of [...pts].reverse()) {
    while (up.length >= 2 && cr(up[up.length - 2]!, up[up.length - 1]!, p) <= 0) up.pop();
    up.push(p);
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}
export function grow(poly: XY[], g: number): XY[] {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / d) * g, y + ((y - cy) / d) * g];
  });
}
/** Connected groups of live vessels (single linkage, r mosaic px), 3 or more. */
export function clusters(vs: SatV[], r = 62): SatV[][] {
  const seen = new Set<number>();
  const out: SatV[][] = [];
  vs.forEach((_, i) => {
    if (seen.has(i)) return;
    const grp = [i];
    seen.add(i);
    for (let k = 0; k < grp.length; k++) {
      const a = vs[grp[k]!]!;
      vs.forEach((b, j) => {
        if (!seen.has(j) && Math.hypot(a.px[0] - b.px[0], a.px[1] - b.px[1]) < r) {
          seen.add(j);
          grp.push(j);
        }
      });
    }
    out.push(grp.map((g) => vs[g]!));
  });
  return out.filter((g) => g.length >= 3);
}
/** The two biggest clusters: the red watch boxes. */
export const watchBoxes = (vs: SatV[]): SatV[][] =>
  clusters(vs)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);

/** Profile vessel of the data-aware slide: freshest named cargo-type track in the view. */
export function profileVessel(vs: SatV[]): SatV | null {
  const inbox = (v: SatV): boolean =>
    v.px[0] > 300 && v.px[0] < SATW - 300 && v.px[1] > 300 && v.px[1] < SATH - 300;
  const cargo = vs.filter(
    (v) =>
      inbox(v) &&
      v.name &&
      ["Cargo", "Tanker", "70", "80"].includes(String(v.shipType)) &&
      v.ageS != null,
  );
  const named = vs.filter((v) => inbox(v) && v.name);
  const cand = cargo.length ? cargo : named.length ? named : vs.filter((v) => v.name);
  if (!cand.length) return null;
  return cand.reduce((a, b) => ((b.ageS ?? Infinity) < (a.ageS ?? Infinity) ? b : a));
}

// ── E10 ontology incidents linked to their detector domains ──────────────────
export const INC_QUERIES = "aeiou123.-sv".split("");
export function incidentsOf(lists: (OntoObj[] | null)[]): {
  inc: Incident[];
  seen: number;
} {
  const seen = new Map<string, OntoObj>();
  for (const l of lists) for (const x of l ?? []) seen.set(x.id, x);
  const inc = [...seen.values()]
    .filter((x) => x.kind === "incident" && Array.isArray(x.props["domains"]) && (x.props["domains"] as unknown[]).length)
    .map((x) => ({
      id: x.id,
      threat: (x.props["threat_level"] as string | undefined) ?? null,
      score: (x.props["score"] as number | undefined) ?? null,
      domains: x.props["domains"] as string[],
    }));
  return { inc, seen: seen.size };
}
export function graphData(all: Incident[], n = 46): { inc: Incident[]; doms: string[] } {
  const sorted = [...all].sort(
    (a, b) => -(a.score ?? 0) + (b.score ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const step = Math.max(1, Math.floor(sorted.length / n));
  const inc = sorted.filter((_, i) => i % step === 0).slice(0, n);
  const doms: string[] = [];
  for (const i of inc) for (const d of i.domains) if (!doms.includes(d)) doms.push(d);
  return { inc, doms };
}
/** Count by key, as the builder's dict loops do (Python str(None) is "None"). */
export function countBy<T>(xs: T[], key: (x: T) => string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) for (const k of key(x)) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

// ── E11 lineage chains, derived from the live edges ──────────────────────────
/** One row per transform: (first input, transform, first output). */
export function lineageChains(lin: Lineage): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const t of lin.nodes.filter((n) => n.type === "transform")) {
    const a = lin.edges.find((e) => e.dst === t.id)?.src;
    const b = lin.edges.find((e) => e.src === t.id)?.dst;
    if (a && b) out.push([a, t.id, b]);
  }
  // rows that share a source sit next to each other, as the copy draws them
  const firstRow = new Map<string, number>();
  out.forEach(([a], i) => firstRow.has(a) || firstRow.set(a, i));
  return out
    .map((c, i) => [c, i] as const)
    .sort((x, y) => firstRow.get(x[0][0])! - firstRow.get(y[0][0])! || x[1] - y[1])
    .map(([c]) => c);
}
export function lineageLayoutEu(lin: Lineage): Map<string, XY> {
  const X = [430, 760, 1090];
  const Y0L = 480;
  const PITCH = 96;
  const pos = new Map<string, XY>();
  const rowsOf = new Map<string, number[]>();
  lineageChains(lin).forEach(([a, t, b], r) => {
    const y = Y0L + r * PITCH;
    rowsOf.set(a, [...(rowsOf.get(a) ?? []), y]);
    pos.set(t, [X[1]! + (((r * 37) % 5) - 2) * 9, y + (((r * 53) % 5) - 2) * 8]);
    pos.set(b, [X[2]! + (((r * 29) % 5) - 2) * 11, y + (((r * 41) % 7) - 3) * 8]);
  });
  // a source feeding several transforms sits between their rows
  for (const [a, ys] of rowsOf)
    pos.set(a, [X[0]!, ys.reduce((s, y) => s + y, 0) / ys.length]);
  return pos;
}

// ── sun (gotham/_fb_assets.py subsolar) ───────────────────────────────────────
const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const jd = (t: number): number => t / 86400 + 2440587.5;
const gmst = (j: number): number => {
  const tt = (j - 2451545.0) / 36525.0;
  const g = 280.46061837 + 360.98564736629 * (j - 2451545.0) + 0.000387933 * tt * tt;
  return (((g % 360) + 360) % 360) * D2R;
};
/** Sub-solar point [declination, longitude] in degrees at unix time t (s). */
export function subsolar(t: number): [number, number] {
  const j = jd(t);
  const n = j - 2451545.0;
  const L = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * D2R;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const lon = (ra - gmst(j)) * R2D;
  return [dec * R2D, ((((lon + 180) % 360) + 360) % 360) - 180];
}
export function solarElev(t: number, lat: number, lon: number): number {
  const [dec, slon] = subsolar(t);
  const la = lat * D2R;
  return (
    Math.asin(
      Math.sin(la) * Math.sin(dec * D2R) +
        Math.cos(la) * Math.cos(dec * D2R) * Math.cos((lon - slon) * D2R),
    ) * R2D
  );
}

// ── satellites (_eu_data.py) ──────────────────────────────────────────────────
export const AOI: [number, number] = [26.55, 56.3]; // Strait of Hormuz
const SAR_KEYS = [
  "CAPELLA",
  "ICEYE",
  "UMBRA",
  "SENTINEL-1",
  "TERRASAR",
  "TANDEM-X",
  "COSMO-SKYMED",
  "RADARSAT",
  "SAOCOM",
  "NISAR",
  "PAZ",
  "KOMPSAT-5",
  "RISAT-2B",
  "RISAT-1",
  "ALOS-2",
  "STRIX",
  "SYNSPECTIVE",
];
export const isSar = (name: string): boolean => {
  const u = name.toUpperCase();
  return SAR_KEYS.some((k) => u.includes(k)) && !u.includes("DEB");
};
export interface PassRow {
  name: string;
  norad: string;
  t0: number;
  t1: number;
  peak: number;
  tle: [string, string];
}
export interface Plan {
  sarCount: number;
  best: PassRow | null;
  win0: number;
  passes: PassRow[]; // inside the 6 h mission window
}
/** Every SAR-named pass at 15 deg or more over the AOI from now-3h to now+9h,
 *  the selected collect (next CAPELLA at 35 deg or more, else the highest of
 *  the next six) and the 6 h mission window with it 2.7 h in. */
export function planPasses(items: Omm[], now: number): Plan {
  const sar = items.filter(
    (i) => i.TLE_LINE1 && i.TLE_LINE2 && isSar(i.OBJECT_NAME ?? ""),
  );
  const win = { startMs: (now - 3 * 3600) * 1000, endMs: (now + 9 * 3600) * 1000 };
  const rows: PassRow[] = [];
  for (const it of sar)
    for (const p of passesOverAoi(it.TLE_LINE1!, it.TLE_LINE2!, { lat: AOI[0], lon: AOI[1] }, win, 15, 15))
      rows.push({
        name: (it.OBJECT_NAME ?? "").trim(),
        norad: String(it.NORAD_CAT_ID ?? ""),
        t0: p.startMs / 1000,
        t1: p.endMs / 1000,
        peak: p.maxElevDeg,
        tle: [it.TLE_LINE1!, it.TLE_LINE2!],
      });
  rows.sort((a, b) => a.t0 - b.t0);
  const future = rows.filter((r) => r.t0 > now);
  const best =
    future.find((r) => r.name.includes("CAPELLA") && r.peak >= 35) ??
    future.slice(0, 6).reduce<PassRow | null>((a, b) => (!a || b.peak > a.peak ? b : a), null);
  const win0 = best ? best.t0 - Math.trunc(2.7 * 3600) : now - Math.trunc(2.7 * 3600);
  return {
    sarCount: sar.length,
    best,
    win0,
    passes: rows.filter((r) => r.t0 >= win0 && r.t0 <= win0 + 6 * 3600),
  };
}
/** az/el of the selected pass at 15 s steps (the sky plot). */
export const passSky = (p: PassRow): { az: number; el: number }[] =>
  skyView(p.tle[0], p.tle[1], { lat: AOI[0], lon: AOI[1] }, { startMs: p.t0 * 1000, endMs: p.t1 * 1000 }, 15).map(
    (s) => ({ az: s.azDeg, el: s.elDeg }),
  );
/** ECEF km positions of the satellite at the given unix seconds. */
export function satEcef(tle: [string, string], ts: number[]): ([number, number, number] | null)[] {
  const rec = twoline2satrec(tle[0], tle[1]);
  return ts.map((t) => {
    const d = new Date(t * 1000);
    const pv = propagate(rec, d);
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;
    const e = eciToEcf(pv.position as EciVec3<Kilometer>, gstime(d));
    return [e.x, e.y, e.z];
  });
}
export const periodS = (tle: [string, string]): number =>
  ((2 * Math.PI) / twoline2satrec(tle[0], tle[1]).no) * 60;

// ── orthographic globe (gotham/_fb_assets.py) ─────────────────────────────────
export const RE = 6378.137;
export type V3 = [number, number, number];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function llaEcef(lat: number, lon: number, h = 0): V3 {
  const la = lat * D2R;
  const lo = lon * D2R;
  return [
    (RE + h) * Math.cos(la) * Math.cos(lo),
    (RE + h) * Math.cos(la) * Math.sin(lo),
    (RE + h) * Math.sin(la),
  ];
}
export type Basis = [V3, V3, V3];
export function orthoBasis(lat0: number, lon0: number): Basis {
  const la = lat0 * D2R;
  const lo = lon0 * D2R;
  const cen: V3 = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const east: V3 = [-Math.sin(lo), Math.cos(lo), 0];
  return [cen, east, cross(cen, east)];
}
/** ECEF km -> frame px and depth (> 0 faces the camera). */
export function proj(P: V3, b: Basis, R: number, cx: number, cy: number): V3 {
  const k = R / RE;
  return [cx + dot(P, b[1]) * k, cy - dot(P, b[2]) * k, dot(P, b[0])];
}
export function sphereCircle(lat: number, lon: number, angDeg: number, n = 90): V3[] {
  const [cen, east, north] = orthoBasis(lat, lon);
  const a = angDeg * D2R;
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * 2 * Math.PI;
    return [0, 1, 2].map(
      (k) => RE * (Math.cos(a) * cen[k]! + Math.sin(a) * (Math.cos(t) * east[k]! + Math.sin(t) * north[k]!)),
    ) as V3;
  });
}
/** The view centre that puts the AOI at (tx, ty) on a globe of radius R at (cx, cy). */
export function solveCentre(R: number, cx: number, cy: number, tx: number, ty: number): [number, number] {
  const la = AOI[0] * D2R;
  const lo = AOI[1] * D2R;
  let best: [number, number, number] | null = null;
  for (let lat0 = -10; lat0 < 70; lat0 += 0.5)
    for (let lon0 = AOI[1] - 80; lon0 < AOI[1] + 80; lon0 += 0.5) {
      const l0 = lat0 * D2R;
      const o0 = lon0 * D2R;
      const u = Math.cos(la) * Math.sin(lo - o0);
      const v = Math.cos(l0) * Math.sin(la) - Math.sin(l0) * Math.cos(la) * Math.cos(lo - o0);
      const vis = Math.sin(l0) * Math.sin(la) + Math.cos(l0) * Math.cos(la) * Math.cos(lo - o0);
      if (vis <= 0) continue;
      const e = (cx + u * R - tx) ** 2 + (cy - v * R - ty) ** 2;
      if (!best || e < best[0]) best = [e, lat0, lon0];
    }
  return [best![1], best![2]];
}
/** Split a projected polyline where it goes behind the globe. */
export function visibleRuns(pts: V3[], b: Basis, R: number, cx: number, cy: number): XY[][] {
  const runs: XY[][] = [];
  let seg: XY[] = [];
  for (const P of pts) {
    const [x, y, d] = proj(P, b, R, cx, cy);
    if (d > 0) seg.push([x, y]);
    else {
      if (seg.length > 1) runs.push(seg);
      seg = [];
    }
  }
  if (seg.length > 1) runs.push(seg);
  return runs;
}
/** Paint the shaded orthographic plate (globe_rgb + render_view shading) into rgba. */
export function paintGlobe(
  eq: { data: Uint8ClampedArray; width: number; height: number },
  out: Uint8ClampedArray,
  VW: number,
  VH: number,
  b: Basis,
  R: number,
  cx: number,
  cy: number,
  sun: V3,
  tint: V3,
  haze: number,
): void {
  const [cen, east, north] = b;
  const EW = eq.width;
  const EH = eq.height;
  for (let yy = 0; yy < VH; yy++)
    for (let xx = 0; xx < VW; xx++) {
      const o = (yy * VW + xx) * 4;
      const u = (xx - cx) / R;
      const v = -(yy - cy) / R;
      const r2 = u * u + v * v;
      out[o + 3] = 255;
      if (r2 > 1) {
        out[o] = 4;
        out[o + 1] = 6;
        out[o + 2] = 12;
        continue;
      }
      const w = Math.sqrt(1 - r2);
      const P: V3 = [0, 1, 2].map((k) => u * east[k]! + v * north[k]! + w * cen[k]!) as V3;
      const lat = Math.asin(Math.max(-1, Math.min(1, P[2]))) * R2D;
      const lon = Math.atan2(P[1], P[0]) * R2D;
      const px = Math.min(Math.max(((lon + 180) / 360) * (EW - 1), 0), EW - 1.01);
      const py = Math.min(Math.max(((90 - lat) / 180) * (EH - 1), 0), EH - 1.01);
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      const c = [0, 1, 2].map((k) => {
        const at = (x: number, y: number): number => eq.data[(y * EW + x) * 4 + k]!;
        return (
          at(x0, y0) * (1 - fx) * (1 - fy) +
          at(x0 + 1, y0) * fx * (1 - fy) +
          at(x0, y0 + 1) * (1 - fx) * fy +
          at(x0 + 1, y0 + 1) * fx * fy
        );
      });
      const sh = Math.min(Math.max((dot(P, sun) + 0.1) / 0.35, 0.1), 1);
      const wat = Math.min(Math.max((c[2]! - c[0]! - 4) / 20, 0), 1);
      const rr = Math.sqrt(r2);
      const fres = Math.min(Math.max((rr - 0.8) / 0.2, 0), 1) ** 2;
      const glow = [40, 70, 120];
      for (let k = 0; k < 3; k++) {
        const col = c[k]! * (0.78 - 0.3 * wat) * sh + fres * glow[k]! * 0.8;
        out[o + k] = col * (1 - haze) + tint[k]! * haze;
      }
    }
}
