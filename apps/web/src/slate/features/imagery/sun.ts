// Solar elevation, NOAA low-precision (good to ~0.1 deg); the formula the
// features copy evaluated for its capture-angle dial (_build_features.sun_elev).

const rad = Math.PI / 180;

export function sunElevationDeg(lat: number, lon: number, tMs: number): number {
  const jd = tMs / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const gmst = ((280.46061837 + 360.98564736629 * n) % 360) * rad;
  const H = gmst + lon * rad - ra;
  const la = lat * rad;
  return (
    Math.asin(
      Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H),
    ) / rad
  );
}

/** Nautical-zone clock (UTC + round(lon / 15) h), "HH:MM". */
export function zoneTime(lon: number, tMs: number): string {
  const d = new Date(tMs + Math.round(lon / 15) * 3600_000);
  return d.toISOString().slice(11, 16);
}
