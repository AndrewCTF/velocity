import * as Cesium from 'cesium';
import { icons, cachedIcon } from '../icons.js';

// Token colors loaded at runtime from CSS variables so the chrome stays
// in sync with theme. Cesium needs them as Cesium.Color instances.
function cssColor(name: string, fallback: string): Cesium.Color {
  if (typeof window === 'undefined') return Cesium.Color.fromCssColorString(fallback);
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return Cesium.Color.fromCssColorString(v || fallback);
}

export const colors = {
  accent: () => cssColor('--accent', '#2dd4bf'),
  warn: () => cssColor('--warn', '#f59e0b'),
  alert: () => cssColor('--alert', '#ef4444'),
  ok: () => cssColor('--ok', '#34d399'),
  txt0: () => cssColor('--txt-0', '#e6edf3'),
  txt2: () => cssColor('--txt-2', '#8b98a8'),
  txt3: () => cssColor('--txt-3', '#5f6b7a'),
};

const HEX_ACCENT = '#2dd4bf';
const HEX_WARN = '#f59e0b';
const HEX_ALERT = '#ef4444';
const HEX_OK = '#34d399';
const HEX_TXT2 = '#8b98a8';

// Flightradar24-style aircraft category palette
const HEX_AIRLINER = '#facc15';   // flightradar accent yellow
const HEX_PRIVATE = '#2dd4bf';    // cyan for light/private
const HEX_HELI = '#c084fc';       // magenta for rotorcraft
const HEX_GLIDER = '#93c5fd';     // pale blue for sailplanes
const HEX_MIL = '#f59e0b';        // orange for military

// AIS / ITU-R M.1371 ship-type palette. Each color is chosen so categories
// stay legible against a dark globe and distinct from the aircraft palette.
const HEX_VES_CARGO = '#14b8a6';      // gray-green for cargo
const HEX_VES_TANKER = '#d97706';     // amber for tankers (fuel/chem hazard)
const HEX_VES_FISHING = '#5eead4';    // teal for fishing
const HEX_VES_PASSENGER = '#38bdf8';  // ocean blue for passenger ferries
const HEX_VES_MIL = '#f59e0b';        // orange — same as mil aircraft
const HEX_VES_SAILING = '#a5f3fc';    // pale-cyan for sailing
const HEX_VES_PLEASURE = '#4ade80';   // light-green for pleasure craft
const HEX_VES_TUG = '#c084fc';        // violet for tugs / service
const HEX_VES_SAR = '#ef4444';        // red — search & rescue

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

// ADS-B Mode S "category" codes (airplanes.live / adsb.lol /v2/point payloads):
//   A1 light, A2 small, A3 large, A4 high-vortex large, A5 heavy,
//   A6 high-performance, A7 rotorcraft,
//   B1 glider/sailplane, B2 light free balloon, B4 ultralight.
type AircraftKind = 'airliner' | 'private' | 'helicopter' | 'glider' | 'military' | 'emergency';

// ── Quakes ────────────────────────────────────────────────────────────────
export function quakeStyle(mag: number | null): { color: Cesium.Color; pixelSize: number } {
  const m = mag ?? 0;
  let color = colors.txt2();
  if (m >= 5) color = colors.alert();
  else if (m >= 3) color = colors.warn();
  else if (m > 0) color = colors.ok();
  return { color, pixelSize: Math.max(4, Math.min(20, 3 + m * 2)) };
}

// ── Aircraft ──────────────────────────────────────────────────────────────
export interface AircraftStyle {
  imageUri: string;
  rotationRad: number;
  scale: number;
  color: Cesium.Color;
  emergency: boolean;
  kind: AircraftKind;
}

export function aircraftStyle(props: Record<string, unknown>): AircraftStyle {
  const trackDeg = (props['track_deg'] as number | null) ?? null;
  const squawk = (props['squawk'] as string | null) ?? null;
  const callsign = (props['callsign'] as string | null) ?? null;
  const source = (props['source'] as string | null) ?? null;
  const category = (props['category'] as string | null) ?? null;

  // Coerce squawk to string before set lookup: upstream feeds frequently send
  // the integer 7700 rather than the string "7700", and `Set.has(7700)` returns
  // false even though the value is logically present. Falsy guard with `!= null`
  // (not `!!`) so the integer 0 — which couldn't be a real squawk anyway —
  // wouldn't accidentally short-circuit if it ever appeared.
  const emergSquawk = squawk != null && EMERGENCY_SQUAWKS.has(String(squawk));
  // readsb also carries an `emergency` field (general/lifeguard/minfuel/nordo/
  // unlawful/downed) — a real emergency can be declared WITHOUT a 7500/7600/7700
  // squawk, so those aircraft were never turning red. Treat any non-empty,
  // non-"none" value as an emergency too.
  const emergFlag = (() => {
    const e = props['emergency'];
    if (typeof e === 'boolean') return e;
    if (typeof e === 'string') {
      const v = e.trim().toLowerCase();
      return v !== '' && v !== 'none' && v !== 'no';
    }
    return false;
  })();
  const emergency = emergSquawk || emergFlag;
  const military =
    isMilitaryCallsign(callsign) || source === 'adsb_mil' || source === 'airplanes_live';

  // Priority: emergency → military → ADS-B category → default airliner.
  // Each branch picks (icon, color, scale) together so the FR24-like
  // category map stays consistent.
  let kind: AircraftKind;
  let hex: string;
  let scale: number;
  let imageUri: string;

  if (emergency) {
    kind = 'emergency';
    hex = HEX_ALERT;
    scale = 1.4;
    // Reuse the airliner silhouette tinted red; pulse handled by adapter.
    imageUri = cachedIcon(`aircraft:${hex}`, () => icons.aircraft(hex));
  } else if (military) {
    kind = 'military';
    hex = HEX_MIL;
    scale = 1.2;
    imageUri = cachedIcon(`aircraft:${hex}`, () => icons.aircraft(hex));
  } else if (category === 'A7' || category === 'A6') {
    kind = 'helicopter';
    hex = HEX_HELI;
    scale = 0.9;
    imageUri = cachedIcon(`heli:${hex}`, () => icons.helicopter(hex));
  } else if (category === 'B1') {
    kind = 'glider';
    hex = HEX_GLIDER;
    scale = 1.0;
    imageUri = cachedIcon(`glider:${hex}`, () => icons.glider(hex));
  } else if (category === 'A1' || category === 'A2') {
    kind = 'private';
    hex = HEX_PRIVATE;
    scale = 1.0;
    imageUri = cachedIcon(`private:${hex}`, () => icons.privateAircraft(hex));
  } else {
    // A3/A4/A5 large jets, plus anything without a category (OpenSky etc.).
    kind = 'airliner';
    hex = HEX_AIRLINER;
    scale = 1.1;
    imageUri = cachedIcon(`aircraft:${hex}`, () => icons.aircraft(hex));
  }

  // Sacred invariant (CLAUDE.md): every aircraft renders as an SVG icon,
  // never a bare Cesium point. If the icon factory above returned an empty
  // string for any reason — corrupt cache, future regression — fall back to
  // the generic yellow airliner so we still paint a billboard. Letting an
  // empty imageUri through would make Cesium silently fall back to a default
  // point primitive (the "blue dot" the operator complained about).
  if (!imageUri) {
    imageUri = cachedIcon(`aircraft:${HEX_AIRLINER}`, () => icons.aircraft(HEX_AIRLINER));
  }

  const rotationRad = trackDeg == null ? 0 : -Cesium.Math.toRadians(trackDeg);
  const color = Cesium.Color.fromCssColorString(hex);
  return { imageUri, rotationRad, scale, color, emergency, kind };
}

export function isMilitaryCallsign(cs: string | null): boolean {
  if (!cs) return false;
  // Common military callsign prefixes (heuristic). Removed prefixes that
  // collide with real civilian operators:
  //   RFR   → Ryanair (NOT military)
  //   ZZ    → too generic; matched many civilian ferry callsigns
  //   DERBY → also a UK regional airline historically
  //   EAGLE → American Eagle (commercial)
  //   HAWK  → used by multiple civilian charter operators
  return /^(RCH|REACH|SAM|DUKE|GORDO|BISON|MAGMA|SCAR|PAT|SLAM|KING|EBONY|CONVOY|NAVY|GAF|ASCOT|CHAOS|TITAN|VOODOO|MAKO|TREK|TANGO|VENOM|VIPER|HOMR|RAPTR)\d/i.test(cs);
}

// ── Vessels ───────────────────────────────────────────────────────────────
// ITU-R M.1371 §3.1.1 ship type categorization. We collapse the 0-99 ITU
// space into a smaller render-relevant set so the operator gets useful
// at-a-glance distinctions (tanker vs cargo vs fishing) without an
// overwhelming legend.
export type VesselKind =
  | 'cargo'
  | 'tanker'
  | 'fishing'
  | 'passenger'
  | 'military'
  | 'sailing'
  | 'pleasure'
  | 'tug'
  | 'sar'
  | 'generic';

export interface VesselStyle {
  imageUri: string;
  rotationRad: number;
  scale: number;
  color: Cesium.Color;
  dark: boolean;
  kind: VesselKind;
}

// Map raw ITU-R M.1371 ship type code (0-99) to a render kind.
// Reference: ITU-R M.1371-5 §3.1.1, Annex 8 Table 50.
function classifyShipType(code: number | null): VesselKind {
  if (code == null) return 'generic';
  // Special handheld categories first.
  if (code === 30) return 'fishing';
  if (code === 31 || code === 32 || code === 52) return 'tug';
  if (code === 35) return 'military';
  if (code === 36) return 'sailing';
  if (code === 37) return 'pleasure';
  // 40-49: High-Speed Craft (HSC), nearly all passenger ferries in practice
  // (HSC carrying cargo is rare; the category is dominated by fast ferries).
  if (code >= 40 && code <= 49) return 'passenger';
  // 50 = Pilot Vessel, 53 = Port Tender — both render best as tug-class
  // service vessels alongside the existing 31/32/52 tugs.
  if (code === 50 || code === 53) return 'tug';
  if (code === 51) return 'sar';
  // 55 = Law Enforcement Vessel (coast guard, customs cutters) — bucket
  // with military so it picks the orange MIL silhouette and reads as
  // "armed state asset" at a glance.
  if (code === 55) return 'military';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 80 && code <= 89) return 'tanker';
  return 'generic';
}

function pickVesselVisual(kind: VesselKind): { hex: string; iconKey: string; factory: (h: string) => string; scale: number } {
  switch (kind) {
    case 'cargo':
      return { hex: HEX_VES_CARGO, iconKey: 'cargo', factory: icons.cargoShip, scale: 1.0 };
    case 'tanker':
      return { hex: HEX_VES_TANKER, iconKey: 'tanker', factory: icons.tanker, scale: 1.05 };
    case 'fishing':
      return { hex: HEX_VES_FISHING, iconKey: 'fishing', factory: icons.fishing, scale: 0.85 };
    case 'passenger':
      return { hex: HEX_VES_PASSENGER, iconKey: 'passenger', factory: icons.vessel, scale: 1.0 };
    case 'military':
      return { hex: HEX_VES_MIL, iconKey: 'vessel-mil', factory: icons.vessel, scale: 1.1 };
    case 'sailing':
      return { hex: HEX_VES_SAILING, iconKey: 'sailing', factory: icons.pleasureCraft, scale: 0.85 };
    case 'pleasure':
      return { hex: HEX_VES_PLEASURE, iconKey: 'pleasure', factory: icons.pleasureCraft, scale: 0.85 };
    case 'tug':
      return { hex: HEX_VES_TUG, iconKey: 'tug', factory: icons.vessel, scale: 0.9 };
    case 'sar':
      return { hex: HEX_VES_SAR, iconKey: 'sar', factory: icons.vessel, scale: 1.1 };
    default:
      return { hex: HEX_OK, iconKey: 'vessel', factory: icons.vessel, scale: 0.95 };
  }
}

export function vesselStyle(props: Record<string, unknown>, opts: { darkCandidate?: boolean } = {}): VesselStyle {
  const cog = (props['cog'] as number | null) ?? (props['heading'] as number | null) ?? null;
  const sog = (props['sog'] as number | null) ?? null;
  // Dark-vessel flag comes either from the in-process AIS-gap tracker (opts) or,
  // for the Sentinel-1 SAR layer, straight off the feature (darkCandidate is
  // true when a SAR target has no nearby AIS contact; null = AIS unknown).
  const dark = opts.darkCandidate ?? props['darkCandidate'] === true;

  // Read ITU ship-type code from any of the casings the upstream feeds use.
  const rawShipType =
    (props['shipType'] as number | string | null | undefined) ??
    (props['ship_type'] as number | string | null | undefined) ??
    (props['shiptype'] as number | string | null | undefined) ??
    null;
  let shipTypeNum: number | null = null;
  if (typeof rawShipType === 'number' && Number.isFinite(rawShipType)) {
    shipTypeNum = rawShipType;
  } else if (typeof rawShipType === 'string' && rawShipType.trim() !== '') {
    const parsed = Number.parseInt(rawShipType, 10);
    if (Number.isFinite(parsed)) shipTypeNum = parsed;
  }
  const kind: VesselKind = classifyShipType(shipTypeNum);
  const visual = pickVesselVisual(kind);

  // Dark-vessel override: alert red diamond regardless of category. Movement
  // anomalies (anchored / unusually fast) only color-shift when we don't have
  // a more informative category — once we know it's a tanker, keep it amber.
  let hex = visual.hex;
  let imageUri: string;
  let scale = visual.scale;
  if (dark) {
    hex = HEX_ALERT;
    imageUri = cachedIcon(`vessel:dark:${hex}`, () => icons.darkVessel(hex));
    scale = 1.25;
  } else {
    if (kind === 'generic') {
      if (sog != null && sog < 0.5) hex = HEX_TXT2; // anchored / drifting
      else if (sog != null && sog > 25) hex = HEX_WARN; // unusually fast
    }
    imageUri = cachedIcon(`vessel:${visual.iconKey}:${hex}`, () => visual.factory(hex));
  }

  // Same sacred invariant as aircraft: vessels MUST render as an SVG icon,
  // never as Cesium's default point. Fall back to the generic vessel
  // silhouette in OK-green if the chosen factory somehow returned empty.
  if (!imageUri) {
    imageUri = cachedIcon(`vessel:generic:${HEX_OK}`, () => icons.vessel(HEX_OK));
  }

  const rotationRad = cog == null ? 0 : -Cesium.Math.toRadians(cog);
  // Close-up scale stays operator-readable. Low-zoom crowding is handled by
  // Cesium EntityCluster on the data source + the distanceDisplayCondition
  // fade in PollGeoJsonAdapter — not by shrinking the close-up icon.
  return {
    imageUri,
    rotationRad,
    scale,
    color: Cesium.Color.fromCssColorString(hex),
    dark,
    kind,
  };
}

// ── Fires ─────────────────────────────────────────────────────────────────
export function fireStyle(props: Record<string, unknown>): { imageUri: string; scale: number } {
  const frp = (props['frp'] as number | null) ?? null;
  const conf = String(props['confidence'] ?? '').toLowerCase();
  let hex = HEX_WARN;
  if (frp != null && frp > 50) hex = HEX_ALERT;
  else if (conf === 'high') hex = HEX_ALERT;
  const key = `fire:${hex}`;
  return { imageUri: cachedIcon(key, () => icons.fire(hex)), scale: 0.9 };
}

// ── GPS Jamming (polygon variant) ─────────────────────────────────────────
// Returns fill/outline colors and alpha for a Cesium polygon entity. Separate
// from the legacy point-based jammingStyle so callers can choose the render
// primitive without mixing concerns. The point helper is kept for fallback.
export function jammingPolygonStyle(props: Record<string, unknown>): {
  fillColor: string;
  outlineColor: string;
  alpha: number;
} {
  const severity = (props['severity'] as string | undefined) ?? 'low';
  // low/medium → warn amber, high → alert red (mirrors point style).
  const hex = severity === 'high' ? HEX_ALERT : HEX_WARN;
  // Alpha: low=0.2, medium=0.35, high=0.55 — enough fill to read the area
  // without obscuring the terrain underneath.
  const alpha = severity === 'high' ? 0.55 : severity === 'medium' ? 0.35 : 0.2;
  return { fillColor: hex, outlineColor: hex, alpha };
}

// ── Satellites ────────────────────────────────────────────────────────────
export function satelliteStyle(): { imageUri: string; scale: number; color: Cesium.Color } {
  const key = `sat:${HEX_ACCENT}`;
  return {
    imageUri: cachedIcon(key, () => icons.satellite(HEX_ACCENT)),
    scale: 0.7,
    color: Cesium.Color.fromCssColorString(HEX_ACCENT),
  };
}

// ── CCTV cams ─────────────────────────────────────────────────────────────
// Public webcams — neutral slate so they read as infrastructure, not as a
// contact. Static points: no rotation, no per-poll restyle.
const HEX_CAMERA = '#e2e8f0';
export function cameraStyle(): { imageUri: string; scale: number } {
  return {
    imageUri: cachedIcon(`camera:${HEX_CAMERA}`, () => icons.camera(HEX_CAMERA)),
    scale: 1.0,
  };
}

// ── Airports / Ports (FR24-style reference markers) ─────────────────────────
// Fixed infrastructure markers, NOT live contacts: a filled rounded tile with a
// high-contrast glyph so they read as place pins on the dark basemap and never
// get mistaken for an aircraft (yellow) or a vessel (teal arrow). Built inline
// here (mirroring eventIcons.ts) rather than via icons.ts so the whole marker
// lives with its style — same `data:image/svg+xml;utf8,${encodeURIComponent}`
// data-uri pattern as icons.ts. Orientation-agnostic — never rotated. Zoom-gated
// to appear only when zoomed in (LayerCompositor placesBboxQuery + billboard DDC).
function placeDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const PLACE_OUT = '#05070b'; // dark outline halo (matches label pill background)

// FR24-style airport tile: rounded slate square + an upright airplane glyph.
// Large hubs get a brighter tile + bigger scale than medium fields, so the map
// reads primary vs secondary airports at a glance. The slate/blue hue keeps a
// static airport visually apart from a live yellow aircraft.
function airportSvg(large: boolean): string {
  const tile = large ? '#e2e8f0' : '#94a3b8'; // slate-200 hub / slate-400 field
  const glyph = large ? '#1e3a8a' : '#1e293b'; // blue-900 / slate-800 plane
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="${tile}" stroke="${PLACE_OUT}" stroke-width="1.4"/>
    <path d="M12 4.6 L12.9 11 L18 13 L18 14.3 L12.9 13.1 L12.9 16.7 L14.3 17.6 L14.3 18.7 L12 18 L9.7 18.7 L9.7 17.6 L11.1 16.7 L11.1 13.1 L6 14.3 L6 13 L11.1 11 Z"
      fill="${glyph}" stroke="${PLACE_OUT}" stroke-width="0.5" stroke-linejoin="round"/>
  </svg>`;
}

export function airportStyle(props: Record<string, unknown>): { imageUri: string; scale: number } {
  const large = String(props['atype'] ?? '').toLowerCase() === 'large';
  const key = `airport:${large ? 'lg' : 'md'}`;
  return {
    imageUri: cachedIcon(key, () => placeDataUri(airportSvg(large))),
    scale: large ? 1.0 : 0.8,
  };
}

// FR24/marine-style port tile: teal rounded square + a white anchor. Teal echoes
// the vessel palette (so it reads "maritime") but the square tile + anchor make
// it clearly a fixed berth, not a moving vessel arrow.
function portSvg(): string {
  const tile = '#0d9488'; // teal-600
  const glyph = '#f0fdfa'; // near-white anchor
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="${tile}" stroke="${PLACE_OUT}" stroke-width="1.4"/>
    <circle cx="12" cy="5.9" r="1.8" fill="none" stroke="${glyph}" stroke-width="1.5"/>
    <line x1="12" y1="7.6" x2="12" y2="18.4" stroke="${glyph}" stroke-width="1.6" stroke-linecap="round"/>
    <line x1="8.4" y1="10" x2="15.6" y2="10" stroke="${glyph}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M6 13.4 C6 16.8 8.9 18.6 12 18.6 C15.1 18.6 18 16.8 18 13.4" fill="none" stroke="${glyph}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M6 13.4 L4.4 13.9 L5.6 15.2 Z" fill="${glyph}"/>
    <path d="M18 13.4 L19.6 13.9 L18.4 15.2 Z" fill="${glyph}"/>
  </svg>`;
}

export function portStyle(): { imageUri: string; scale: number } {
  return {
    imageUri: cachedIcon('port', () => placeDataUri(portSvg())),
    scale: 0.95,
  };
}

// ── TFR / airspace restriction polygons ──────────────────────────────────
// Semi-transparent fill colored by the FAA `type` (reason) field, solid
// outline in the same hue so a busy map still reads which restriction class
// a shape belongs to at a glance. Unknown/unclassified types fall back to a
// neutral gray rather than guessing a reason.
const HEX_TFR_SECURITY = '#ef4444';   // SECURITY / VIP / Presidential — alert red
const HEX_TFR_HAZARD = '#f59e0b';     // HAZARDS (fire, disaster) — warn amber
const HEX_TFR_SHOW = '#38bdf8';       // AIR SHOWS / SPORTS — sky blue
const HEX_TFR_SPACE = '#a78bfa';      // SPACE OPERATIONS — violet
const HEX_TFR_UAS = '#2dd4bf';        // UAS / PUBLIC GATHERING — teal
const HEX_TFR_DEFAULT = '#8b98a8';    // everything else — neutral gray

export function tfrPolygonStyle(props: Record<string, unknown>): {
  fillColor: string;
  outlineColor: string;
  alpha: number;
} {
  const type = String(props['type'] ?? '').toUpperCase();
  let hex = HEX_TFR_DEFAULT;
  if (type.includes('SECURITY') || type.includes('VIP') || type.includes('PRESIDENT')) {
    hex = HEX_TFR_SECURITY;
  } else if (type.includes('HAZARD')) {
    hex = HEX_TFR_HAZARD;
  } else if (type.includes('AIR SHOW') || type.includes('SPORT')) {
    hex = HEX_TFR_SHOW;
  } else if (type.includes('SPACE')) {
    hex = HEX_TFR_SPACE;
  } else if (type.includes('UAS') || type.includes('PUBLIC GATHERING')) {
    hex = HEX_TFR_UAS;
  }
  return { fillColor: hex, outlineColor: hex, alpha: 0.28 };
}

// ── Military bases ───────────────────────────────────────────────────────
// Three distinct category SVG glyphs by branch — never a bare point (CLAUDE.md
// invariant). Shares the same rounded-tile language as airport/port markers so
// all "place" reference layers read as one visual family, but a different
// glyph + hue per branch keeps them tellable apart: a chevron for air, an
// anchor for naval, a star for army. `branch` outside {air,naval,army} (a
// future data-source surprise) falls back to the army star rather than
// silently dropping the icon.
const HEX_BASE_AIR = '#60a5fa';   // blue-400
const HEX_BASE_NAVAL = '#2dd4bf'; // teal-400 (echoes the vessel/port palette)
const HEX_BASE_ARMY = '#a3a380'; // olive-drab

function baseAirSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="${HEX_BASE_AIR}" stroke="${PLACE_OUT}" stroke-width="1.4"/>
    <path d="M12 4.6 L12.9 11 L18 13 L18 14.3 L12.9 13.1 L12.9 16.7 L14.3 17.6 L14.3 18.7 L12 18 L9.7 18.7 L9.7 17.6 L11.1 16.7 L11.1 13.1 L6 14.3 L6 13 L11.1 11 Z"
      fill="#0b1a3a" stroke="${PLACE_OUT}" stroke-width="0.5" stroke-linejoin="round"/>
  </svg>`;
}

function baseNavalSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="${HEX_BASE_NAVAL}" stroke="${PLACE_OUT}" stroke-width="1.4"/>
    <circle cx="12" cy="5.9" r="1.8" fill="none" stroke="#04241f" stroke-width="1.5"/>
    <line x1="12" y1="7.6" x2="12" y2="18.4" stroke="#04241f" stroke-width="1.6" stroke-linecap="round"/>
    <line x1="8.4" y1="10" x2="15.6" y2="10" stroke="#04241f" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M6 13.4 C6 16.8 8.9 18.6 12 18.6 C15.1 18.6 18 16.8 18 13.4" fill="none" stroke="#04241f" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}

function baseArmySvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="${HEX_BASE_ARMY}" stroke="${PLACE_OUT}" stroke-width="1.4"/>
    <path d="M12 4.5 13.8 9 18.5 9.6 15 12.8 16 17.5 12 15.1 8 17.5 9 12.8 5.5 9.6 10.2 9 Z"
      fill="#1c1c12" stroke="${PLACE_OUT}" stroke-width="0.5" stroke-linejoin="round"/>
  </svg>`;
}

export function baseStyle(props: Record<string, unknown>): { imageUri: string; scale: number } {
  const branch = String(props['branch'] ?? '').toLowerCase();
  if (branch === 'naval') {
    return { imageUri: cachedIcon('base:naval', () => placeDataUri(baseNavalSvg())), scale: 0.95 };
  }
  if (branch === 'army') {
    return { imageUri: cachedIcon('base:army', () => placeDataUri(baseArmySvg())), scale: 0.95 };
  }
  // 'air' and any unrecognized branch value both render the air glyph — the
  // most common branch in the Wikidata source set — rather than dropping the
  // icon entirely.
  return { imageUri: cachedIcon('base:air', () => placeDataUri(baseAirSvg())), scale: 0.95 };
}

// ── Naval (NGA broadcast) warnings ───────────────────────────────────────
// A warning-triangle glyph for ordinary navigational warnings; `mine: true`
// swaps to a visually distinct red mine glyph (a spiked circle — the
// universal naval-mine pictogram) so the operator can spot the highest-
// severity subset without reading the text.
const HEX_WARNING = '#f59e0b'; // warn amber
const HEX_MINE = '#ef4444';    // alert red

function warningSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <path d="M12 2.5 22 20.5H2z" fill="${HEX_WARNING}" stroke="${PLACE_OUT}" stroke-width="1.4" stroke-linejoin="round"/>
    <line x1="12" y1="9" x2="12" y2="14.5" stroke="#1a1200" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="12" cy="17.3" r="1.1" fill="#1a1200"/>
  </svg>`;
}

function mineSvg(): string {
  const spikes = [0, 45, 90, 135, 180, 225, 270, 315]
    .map((deg) => {
      const rad = (deg * Math.PI) / 180;
      const x1 = 12 + Math.cos(rad) * 6.5;
      const y1 = 12 + Math.sin(rad) * 6.5;
      const x2 = 12 + Math.cos(rad) * 10.5;
      const y2 = 12 + Math.sin(rad) * 10.5;
      return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${HEX_MINE}" stroke-width="1.8" stroke-linecap="round"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    ${spikes}
    <circle cx="12" cy="12" r="6.5" fill="${HEX_MINE}" stroke="${PLACE_OUT}" stroke-width="1.2"/>
    <circle cx="9.6" cy="9.6" r="1.3" fill="#3a0000"/>
  </svg>`;
}

export function warningStyle(props: Record<string, unknown>): { imageUri: string; scale: number } {
  if (props['mine'] === true) {
    return { imageUri: cachedIcon('warning:mine', () => placeDataUri(mineSvg())), scale: 1.0 };
  }
  return { imageUri: cachedIcon('warning:std', () => placeDataUri(warningSvg())), scale: 0.9 };
}

// ── Critical-infrastructure / military facilities (2026-07-11 wave) ──────
// One StyleKind ('facility') dispatched on props.category, exactly like
// baseStyle dispatches on props.branch — square place tiles, one glyph +
// palette color per category. Unknown categories fall back to a neutral tile.
const FACILITY_COLORS: Record<string, string> = {
  power: '#f59e0b',                // amber — generation
  nuclear: '#ef4444',              // red — nuclear
  water_treatment: '#38bdf8',      // sky — water
  desalination: '#2dd4bf',         // teal — desalination
  datacenter: '#a78bfa',           // violet — compute
  telecom_hub: '#818cf8',          // indigo — comms
  ground_station: '#34d399',       // emerald — space downlink
  telescope: '#c084fc',            // purple — astronomy
  launch: '#fb923c',               // orange — launch
  military_installation: '#f87171', // light red — DoD MIRTA
  garrison: '#f87171',
  training: '#fbbf24',
};

function facilityGlyph(category: string): string {
  switch (category) {
    case 'power': // lightning bolt
      return '<path d="M13 3 6.5 13.2h4L10.6 21l6.9-10.4h-4z" fill="#1a1200"/>';
    case 'nuclear': { // trefoil
      const wedges = [90, 210, 330]
        .map((deg) => {
          const a1 = ((deg - 28) * Math.PI) / 180;
          const a2 = ((deg + 28) * Math.PI) / 180;
          const x1 = 12 + Math.cos(a1) * 7;
          const y1 = 12 + Math.sin(a1) * 7;
          const x2 = 12 + Math.cos(a2) * 7;
          const y2 = 12 + Math.sin(a2) * 7;
          return `<path d="M12 12 L${x1.toFixed(1)} ${y1.toFixed(1)} A7 7 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="#2b0505"/>`;
        })
        .join('');
      return `${wedges}<circle cx="12" cy="12" r="1.8" fill="#2b0505"/>`;
    }
    case 'water_treatment': // droplet
      return '<path d="M12 4.5c2.8 3.6 5 6.4 5 9a5 5 0 1 1-10 0c0-2.6 2.2-5.4 5-9z" fill="#062a3a"/>';
    case 'desalination': // droplet over wave
      return '<path d="M12 4c2.3 3 4.1 5.3 4.1 7.4a4.1 4.1 0 1 1-8.2 0C7.9 9.3 9.7 7 12 4z" fill="#032b26"/><path d="M5 18.5q1.75-1.6 3.5 0t3.5 0 3.5 0 3.5 0" stroke="#032b26" stroke-width="1.6" fill="none" stroke-linecap="round"/>';
    case 'datacenter': // server rack
      return '<rect x="6.5" y="5" width="11" height="4.2" rx="1" fill="#211437"/><rect x="6.5" y="10.4" width="11" height="4.2" rx="1" fill="#211437"/><rect x="6.5" y="15.8" width="11" height="3.2" rx="1" fill="#211437"/><circle cx="9" cy="7.1" r="0.8" fill="#a78bfa"/><circle cx="9" cy="12.5" r="0.8" fill="#a78bfa"/>';
    case 'telecom_hub': // radio mast
      return '<path d="M12 5v14M12 5l-4.5 14M12 5l4.5 14" stroke="#141737" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M7.5 7.5a6.4 6.4 0 0 1 9 0M9.2 9.6a3.6 3.6 0 0 1 5.6 0" stroke="#141737" stroke-width="1.3" fill="none" stroke-linecap="round"/>';
    case 'ground_station': // dish
      return '<path d="M6 8a8.5 8.5 0 0 0 10 10z" fill="#03291c"/><line x1="11" y1="13" x2="17" y2="7" stroke="#03291c" stroke-width="1.6" stroke-linecap="round"/><circle cx="17.3" cy="6.7" r="1.4" fill="#03291c"/><path d="M9.5 18.5h5" stroke="#03291c" stroke-width="1.6" stroke-linecap="round"/>';
    case 'telescope': // scope tube on mount
      return '<rect x="5" y="8.6" width="12.5" height="3.4" rx="1.5" transform="rotate(-25 11 10.5)" fill="#26103a"/><path d="M11 13.5 8.5 19.5M12.5 13.5 15 19.5" stroke="#26103a" stroke-width="1.6" stroke-linecap="round"/>';
    case 'launch': // rocket
      return '<path d="M12 3.5c2.6 2 3.4 5.4 2.4 9.1l1.9 2.6-2.9-.4c-.4.7-.9 1.4-1.4 2-.5-.6-1-1.3-1.4-2l-2.9.4 1.9-2.6c-1-3.7-.2-7.1 2.4-9.1z" fill="#331303"/><path d="M10.4 17.5 12 21l1.6-3.5" stroke="#331303" stroke-width="1.4" fill="none" stroke-linecap="round"/>';
    case 'military_installation':
    case 'garrison':
    case 'training': // five-point star
      return '<path d="M12 4.6l2 4.6 5 .5-3.8 3.3 1.1 4.9L12 15.3l-4.3 2.6 1.1-4.9L5 9.7l5-.5z" fill="#2b0808"/>';
    default:
      return '<circle cx="12" cy="12" r="4.5" fill="#101418"/>';
  }
}

function facilitySvg(category: string): string {
  const tile = FACILITY_COLORS[category] ?? '#9ca3af';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="${tile}" stroke="${PLACE_OUT}" stroke-width="1.4"/>
    ${facilityGlyph(category)}
  </svg>`;
}

export function facilityStyle(props: Record<string, unknown>): { imageUri: string; scale: number } {
  let category = String(props['category'] ?? '').toLowerCase();
  // The nuclear toggle serves power rows flagged nuclear — give them the
  // trefoil regardless of which toggle fetched them.
  if (category === 'power' && String(props['fuel'] ?? '') === 'Nuclear') category = 'nuclear';
  return {
    imageUri: cachedIcon(`facility:${category}`, () => placeDataUri(facilitySvg(category))),
    scale: 0.95,
  };
}
