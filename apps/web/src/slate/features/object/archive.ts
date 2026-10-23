// Archive-derived series for the object panels: G22 "Average days underway
// per month" (one hull) and G11 "# Ships detected" per day around a place.
// Inputs are /api/history/track?series=true and /api/history/tracks rows.

import { distKm } from "./activity.js";

const DAY = 86400;

/** UTC days with any fix at >= 1 kn, counted per calendar month, for the
 *  `months` months ending with the one holding `nowMs`. Months the archive
 *  holds no fix for are null (no bar), not zero. */
export function underwayDaysByMonth(
  series: ReadonlyArray<{ t: number; sog?: number | null }>,
  nowMs: number,
  months = 7,
): { label: string; days: number | null }[] {
  const now = new Date(nowMs);
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    keys.push(d.toISOString().slice(0, 7));
  }
  const seen = new Map<string, Set<string>>();
  const moving = new Map<string, Set<string>>();
  for (const s of series) {
    const iso = new Date(s.t * 1000).toISOString();
    const m = iso.slice(0, 7);
    const day = iso.slice(0, 10);
    if (!seen.has(m)) seen.set(m, new Set());
    seen.get(m)!.add(day);
    if ((s.sog ?? 0) >= 1) {
      if (!moving.has(m)) moving.set(m, new Set());
      moving.get(m)!.add(day);
    }
  }
  return keys.map((k) => ({
    label: new Date(`${k}-01T00:00:00Z`).toLocaleString("en", {
      month: "short",
      timeZone: "UTC",
    }),
    days: seen.has(k) ? (moving.get(k)?.size ?? 0) : null,
  }));
}

/** Distinct contacts within `km` of a point per UTC day, oldest first, for
 *  the `days` days ending today. null = the archive holds no fix that day. */
export function dailyContacts(
  tracks: ReadonlyArray<{ id: string; points: number[][] }>,
  lat: number,
  lon: number,
  km: number,
  nowMs: number,
  days = 8,
): { day: string; n: number | null }[] {
  const today = Math.floor(nowMs / 1000 / DAY);
  const any = new Set<number>();
  const per = new Map<number, Set<string>>();
  for (const tr of tracks)
    for (const p of tr.points) {
      const [plon, plat, t] = p;
      if (
        typeof plon !== "number" ||
        typeof plat !== "number" ||
        typeof t !== "number"
      )
        continue;
      const d = Math.floor(t / DAY);
      any.add(d);
      if (distKm(lat, lon, plat, plon) > km) continue;
      if (!per.has(d)) per.set(d, new Set());
      per.get(d)!.add(tr.id);
    }
  const out: { day: string; n: number | null }[] = [];
  for (let d = today - days + 1; d <= today; d++)
    out.push({
      day: new Date(d * DAY * 1000).toISOString().slice(0, 10),
      n: any.has(d) ? (per.get(d)?.size ?? 0) : null,
    });
  return out;
}

/** Mean of the non-null values before the last; null when there are none. */
export function baselineOf(vals: ReadonlyArray<number | null>): number | null {
  const prior = vals.slice(0, -1).filter((v): v is number => v !== null);
  return prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : null;
}
