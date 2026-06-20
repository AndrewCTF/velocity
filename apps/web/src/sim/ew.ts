// Electronic-warfare model. Two jammer effects, deliberately distinct because
// they defeat different drones:
//   - comms jamming cuts RF command links (FPV-RF, satcom) — but NOT fiber-optic
//     or preprogrammed one-way-attack drones (nothing to cut).
//   - GNSS jamming denies GPS → GPS/INS drones drift; pure-manual FPV is immune.
// Jammers can be placed by the operator OR pulled live from the app's observed
// GPS-jamming layer (/api/jamming/nacp).

export type JammerKind = 'comms' | 'gnss' | 'both';

export interface Jammer {
  id: string;
  lat: number;
  lon: number;
  radiusKm: number;
  kind: JammerKind;
}

export interface EwEffect {
  commsCut: boolean;
  gnssDenied: boolean;
}

export const NO_EW: EwEffect = { commsCut: false, gnssDenied: false };

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const r = (d: number): number => (d * Math.PI) / 180;
  const dLat = r(bLat - aLat);
  const dLon = r(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Combined EW effect on a point from every jammer in range (logical OR).
export function ewAt(lat: number, lon: number, jammers: readonly Jammer[]): EwEffect {
  let commsCut = false;
  let gnssDenied = false;
  for (const j of jammers) {
    if (haversineKm(lat, lon, j.lat, j.lon) > j.radiusKm) continue;
    if (j.kind === 'comms' || j.kind === 'both') commsCut = true;
    if (j.kind === 'gnss' || j.kind === 'both') gnssDenied = true;
  }
  return { commsCut, gnssDenied };
}
