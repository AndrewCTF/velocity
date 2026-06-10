// Strategic chokepoints — the spatial-intelligence playbook. Each entry is
// a saved AOI with enough metadata to drive a camera fly-to, a status badge,
// and an enrichment line operators can read at a glance.
//
// Bboxes are deliberately tight around the chokepoint waterway/strait, not
// the broader sea, so per-AOI counts reflect the constriction (vessels in
// the funnel) rather than the entire region.

export interface Chokepoint {
  id: string;
  name: string;
  category: 'maritime' | 'aviation' | 'cable' | 'air-corridor';
  region: string;
  bbox: [number, number, number, number]; // [west, south, east, north]
  center: [number, number]; // [lon, lat]
  altKm: number; // camera altitude when flying to
  significance: string; // one-line operator-facing context
  daily_transits?: number; // typical vessel count / day (approx)
  oil_flow_mbpd?: number; // for energy chokepoints (million barrels / day)
}

export const chokepoints: readonly Chokepoint[] = [
  {
    id: 'hormuz',
    name: 'Strait of Hormuz',
    category: 'maritime',
    region: 'Persian Gulf',
    bbox: [55.6, 25.5, 57.4, 27.2],
    center: [56.5, 26.4],
    altKm: 350,
    significance: '~20% of world petroleum liquids transit. IRGC presence; periodic vessel seizures.',
    daily_transits: 60,
    oil_flow_mbpd: 21,
  },
  {
    id: 'bab-el-mandeb',
    name: 'Bab-el-Mandeb',
    category: 'maritime',
    region: 'Red Sea / Gulf of Aden',
    bbox: [42.5, 11.2, 44.2, 13.2],
    center: [43.3, 12.5],
    altKm: 400,
    significance: 'Suez approach. Houthi anti-ship campaigns since 2023; AIS spoofing common.',
    daily_transits: 50,
    oil_flow_mbpd: 6.2,
  },
  {
    id: 'suez',
    name: 'Suez Canal',
    category: 'maritime',
    region: 'Egypt',
    bbox: [32.2, 29.9, 32.7, 31.3],
    center: [32.5, 30.6],
    altKm: 200,
    significance: '12% of global trade. Single-incident blockage (Ever Given, 2021) showed catastrophic fragility.',
    daily_transits: 50,
  },
  {
    id: 'panama',
    name: 'Panama Canal',
    category: 'maritime',
    region: 'Central America',
    bbox: [-80.1, 8.9, -79.4, 9.4],
    center: [-79.7, 9.1],
    altKm: 220,
    significance: '~5% of global trade. Drought-driven transit cuts (2023–24).',
    daily_transits: 35,
  },
  {
    id: 'malacca',
    name: 'Strait of Malacca',
    category: 'maritime',
    region: 'SE Asia',
    bbox: [99.5, 1.0, 104.5, 6.0],
    center: [102, 3.5],
    altKm: 700,
    significance: 'PRC energy lifeline (~80% of crude imports). "Malacca dilemma".',
    daily_transits: 220,
    oil_flow_mbpd: 16,
  },
  {
    id: 'taiwan-strait',
    name: 'Taiwan Strait',
    category: 'maritime',
    region: 'East Asia',
    bbox: [118.0, 22.5, 122.5, 26.5],
    center: [120.0, 24.0],
    altKm: 800,
    significance: 'PLA Navy/Air incursions; semiconductor supply chain vector.',
    daily_transits: 150,
  },
  {
    id: 'korea-strait',
    name: 'Korea Strait',
    category: 'maritime',
    region: 'East Asia',
    bbox: [127.5, 33.5, 130.5, 35.5],
    center: [129.0, 34.5],
    altKm: 600,
    significance: 'ROK/JP merchant traffic + DPRK exclusion zone monitoring.',
    daily_transits: 100,
  },
  {
    id: 'gibraltar',
    name: 'Strait of Gibraltar',
    category: 'maritime',
    region: 'Atlantic / Mediterranean',
    bbox: [-5.8, 35.7, -5.0, 36.2],
    center: [-5.4, 36.0],
    altKm: 200,
    significance: 'Med/Atlantic gate. Russian submarine transits; Spanish/Moroccan jurisdiction friction.',
    daily_transits: 90,
  },
  {
    id: 'bosphorus',
    name: 'Bosphorus / Dardanelles',
    category: 'maritime',
    region: 'Turkish Straits',
    bbox: [26.0, 40.0, 30.0, 41.4],
    center: [28.97, 41.05],
    altKm: 400,
    significance: 'Russian Black Sea Fleet access; Montreux Convention. Grain Initiative corridor.',
    daily_transits: 130,
  },
  {
    id: 'dover',
    name: 'Strait of Dover',
    category: 'maritime',
    region: 'English Channel',
    bbox: [0.8, 50.7, 2.0, 51.4],
    center: [1.4, 51.05],
    altKm: 250,
    significance: 'Densest shipping lane in the world. Channel migrant routes monitored.',
    daily_transits: 500,
  },
  {
    id: 'skagerrak',
    name: 'Skagerrak / Kattegat',
    category: 'maritime',
    region: 'Baltic exit',
    bbox: [8.0, 55.5, 13.0, 58.5],
    center: [10.5, 57.0],
    altKm: 700,
    significance: 'Baltic Fleet exit; NS1/NS2 cable corridors; dark-fleet refueling area.',
    daily_transits: 200,
  },
  {
    id: 'sunda',
    name: 'Sunda Strait',
    category: 'maritime',
    region: 'Indonesia',
    bbox: [104.5, -6.6, 106.3, -5.4],
    center: [105.4, -6.0],
    altKm: 350,
    significance: 'Alternate to Malacca; favored by VLCC re-routes.',
  },
  {
    id: 'lombok',
    name: 'Lombok Strait',
    category: 'maritime',
    region: 'Indonesia',
    bbox: [115.4, -9.0, 116.6, -8.0],
    center: [115.9, -8.5],
    altKm: 300,
    significance: 'Deep-draught alternate Malacca route. PLAN survey activity noted.',
  },
  {
    id: 'bering',
    name: 'Bering Strait',
    category: 'maritime',
    region: 'Arctic',
    bbox: [-172, 64.5, -167, 66.5],
    center: [-169.5, 65.5],
    altKm: 600,
    significance: 'Arctic NSR access. RU/US air defense identification zone friction.',
  },
  {
    id: 'good-hope',
    name: 'Cape of Good Hope',
    category: 'maritime',
    region: 'Southern Africa',
    bbox: [17.0, -36.5, 20.5, -34.0],
    center: [18.5, -34.5],
    altKm: 500,
    significance: 'Suez bypass when Red Sea unsafe. ~+10–14 days transit penalty.',
  },
  {
    id: 'baltic-cables',
    name: 'Baltic submarine-cable belt',
    category: 'cable',
    region: 'Baltic Sea',
    bbox: [12.0, 54.5, 24.0, 60.5],
    center: [18.0, 57.5],
    altKm: 1200,
    significance: 'NS1/2, BalticConnector, C-Lion1. Repeated suspected sabotage events 2023–25.',
  },
  {
    id: 'red-sea-cables',
    name: 'Red Sea cable corridor',
    category: 'cable',
    region: 'Red Sea',
    bbox: [33.0, 12.0, 43.5, 28.0],
    center: [38.0, 20.0],
    altKm: 1500,
    significance: 'SEA-ME-WE 3/4/5, EIG, AAE-1. ~17% of intercontinental traffic.',
  },
] as const;

export type ChokepointId = (typeof chokepoints)[number]['id'];

export function chokepointById(id: string): Chokepoint | undefined {
  return chokepoints.find((c) => c.id === id);
}

export function chokepointsByCategory(cat: Chokepoint['category']): Chokepoint[] {
  return chokepoints.filter((c) => c.category === cat);
}
