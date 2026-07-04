// Great-circle geometry for the route-projection overlay (decision support).
// Pure functions — no Cesium, unit-testable (see projection.test.ts).
//
// IMPORTANT: this computes a REACHABLE AREA from a last fix + speed. It is NOT
// observed motion and must never be written to a track / the live icon — it is a
// clearly-labelled "where could it be by +Nh" overlay only.

const R_KM = 6371.0088;
const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

export const KN_TO_KMH = 1.852;

// Destination point travelling `distKm` along a `bearingDeg` great circle.
export function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distKm: number,
): { lat: number; lon: number } {
  const d = distKm / R_KM;
  const th = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lam1 = toRad(lon);
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(th),
  );
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(th) * Math.sin(d) * Math.cos(phi1),
      Math.cos(d) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { lat: toDeg(phi2), lon: ((toDeg(lam2) + 540) % 360) - 180 };
}

// Great-circle distance between two points (km).
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dphi = toRad(bLat - aLat);
  const dlam = toRad(bLon - aLon);
  const phi1 = toRad(aLat);
  const phi2 = toRad(bLat);
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}

// A reachable ring of radius `radiusKm` around (lat,lon), as a flat
// [lon,lat,lon,lat,…] array ready for Cesium.Cartesian3.fromDegreesArray.
export function reachableRing(lat: number, lon: number, radiusKm: number, n = 96): number[] {
  const flat: number[] = [];
  for (let i = 0; i <= n; i++) {
    const b = (i / n) * 360;
    const p = destinationPoint(lat, lon, b, radiusKm);
    flat.push(p.lon, p.lat);
  }
  return flat;
}
