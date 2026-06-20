// Side-view recognition silhouettes for the entity dossier. These are NOT the
// top-down map icons (globe/icons.ts) — they are profile glyphs shown in the
// panel so an operator gets a visual read on the airframe family even when no
// Planespotters photo exists (GA / military / drones rarely have one).
//
// Family is resolved from the ICAO type designator (e.g. "B738", "EC35",
// "MQ9") with the live category as a fallback. Glyphs are monochrome data
// URIs (one steel tint) so they read as technical schematics, Gotham-style.

function dataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const STEEL = '#c3cee0';

// 120×44, nose to the right. Each family is a few primitives — a recognition
// glyph, not a scale drawing.
function wrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 44" width="120" height="44">${inner}</svg>`;
}

function narrowbody(c: string): string {
  return wrap(`
    <path d="M6 22 L4 9 L13 11 L19 22 Z" fill="${c}"/>
    <path d="M10 24 Q10 19 20 18.5 L98 19 Q112 19.5 117 23 Q112 26 98 26 L20 25.5 Q10 25.5 10 24 Z" fill="${c}"/>
    <path d="M48 25 L34 37 L52 37 L66 25 Z" fill="${c}" opacity="0.92"/>
    <ellipse cx="56" cy="31" rx="7" ry="2.8" fill="${c}"/>
    <circle cx="113" cy="22.5" r="1.4" fill="#0c1017"/>`);
}

function widebody(c: string): string {
  return wrap(`
    <path d="M5 21 L2 5 L14 8 L21 21 Z" fill="${c}"/>
    <path d="M9 25 Q9 17.5 22 16.8 L100 17.5 Q118 18 119 23 Q118 28 100 27.5 L22 27 Q9 27 9 25 Z" fill="${c}"/>
    <path d="M44 27 L26 40 L48 40 L66 27 Z" fill="${c}" opacity="0.92"/>
    <ellipse cx="42" cy="34" rx="8" ry="3.2" fill="${c}"/>
    <ellipse cx="62" cy="32" rx="7" ry="2.9" fill="${c}"/>
    <circle cx="114" cy="22.5" r="1.6" fill="#0c1017"/>`);
}

function turboprop(c: string): string {
  return wrap(`
    <path d="M7 21 L5 8 L14 10 L20 21 Z" fill="${c}"/>
    <path d="M11 24 Q11 19 21 18.5 L99 19.5 Q110 20 114 23.5 Q110 26 99 25.5 L21 25 Q11 25 11 24 Z" fill="${c}"/>
    <rect x="40" y="11" width="34" height="3" rx="1" fill="${c}"/>
    <line x1="48" y1="14" x2="48" y2="19" stroke="${c}" stroke-width="2"/>
    <line x1="66" y1="14" x2="66" y2="19" stroke="${c}" stroke-width="2"/>
    <ellipse cx="48" cy="10" rx="2.4" ry="6" fill="${c}"/>
    <ellipse cx="66" cy="10" rx="2.4" ry="6" fill="${c}"/>`);
}

function lightGa(c: string): string {
  return wrap(`
    <path d="M18 24 Q18 20 28 19.5 L92 20 Q104 20.5 110 23 Q104 25.5 92 25 L28 24.5 Q18 24.5 18 24 Z" fill="${c}"/>
    <rect x="40" y="14" width="32" height="3" rx="1.2" fill="${c}"/>
    <line x1="56" y1="17" x2="56" y2="20" stroke="${c}" stroke-width="2"/>
    <path d="M96 21 L94 13 L101 15 L104 22 Z" fill="${c}"/>
    <ellipse cx="110" cy="22.5" rx="2.2" ry="5" fill="${c}"/>`);
}

function helicopter(c: string): string {
  return wrap(`
    <rect x="20" y="9" width="74" height="2.6" rx="1.3" fill="${c}"/>
    <line x1="56" y1="11.6" x2="56" y2="16" stroke="${c}" stroke-width="2"/>
    <path d="M30 28 Q30 18 50 17 L70 17 Q80 18 82 23 L110 25 L112 27 L80 28 Q60 30 40 29 Q30 29 30 28 Z" fill="${c}"/>
    <path d="M108 21 L114 19 L114 31 L108 29 Z" fill="${c}"/>
    <line x1="113" y1="18" x2="113" y2="32" stroke="${c}" stroke-width="1.6"/>`);
}

function fighter(c: string): string {
  return wrap(`
    <path d="M4 23 L2 12 L11 15 L17 23 Z" fill="${c}"/>
    <path d="M8 24 L26 22 L118 23 L118 25 L26 26 L8 25 Z" fill="${c}"/>
    <path d="M40 25 L24 35 L60 35 L72 25 Z" fill="${c}" opacity="0.92"/>
    <path d="M14 23 L10 19 L20 21 Z" fill="${c}"/>`);
}

function drone(c: string): string {
  return wrap(`
    <rect x="34" y="11" width="58" height="2.4" rx="1.2" fill="${c}"/>
    <path d="M14 23 Q14 20 22 19.5 L96 20.5 Q108 21 112 23 Q108 25 96 24.5 L22 24 Q14 24 14 23 Z" fill="${c}"/>
    <ellipse cx="14" cy="22.5" rx="6" ry="3.4" fill="${c}"/>
    <path d="M100 24 L108 33 L104 24 Z" fill="${c}"/>
    <path d="M100 23 L108 14 L104 23 Z" fill="${c}"/>`);
}

function glider(c: string): string {
  return wrap(`
    <path d="M9 22 L6 11 L13 13 L18 22 Z" fill="${c}"/>
    <path d="M12 23 Q12 20.5 24 20 L104 21 Q113 21.5 116 23 Q113 24.5 104 24 L24 23.5 Q12 23.5 12 23 Z" fill="${c}"/>
    <rect x="34" y="16" width="56" height="2" rx="1" fill="${c}"/>`);
}

function ship(c: string): string {
  return wrap(`
    <path d="M6 28 L114 28 L106 36 L14 36 Z" fill="${c}"/>
    <rect x="40" y="20" width="34" height="8" fill="${c}"/>
    <rect x="46" y="14" width="14" height="6" fill="${c}"/>
    <line x1="53" y1="6" x2="53" y2="14" stroke="${c}" stroke-width="1.4"/>`);
}

export type AirframeFamily =
  | 'widebody'
  | 'narrowbody'
  | 'turboprop'
  | 'lightGa'
  | 'helicopter'
  | 'fighter'
  | 'drone'
  | 'glider';

const FAMILY_SVG: Record<AirframeFamily, (c: string) => string> = {
  widebody,
  narrowbody,
  turboprop,
  lightGa,
  helicopter,
  fighter,
  drone,
  glider,
};

// Prefix tables — checked longest-first inside resolveAircraftFamily. Sourced
// from common ICAO type designators; intentionally coarse (family, not type).
const WIDEBODY = ['A30', 'A31', 'A33', 'A34', 'A35', 'A38', 'B74', 'B76', 'B77', 'B78', 'MD11', 'IL96', 'IL86', 'A124', 'AN12', 'C5', 'C17'];
const NARROWBODY = ['A19', 'A20', 'A21', 'A22', 'BCS', 'B71', 'B72', 'B73', 'B75', 'MD8', 'MD9', 'DC9', 'E190', 'E195', 'E170', 'E175', 'SU95', 'B37', 'C919'];
const TURBOPROP = ['AT4', 'AT5', 'AT7', 'DH8', 'DHC', 'SF34', 'SB20', 'JS', 'BE20', 'BE9', 'C208', 'PC12', 'TBM', 'AN24', 'AN26', 'L410', 'D328'];
const HELI = ['EC', 'H1', 'H2', 'H5', 'H6', 'AS3', 'AS35', 'AS50', 'AS65', 'R22', 'R44', 'R66', 'B06', 'B47', 'S76', 'S92', 'S70', 'AW1', 'AW3', 'UH', 'CH', 'MI', 'KA', 'EH'];
const FIGHTER = ['F15', 'F16', 'F18', 'F22', 'F35', 'F4', 'F5', 'F14', 'EUFI', 'RAFL', 'TOR', 'GR4', 'MIG', 'SU2', 'SU3', 'SU5', 'A10', 'AV8', 'JAS', 'J10', 'J20', 'FA50', 'T38'];
const DRONE = ['MQ', 'RQ', 'TB2', 'GH', 'UAV', 'SHAH'];
const GLIDER = ['GLID', 'AS2', 'DG', 'LS', 'DUO', 'ASK', 'ASW', 'STD'];

function matchPrefix(code: string, table: readonly string[]): boolean {
  return table.some((p) => code.startsWith(p));
}

/**
 * Resolve an airframe family from the ICAO type designator (preferred) with the
 * live entity category as a fallback. Returns null when nothing is known so the
 * caller can omit the silhouette rather than show a misleading one.
 */
export function resolveAircraftFamily(
  typeCode?: string | null,
  category?: string | null,
): AirframeFamily | null {
  const code = (typeCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code) {
    if (matchPrefix(code, DRONE)) return 'drone';
    if (matchPrefix(code, FIGHTER)) return 'fighter';
    if (matchPrefix(code, WIDEBODY)) return 'widebody';
    if (matchPrefix(code, NARROWBODY)) return 'narrowbody';
    if (matchPrefix(code, TURBOPROP)) return 'turboprop';
    if (matchPrefix(code, HELI)) return 'helicopter';
    if (matchPrefix(code, GLIDER)) return 'glider';
    // Single-letter GA families (Cessna C*, Piper PA*/P28*, Beech BE*, etc.)
    if (/^(C1|C2|C3|C4|P2|P3|PA|BE|SR2|DA[24]|DV|M20|RV|G1|G2)/.test(code)) return 'lightGa';
  }
  // ADS-B emitter category code (A1–A7, B1/B4) when no type designator matched.
  const cat = (category ?? '').toUpperCase();
  switch (cat) {
    case 'A1':
      return 'lightGa';
    case 'A2':
      return 'turboprop';
    case 'A3':
    case 'A4':
      return 'narrowbody';
    case 'A5':
      return 'widebody';
    case 'A6':
      return 'fighter';
    case 'A7':
      return 'helicopter';
    case 'B1':
      return 'glider';
    case 'B4':
    case 'B6':
      return 'drone';
  }
  switch (category) {
    case 'airliner':
      return 'narrowbody';
    case 'military':
      return 'fighter';
    case 'helicopter':
      return 'helicopter';
    case 'glider':
      return 'glider';
    case 'private':
      return 'lightGa';
    default:
      return null;
  }
}

const _cache = new Map<string, string>();

/** Data-URI side-view silhouette for an airframe family. */
export function aircraftSilhouette(family: AirframeFamily, color = STEEL): string {
  const key = `${family}:${color}`;
  let v = _cache.get(key);
  if (!v) {
    v = dataUri(FAMILY_SVG[family](color));
    _cache.set(key, v);
  }
  return v;
}

/** Data-URI side-view silhouette for a vessel (generic profile). */
export function vesselSilhouette(color = STEEL): string {
  const key = `ship:${color}`;
  let v = _cache.get(key);
  if (!v) {
    v = dataUri(ship(color));
    _cache.set(key, v);
  }
  return v;
}
