// Pure parts of the situation object view (features copy, G6 to G10). Ported
// from gotham/_build_features.py: tclass, CLS, the nearest NGA warnings, the
// farthest-point pick of five hulls for the layout card, and the chip wrap.

import { distKm } from "../object/activity.js";

export const CLASS_ABBR: Record<string, string> = {
  "Tug / special craft": "TG",
  Tanker: "TK",
  Cargo: "CG",
  Passenger: "PX",
  Fishing: "FV",
  "Pleasure craft": "PC",
  Other: "OT",
};

/** AIS ship type (code or text) to the copy's six classes. */
export function tclass(t: unknown): string {
  const s = String(t ?? "").trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if ([31, 32, 33, 34].includes(n) || (n >= 50 && n <= 59))
      return "Tug / special craft";
    if (n >= 80 && n <= 89) return "Tanker";
    if (n >= 70 && n <= 79) return "Cargo";
    if (n >= 60 && n <= 69) return "Passenger";
    if (n === 30) return "Fishing";
    if (n === 36 || n === 37) return "Pleasure craft";
    return "Other";
  }
  const l = s.toLowerCase();
  if (/^(tug|towing|pilot|search|port tender)/.test(l))
    return "Tug / special craft";
  if (l.startsWith("tanker")) return "Tanker";
  if (l.startsWith("cargo")) return "Cargo";
  if (l.startsWith("passenger")) return "Passenger";
  if (l.startsWith("fishing")) return "Fishing";
  if (/^(pleasure|sailing)/.test(l)) return "Pleasure craft";
  return "Other";
}

/** Class counts, largest first. */
export function classCounts(types: unknown[]): [string, number][] {
  const m = new Map<string, number>();
  for (const t of types) m.set(tclass(t), (m.get(tclass(t)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export interface Warning {
  msgNumber?: number;
  msgYear?: number;
  text?: string;
  issueDate?: string;
  authority?: string;
  lon: number;
  lat: number;
  d_km: number;
}

/** NGA warnings within `maxKm` of a point, nearest first, one per message. */
export function nearestWarnings(
  fc: {
    features?: {
      geometry?: { type?: string; coordinates?: number[] };
      properties?: Record<string, unknown>;
    }[];
  },
  lat: number,
  lon: number,
  maxKm = 60,
): Warning[] {
  const best = new Map<string, Warning>();
  for (const f of fc.features ?? []) {
    const g = f.geometry;
    if (g?.type !== "Point" || !g.coordinates) continue;
    const [lo, la] = g.coordinates;
    if (typeof lo !== "number" || typeof la !== "number") continue;
    const d = distKm(lat, lon, la, lo);
    if (d > maxKm) continue;
    const p = f.properties ?? {};
    const key = `${String(p["msgYear"])}-${String(p["msgNumber"])}`;
    const prev = best.get(key);
    if (prev && prev.d_km <= d) continue;
    best.set(key, {
      ...(typeof p["msgNumber"] === "number"
        ? { msgNumber: p["msgNumber"] }
        : {}),
      ...(typeof p["msgYear"] === "number" ? { msgYear: p["msgYear"] } : {}),
      ...(typeof p["text"] === "string" ? { text: p["text"] } : {}),
      ...(typeof p["issueDate"] === "string"
        ? { issueDate: p["issueDate"] }
        : {}),
      ...(typeof p["authority"] === "string"
        ? { authority: p["authority"] }
        : {}),
      lon: lo,
      lat: la,
      d_km: d,
    });
  }
  return [...best.values()].sort((a, b) => a.d_km - b.d_km);
}

export const warnId = (w: Warning): string =>
  `${w.msgNumber ?? "?"}/${String(w.msgYear ?? "").slice(2)}`;

/** "091931Z JUN 2023" reads "09 Jun 2023". */
export function published(issue: string | undefined): string | null {
  const m = issue?.match(/^(\d{2})\d{4}Z\s+([A-Z]{3})\s+(\d{4})/);
  if (!m) return null;
  return `${m[1]} ${m[2]![0]}${m[2]!.slice(1).toLowerCase()} ${m[3]}`;
}

/** "NAVAREA IX 245/23" out of the authority line. */
export function authorityShort(a: string | undefined): string | null {
  if (!a) return null;
  return a.match(/NAVAREA [IVX]+ \d+\/\d+/)?.[0] ?? a.slice(0, 24);
}

/** Five points visibly apart: farthest-point sampling from the first. */
export function farthestPick<T extends { x: number; y: number }>(
  pool: T[],
  n = 5,
): T[] {
  if (!pool.length) return [];
  const pick = [pool[0]!];
  while (pick.length < Math.min(n, pool.length)) {
    let best: T | null = null;
    let bd = -1;
    for (const p of pool) {
      if (pick.includes(p)) continue;
      const d = Math.min(...pick.map((a) => Math.hypot(p.x - a.x, p.y - a.y)));
      if (d > bd) {
        bd = d;
        best = p;
      }
    }
    if (!best) break;
    pick.push(best);
  }
  return pick;
}

/** Word-wrap to `width` columns; phrases in `chips` come back marked so the
 *  view can draw them as entity chips (they may break across lines). */
export function wrapChips(
  text: string,
  chips: string[],
  width: number,
): { t: string; chip: boolean }[][] {
  const ranges: [number, number][] = [];
  for (const c of chips) {
    if (!c) continue;
    let i = text.indexOf(c);
    while (i >= 0) {
      const e = i + c.length;
      if (!ranges.some(([a, b]) => i < b && e > a)) ranges.push([i, e]);
      i = text.indexOf(c, e);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: [number, number][] = [];
  let pos = 0;
  let start = -1;
  let end = -1;
  for (const w of words) {
    const at = text.indexOf(w, pos);
    pos = at + w.length;
    if (start < 0) {
      start = at;
      end = pos;
    } else if (pos - start <= width) end = pos;
    else {
      lines.push([start, end]);
      start = at;
      end = pos;
    }
  }
  if (start >= 0) lines.push([start, end]);
  return lines.map(([a, b]) => {
    const segs: { t: string; chip: boolean }[] = [];
    let p = a;
    for (const [ca, cb] of ranges) {
      const s = Math.max(ca, a);
      const e = Math.min(cb, b);
      if (s >= e) continue;
      if (s > p) segs.push({ t: text.slice(p, s), chip: false });
      segs.push({ t: text.slice(s, e), chip: true });
      p = e;
    }
    if (p < b) segs.push({ t: text.slice(p, b), chip: false });
    return segs;
  });
}
