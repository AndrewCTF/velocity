// Live data for the document-figure copy (gotham/pdf/gotham-a.html). The
// builder read gotham/pdf/overlay/pa-live.json (a snapshot of :8000) plus the
// minute polls of /api/maritime/vessels?bbox= under _refs/base/ais-poll/. Here
// every value comes from the same routes, read now, and the builder's
// derivations are ported as pure functions (tested in data.test.ts).
import { useEffect, useState } from "react";
import { fetchJson } from "../aip/data.js";

export { useJson, unavailable, resetCache, fetchJson } from "../aip/data.js";
export type { Res } from "../aip/data.js";

/** The recorder box the builder polled (_refs/base/ais-poll/*.json "bbox"). */
export const POLLBOX = [54.72, 25.38, 57.98, 27.31] as const;
export const R_KM = 10; // the incident radius of the copy's situation
export const VESSELS = `/api/maritime/vessels?bbox=${POLLBOX.join(",")}`;
export const PORTS = `/api/places/ports?bbox=${POLLBOX.join(",")}&limit=200`;

export interface Vessel {
  id: string;
  mmsi: number;
  lat: number;
  lon: number;
  t: number;
  ageS?: number | null;
  sog?: number | null;
  cog?: number | null;
  heading?: number | null;
  name?: string | null;
  shipType?: number | string | null;
  flag?: string | null;
  origin?: string | null;
  source?: string | null;
  sources?: string[] | null;
}
export interface VesselsRes {
  bbox: number[];
  count: number;
  vessels: Vessel[];
}
export interface Port {
  name: string;
  lon: number;
  lat: number;
}
export interface Status {
  vessel_count: number;
  aircraft_count: number;
  generated_at?: string | number;
}
export interface Alert {
  id: string;
  severity: string;
  t: number;
  geom: { coordinates: number[] };
  message: string;
  contributingObservations: string[];
}
export interface Standing {
  detections: {
    summary: string;
    entity_id: string;
    lat: number;
    lon: number;
    rule_label: string;
    kind: string;
    severity_word: string;
  }[];
  counts: Record<string, number>;
  as_of: number;
}
export interface Rule {
  id: string;
  label: string;
}
export interface Evidence {
  id: string;
  props: {
    filename?: string | null;
    title?: string | null;
    source_url?: string | null;
    captured_by: string;
    capture_method: string;
    captured_at?: string;
  };
}
export interface Warning {
  geometry: { coordinates: number[] } | null;
  properties: { msgNumber: number; msgYear: number; navArea: string };
}
export interface Choke {
  name: string;
  vessels: number;
  stationary: number;
  congestion: string;
  lon: number;
  lat: number;
}
export interface Sanc {
  matched: boolean;
  lists: string[];
  fetched_at: number;
}
export interface Watch {
  changes: { new: { key: string }[] };
}

// ── time / text ───────────────────────────────────────────────────────────────
const p2 = (n: number): string => String(n).padStart(2, "0");
/** hhmm(t, sec): "14:39Z" / "14:39:05Z" (UTC, t in seconds). */
export function hhmm(t: number, sec = false): string {
  const d = new Date(t * 1000);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${sec ? `:${p2(d.getUTCSeconds())}` : ""}Z`;
}
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** dmy(t): "22 OCT 2026". */
export function dmy(t: number): string {
  const d = new Date(t * 1000);
  return `${p2(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** "10/22/2026". */
export function mdy(t: number): string {
  const d = new Date(t * 1000);
  return `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${d.getUTCFullYear()}`;
}
export const TRK = (m: number): string => `Track ${String(m % 10000).padStart(4, "0")}`;
export const title = (s: string): string =>
  s.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

const SHIPTYPE: Record<number, string> = {
  30: "Fishing", 31: "Towing", 32: "Towing", 33: "Dredging", 34: "Diving", 35: "Military", 36: "Sailing",
  37: "Pleasure craft", 40: "High-speed craft", 50: "Pilot", 51: "SAR", 52: "Tug", 53: "Port tender",
  55: "Law enforcement", 58: "Medical", 60: "Passenger", 70: "Cargo", 80: "Tanker", 90: "Other", 99: "Other",
};
/** The builder's stype(): AIS ship-type code or label as a display word. */
export function stype(v: number | string | null | undefined): string {
  if (typeof v === "string")
    return v === v.toUpperCase() || v === v.toLowerCase()
      ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()
      : v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
  if (v === null || v === undefined) return "Unknown";
  return SHIPTYPE[v] ?? SHIPTYPE[Math.floor(v / 10) * 10] ?? "Other";
}

/** Equirectangular km between [lon, lat] points (the builder's km()). */
export function km(a: readonly number[], b: readonly number[]): number {
  const [ax = 0, ay = 0] = a;
  const [bx = 0, by = 0] = b;
  const r = Math.PI / 180;
  return 6371 * Math.hypot((bx - ax) * r * Math.cos(ay * r), (by - ay) * r);
}

// ── the Browser search (D5, D6) ───────────────────────────────────────────────
export function portsOf(fc: { features?: { geometry: { coordinates: number[] } | null; properties: { name?: string } }[] } | null | undefined): Port[] {
  return (fc?.features ?? []).flatMap((f) =>
    f.geometry && f.properties.name
      ? [{ name: f.properties.name, lon: f.geometry.coordinates[0] ?? 0, lat: f.geometry.coordinates[1] ?? 0 }]
      : [],
  );
}
/** The place the keyword names: the first port in the recorder box whose name
 *  contains it. The copy's search is a keyword over the nearest-place property. */
export function placeFor(ports: Port[], kw: string): Port | null {
  const k = kw.trim().toLowerCase();
  if (!k) return null;
  return ports.find((p) => p.name.toLowerCase().includes(k)) ?? null;
}

export interface Hit {
  v: Vessel;
  mmsi: number;
  name: string;
  type: string;
  sog: number;
  d: number;
}
/** RES: every named vessel whose last fix is within r km of the place, nearest
 *  first. */
export function results(vs: Vessel[], c: Port, r = R_KM): Hit[] {
  const out: Hit[] = [];
  for (const v of vs) {
    const d = km([c.lon, c.lat], [v.lon, v.lat]);
    const name = (v.name ?? "").trim();
    if (d <= r && name)
      out.push({ v, mmsi: v.mmsi, name, type: stype(v.shipType), sog: v.sog ?? 0, d });
  }
  return out.sort((a, b) => a.d - b.d);
}
/** SHOWN: the result list with the selected object third, as the copy lays
 *  it out. */
export function shown(res: Hit[], sel: Hit | null): Hit[] {
  if (!sel) return res;
  const o = res.filter((r) => r !== sel);
  o.splice(Math.min(2, o.length), 0, sel);
  return o;
}

// ── the Explorer (D14-D17) ────────────────────────────────────────────────────
export const FIELDS: [string, keyof Vessel][] = [
  ["Name", "name"], ["MMSI", "mmsi"], ["Ship type", "shipType"], ["Latitude", "lat"], ["Longitude", "lon"],
  ["Last fix", "t"], ["Speed over ground", "sog"], ["Source", "source"], ["Heading", "heading"],
  ["Flag state", "flag"], ["Course over ground", "cog"], ["Origin", "origin"], ["Fix age", "ageS"],
  ["Sources", "sources"], ["Entity id", "id"],
];
const has = (v: Vessel, k: keyof Vessel): boolean => v[k] !== null && v[k] !== undefined && v[k] !== "";
/** PROPS: property presence counts over the set, most first, Origin sixth. */
export function propCounts(set: Vessel[]): [string, number][] {
  const p = FIELDS.map(([nm, k]) => [nm, set.filter((v) => has(v, k)).length] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .filter((x) => x[1] > 0);
  const oi = p.findIndex((x) => x[0] === "Origin");
  if (oi >= 0) p.splice(Math.min(5, p.length - 1), 0, ...p.splice(oi, 1));
  return p;
}
/** Value histogram of one property over the set (the Origin histogram). */
export function valueHist(set: Vessel[], prop: string): [string, number][] {
  const k = FIELDS.find((f) => f[0] === prop)?.[1] ?? "origin";
  const h = new Map<string, number>();
  for (const v of set) {
    const raw = v[k];
    const s = raw === null || raw === undefined || raw === "" ? "n/a" : Array.isArray(raw) ? raw.join(", ") : String(raw);
    h.set(s, (h.get(s) ?? 0) + 1);
  }
  return [...h.entries()].sort((a, b) => b[1] - a[1]);
}

export type Step = "box" | "radius" | "stationary" | "origin";
export interface Stage {
  step: Step;
  from: number;
  to: number;
}
/** The filter path: each active step keeps a subset of the previous one.
 *  "box" = the recorder box (from the live store's vessel count), "radius" =
 *  within R_KM of the place, "stationary" = last fix at 0.0 kn, "origin" =
 *  objects that carry the Origin property. */
export function funnel(
  storeN: number,
  box: Vessel[],
  c: Port | null,
  steps: Step[],
): { stages: Stage[]; set: Vessel[] } {
  let cur = box;
  let n = storeN;
  const stages: Stage[] = [];
  for (const s of steps) {
    const next =
      s === "box"
        ? box
        : s === "radius"
          ? c ? results(cur, c).map((h) => h.v) : []
          : s === "stationary"
            ? cur.filter((v) => (v.sog ?? 0) === 0)
            : cur.filter((v) => has(v, "origin"));
    stages.push({ step: s, from: s === "box" ? n : cur.length, to: next.length });
    cur = next;
    n = next.length;
  }
  return { stages, set: cur };
}

// ── Links (D11) ───────────────────────────────────────────────────────────────
/** The two nearest distinct NGA warnings, as "NAVAREA P 1540/24". */
export function nearestWarnings(ws: Warning[], lon: number, lat: number, n = 2): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const at = ws
    .filter((f) => f.geometry)
    .sort((a, b) =>
      Math.hypot((a.geometry!.coordinates[0] ?? 0) - lon, (a.geometry!.coordinates[1] ?? 0) - lat) -
      Math.hypot((b.geometry!.coordinates[0] ?? 0) - lon, (b.geometry!.coordinates[1] ?? 0) - lat),
    );
  for (const f of at) {
    const p = f.properties;
    const key = `${p.msgNumber}/${p.msgYear}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`NAVAREA ${p.navArea} ${p.msgNumber}/${String(p.msgYear).slice(2)}`);
    if (out.length === n) break;
  }
  return out;
}
/** NGA warnings inside the builder's Gulf box (48-60 E, 22-30 N). */
export const gulfWarnings = (ws: Warning[]): Warning[] =>
  ws.filter((f) => {
    const [x = 0, y = 0] = f.geometry?.coordinates ?? [];
    return f.geometry && x >= 48 && x <= 60 && y >= 22 && y <= 30;
  });
/** Incident alerts within 100 km, nearest first, as the copy words them. */
export function nearbyEvents(al: Alert[], lon: number, lat: number, n = 4): string[] {
  const d = (a: Alert): number => km([lon, lat], a.geom.coordinates);
  return al
    .filter((a) => d(a) <= 100)
    .sort((a, b) => d(a) - d(b))
    .slice(0, n)
    .map((a) => {
      const sev = a.severity.charAt(0).toUpperCase() + a.severity.slice(1).toLowerCase();
      const what = (a.contributingObservations[0] ?? "").split(":").pop()?.split("+").join(", ") ?? "";
      return `${sev} incident, ${what}, ${hhmm(a.t / 1000)} · ${d(a).toFixed(0)} km`;
    });
}
/** Alerts in the builder's region box (32-62 E, 10-31 N), oldest first. */
export const regionAlerts = (al: Alert[]): Alert[] =>
  al
    .filter((a) => {
      const [x = 0, y = 0] = a.geom.coordinates;
      return x >= 32 && x <= 62 && y >= 10 && y <= 31;
    })
    .sort((a, b) => a.t - b.t);
export const nearestPorts = (ports: Port[], lon: number, lat: number, n = 5): Port[] =>
  [...ports].sort((a, b) => km([lon, lat], [a.lon, a.lat]) - km([lon, lat], [b.lon, b.lat])).slice(0, n);
export const chokesNear = (cs: Choke[], lon: number, lat: number, maxKm = 300): Choke[] =>
  cs.filter((c) => km([lon, lat], [c.lon, c.lat]) <= maxKm);
export function chokesOf(fc: { features?: { geometry: { coordinates: number[] } | null; properties: Omit<Choke, "lon" | "lat"> }[] } | null | undefined): Choke[] {
  return (fc?.features ?? []).flatMap((f) =>
    f.geometry ? [{ ...f.properties, lon: f.geometry.coordinates[0] ?? 0, lat: f.geometry.coordinates[1] ?? 0 }] : [],
  );
}
/** Count of the live record's reported (non-empty) properties. */
export const nProps = (v: Vessel): number => FIELDS.filter(([, k]) => has(v, k)).length;

// ── the fix series (Fix times, changes, History) ──────────────────────────────
// The builder's recorder was a minute poll of the box. Here the app is that
// recorder while it is open: each box pull appends every hull's fix, and the
// archive (/api/history/track) adds whatever it holds for the selected hull.
export type Fix = [t: number, lon: number, lat: number, sog: number, src?: string];
const rec = new Map<number, Map<number, Fix>>();
let polls = 0;
let lastPoll = 0;
export function record(vs: Vessel[]): void {
  polls += 1;
  for (const v of vs) {
    if (!rec.has(v.mmsi)) rec.set(v.mmsi, new Map());
    rec.get(v.mmsi)!.set(v.t, [v.t, v.lon, v.lat, v.sog ?? 0, v.source ?? "n/a"]);
    lastPoll = Math.max(lastPoll, v.t);
  }
}
/** The recorded fixes of a set of hulls, one per (MMSI, fix time), each with
 *  the source the pull reported it under (the builder's FIX map). */
export function recFixes(mmsis: Set<number>): { mmsi: number; t: number; src: string }[] {
  const out: { mmsi: number; t: number; src: string }[] = [];
  for (const m of mmsis) for (const f of rec.get(m)?.values() ?? []) out.push({ mmsi: m, t: f[0], src: f[4] ?? "n/a" });
  return out;
}
export const recorder = (): { polls: number; last: number } => ({ polls, last: lastPoll });
/** Merge archive points ([lon, lat, t, ...]) with the session's fixes, oldest
 *  first, one per timestamp. */
export function series(mmsi: number, archive: number[][] = []): Fix[] {
  const m = new Map<number, Fix>(rec.get(mmsi) ?? []);
  for (const p of archive) {
    const [lon, lat, t, sog] = p;
    if (typeof t === "number" && typeof lon === "number" && typeof lat === "number")
      if (!m.has(t)) m.set(t, [t, lon, lat, typeof sog === "number" ? sog : 0]);
  }
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}

/** The box pull, re-read every minute while the app is open (the recorder's
 *  cadence). Each answer is recorded before it is returned. */
export function useVessels(): { res: import("../aip/data.js").Res<VesselsRes> | null; tick: number } {
  const [res, setRes] = useState<import("../aip/data.js").Res<VesselsRes> | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const pull = (fresh: boolean): void => {
      void fetchJson<VesselsRes>(VESSELS, fresh).then((r) => {
        if (!live) return;
        if (r.ok && r.data && fresh) record(r.data.vessels);
        setRes(r);
        setTick((n) => n + 1);
      });
    };
    pull(true);
    const id = window.setInterval(() => pull(true), 60_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);
  return { res, tick };
}

// ── the Timeline (D40) and the video's replay strip (D55) ────────────────────
/** The builder's BINS: fixes per `bin` seconds from the first fix to the last,
 *  each bin counting fixes per source; sources ordered by total, most first. */
export function fixBins(fx: { t: number; src: string }[], bin: number): { t0: number; t1: number; b0: number; bins: Map<string, number>[]; order: [string, number][]; max: number } | null {
  if (!fx.length) return null;
  const t0 = Math.min(...fx.map((f) => f.t)), t1 = Math.max(...fx.map((f) => f.t));
  const b0 = Math.floor(t0 / bin);
  const bins = Array.from({ length: Math.floor(t1 / bin) - b0 + 1 }, () => new Map<string, number>());
  const tot = new Map<string, number>();
  for (const f of fx) {
    const b = bins[Math.floor(f.t / bin) - b0]!;
    b.set(f.src, (b.get(f.src) ?? 0) + 1);
    tot.set(f.src, (tot.get(f.src) ?? 0) + 1);
  }
  const order = [...tot.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(...bins.map((b) => [...b.values()].reduce((a, n) => a + n, 0)));
  return { t0, t1, b0, bins, order, max };
}
