// First-order economic-impact estimate for a strike location. Seeded with the
// handful of maritime chokepoints whose disruption has well-documented global
// effects; everything is a coarse public-figure heuristic that the AI reasoning
// layer refines. Labelled as estimates in the UI.

export interface Chokepoint {
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
  /** share of global seaborne oil that transits here (%) */
  oilPctGlobal: number;
  /** share of global trade that transits here (%) */
  tradePctGlobal: number;
  note: string;
}

// Commonly-cited public shares (EIA / UNCTAD / press). Approximate.
export const CHOKEPOINTS: Chokepoint[] = [
  { name: 'Strait of Hormuz', lat: 26.57, lon: 56.25, radiusKm: 250, oilPctGlobal: 20, tradePctGlobal: 5, note: '~20% of global oil; no easy bypass.' },
  { name: 'Suez Canal', lat: 30.0, lon: 32.35, radiusKm: 200, oilPctGlobal: 9, tradePctGlobal: 12, note: '~12% of global trade; reroute adds ~10 days via Cape.' },
  { name: 'Strait of Malacca', lat: 1.43, lon: 102.9, radiusKm: 300, oilPctGlobal: 16, tradePctGlobal: 25, note: 'Primary Asia–Mideast artery.' },
  { name: 'Bab-el-Mandeb', lat: 12.6, lon: 43.4, radiusKm: 200, oilPctGlobal: 9, tradePctGlobal: 10, note: 'Red Sea gateway; Houthi-threatened.' },
  { name: 'Turkish Straits', lat: 41.1, lon: 29.07, radiusKm: 150, oilPctGlobal: 3, tradePctGlobal: 3, note: 'Black Sea grain & oil outlet.' },
  { name: 'Panama Canal', lat: 9.08, lon: -79.68, radiusKm: 150, oilPctGlobal: 2, tradePctGlobal: 5, note: 'US–Asia container & LNG route.' },
];

export interface EconImpact {
  nearestChokepoint: string | null;
  distanceKm: number | null;
  /** estimated crude-oil spot price shock, % */
  oilPriceShockPct: number;
  /** estimated trade flow disrupted, USD per day */
  tradeDisruptedUsdPerDay: number;
  intensity: number; // 0..1
  summary: string;
}

// Global seaborne trade ≈ $24T/yr ≈ $66B/day (UNCTAD order-of-magnitude).
const GLOBAL_TRADE_USD_PER_DAY = 66e9;

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const r = (d: number): number => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLon = r(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// damageUnits = expected successful strikes (from combat.resolveRaid). Intensity
// scales with damage but saturates — a chokepoint can only be "closed" once.
export function economicImpact(target: { lat: number; lon: number }, damageUnits: number): EconImpact {
  let nearest: Chokepoint | null = null;
  let best = Infinity;
  for (const c of CHOKEPOINTS) {
    const d = haversineKm(target, c);
    if (d < best) {
      best = d;
      nearest = c;
    }
  }
  const intensity = 1 - Math.exp(-Math.max(0, damageUnits) / 6); // saturating 0..1

  if (!nearest || best > nearest.radiusKm) {
    // Away from a global chokepoint — localised impact only.
    const oil = round1(intensity * 1.5);
    return {
      nearestChokepoint: nearest ? nearest.name : null,
      distanceKm: nearest ? Math.round(best) : null,
      oilPriceShockPct: oil,
      tradeDisruptedUsdPerDay: Math.round(intensity * 2e9),
      intensity: round2(intensity),
      summary: `No major chokepoint within range — impact is regional. Est. oil +${oil}%.`,
    };
  }

  const oilShock = round1(nearest.oilPctGlobal * intensity * 0.9);
  const trade = Math.round(GLOBAL_TRADE_USD_PER_DAY * (nearest.tradePctGlobal / 100) * intensity);
  return {
    nearestChokepoint: nearest.name,
    distanceKm: Math.round(best),
    oilPriceShockPct: oilShock,
    tradeDisruptedUsdPerDay: trade,
    intensity: round2(intensity),
    summary: `${nearest.name}: ${nearest.note} Est. oil +${oilShock}%, ~$${(trade / 1e9).toFixed(1)}B/day trade disrupted.`,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
