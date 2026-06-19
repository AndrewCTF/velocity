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
