// Notional Common Operational Picture — illustrative ground laydown for the
// mil.cop.notional layer. NOT real data: a denser, clearly-labelled scenario so
// the MIL-STD-2525 symbology (with echelon + unit designations), FLOT lines, and
// AO range-ring read like an operational COP. SIDC = MIL-STD-2525C 15-char
// (milsymbol frames friend=blue box, hostile=red diamond, neutral=green,
// unknown=yellow; pos-11 echelon → the ticks above the frame). Coordinates are
// an illustrative AO near the Suwałki gap.

export interface CopUnit {
  id: string;
  sidc: string; // 2525C SIDC incl. echelon (pos 11)
  lat: number;
  lon: number;
  designation: string; // uniqueDesignation rendered on the symbol (e.g. '1-66 AR')
  higher?: string; // higherFormation (e.g. '1ABCT')
}
export interface CopLine {
  id: string;
  side: 'friendly' | 'hostile';
  label: string;
  coords: [number, number][]; // [lon, lat] vertices
}
export interface CopRing {
  id: string;
  lat: number;
  lon: number;
  radiusKm: number;
  label: string;
}

export const NOTIONAL_COP: {
  center: { lat: number; lon: number };
  units: CopUnit[];
  lines: CopLine[];
  rings: CopRing[];
} = {
  center: { lat: 54.07, lon: 23.1 },
  units: [
    // ── Friendly (blue) — west of the LD/LC ──────────────────────────────────
    { id: 'f-bct', sidc: 'SFGPUH----H---', lat: 54.21, lon: 22.66, designation: '1 ABCT', higher: '1 AD' },
    { id: 'f-ar', sidc: 'SFGPUCAZ--F---', lat: 54.09, lon: 22.83, designation: '1-66 AR', higher: '1ABCT' },
    { id: 'f-in-a', sidc: 'SFGPUCIZ--E---', lat: 54.0, lon: 22.88, designation: 'A/1-18', higher: '1-18 IN' },
    { id: 'f-in-b', sidc: 'SFGPUCIZ--E---', lat: 53.92, lon: 22.8, designation: 'B/1-18', higher: '1-18 IN' },
    { id: 'f-cav', sidc: 'SFGPUCRVA-E---', lat: 54.15, lon: 22.95, designation: 'D/1-4 CAV', higher: '1ABCT' },
    { id: 'f-fa', sidc: 'SFGPUCFZ--F---', lat: 53.97, lon: 22.62, designation: '4-1 FA', higher: '1ABCT' },
    { id: 'f-ad', sidc: 'SFGPUCDZ--E---', lat: 54.18, lon: 22.74, designation: 'C/5-4 ADA', higher: '1ABCT' },
    { id: 'f-en', sidc: 'SFGPUCEZ--E---', lat: 54.05, lon: 22.7, designation: '588 EN', higher: '1ABCT' },
    { id: 'f-spt', sidc: 'SFGPUSS---F---', lat: 53.88, lon: 22.58, designation: '101 BSB', higher: '1ABCT' },
    // ── Hostile (red) — east of the FLOT ─────────────────────────────────────
    { id: 'h-ca', sidc: 'SHGPUH----I---', lat: 54.27, lon: 23.6, designation: '1 GTA', higher: 'WEST' },
    { id: 'h-tr', sidc: 'SHGPUCAZ--G---', lat: 54.18, lon: 23.42, designation: '6 GMR', higher: '1GTA' },
    { id: 'h-mrb-1', sidc: 'SHGPUCIZ--F---', lat: 54.05, lon: 23.46, designation: '423 MRB', higher: '6GMR' },
    { id: 'h-tb', sidc: 'SHGPUCAZ--F---', lat: 53.96, lon: 23.5, designation: '1/6 TBn', higher: '6GMR' },
    { id: 'h-sam', sidc: 'SHGPUCDZ--E---', lat: 54.3, lon: 23.5, designation: 'SA-22', higher: '1GTA' },
    { id: 'h-arty', sidc: 'SHGPUCFZ--F---', lat: 53.89, lon: 23.55, designation: '2S19 Bn', higher: '6GMR' },
    { id: 'h-recon', sidc: 'SHGPUCRVA-E---', lat: 54.12, lon: 23.28, designation: 'BRM-3', higher: '6GMR' },
    // ── Unknown / neutral contacts (yellow / green) near the FLOT ────────────
    { id: 'u-1', sidc: 'SUGPUCI-------', lat: 54.02, lon: 23.16, designation: 'UNK', higher: '' },
    { id: 'n-1', sidc: 'SNGPUCV-------', lat: 53.94, lon: 23.05, designation: 'CIV CONVOY', higher: '' },
  ],
  lines: [
    {
      id: 'flot-hostile',
      side: 'hostile',
      label: 'FLOT (enemy)',
      coords: [
        [23.24, 54.42],
        [23.18, 54.28],
        [23.22, 54.14],
        [23.16, 54.0],
        [23.24, 53.86],
        [23.2, 53.74],
      ],
    },
    {
      id: 'flot-friendly',
      side: 'friendly',
      label: 'LD/LC',
      coords: [
        [22.99, 54.42],
        [22.94, 54.26],
        [23.02, 54.1],
        [22.93, 53.96],
        [22.99, 53.82],
        [22.95, 53.72],
      ],
    },
  ],
  rings: [{ id: 'ao-falcon', lat: 54.07, lon: 23.1, radiusKm: 42, label: 'AO FALCON' }],
};
