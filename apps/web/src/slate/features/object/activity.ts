// Detected activity around a selected object: live contacts binned into
// 3.5 km distance bands from the object (the reference copy's computation,
// gotham/_build.py BANDS), plus a baseline from the position archive.

export const BAND_KM = 3.5;
export const BANDS = 8; // 0 to 28 km
/** The first four bands (14 km) are the selection ring the copy colours amber. */
export const RING_BANDS = 4;

export function distKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Query box (minLon,minLat,maxLon,maxLat) that holds the chart's 28 km. */
export function bboxAround(
  lat: number,
  lon: number,
): [number, number, number, number] {
  const km = BAND_KM * BANDS;
  const dLat = km / 110.574;
  const dLon = km / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/** Count of points per band; points beyond the last band are dropped. */
export function bandCounts(
  lat: number,
  lon: number,
  pts: ReadonlyArray<{ lat: number; lon: number }>,
): number[] {
  const out = new Array<number>(BANDS).fill(0);
  for (const p of pts) {
    const i = Math.floor(distKm(lat, lon, p.lat, p.lon) / BAND_KM);
    if (i >= 0 && i < BANDS) out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}

/** Archive tracks as /api/history/tracks returns them: [lon, lat, t, track]. */
export interface ArchiveTrack {
  id: string;
  points: number[][];
}

/** Mean contacts per band per archived hour: for each hour the archive holds
 *  any point in the box, each id counts once at its last fix in that hour.
 *  null when the archive holds nothing here.
 *  shortcut: one scalar for all bands (the copy draws one line); a per-band
 *  baseline would need the archive to hold more than a day here. */
export function hourlyBaseline(
  lat: number,
  lon: number,
  tracks: ReadonlyArray<ArchiveTrack>,
): number | null {
  const hours = new Map<number, Map<string, { lat: number; lon: number }>>();
  for (const tr of tracks) {
    for (const p of tr.points) {
      const [plon, plat, t] = p;
      if (
        typeof plon !== "number" ||
        typeof plat !== "number" ||
        typeof t !== "number"
      )
        continue;
      const h = Math.floor(t / 3600);
      let m = hours.get(h);
      if (!m) hours.set(h, (m = new Map()));
      m.set(tr.id, { lat: plat, lon: plon }); // points are time-ordered: last wins
    }
  }
  if (hours.size === 0) return null;
  let total = 0;
  for (const m of hours.values())
    total += bandCounts(lat, lon, [...m.values()]).reduce((a, b) => a + b, 0);
  return total / hours.size / BANDS;
}

/** Y scale for the 66 px plot: the top tick is a multiple of 3 (labels at
 *  thirds stay whole), never under the copy's 6. */
export function scaleMax(
  counts: readonly number[],
  baseline: number | null,
): number {
  const hi = Math.max(6, ...counts, baseline ?? 0);
  return 3 * Math.ceil(hi / 3);
}
