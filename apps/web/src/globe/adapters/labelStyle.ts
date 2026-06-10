import * as Cesium from 'cesium';

// Shared label styling for entity name/callsign chips rendered next to icons
// (aircraft callsigns, vessel names/MMSI, etc.). Centralised so adapters do
// not drift in font, padding, or visibility distance — pilots and analysts
// expect labels to feel like one system, not a patchwork.
//
// Design:
// - Bold IBM Plex Mono 11px for legibility at glance.
// - Fill + outline so text reads against any basemap (dark ocean, bright
//   land, snow, satellite imagery).
// - Translucent dark pill so labels never blend into bright textures.
// - Pixel offset (12, -2) places the chip up and to the right of the icon.
// - DistanceDisplayCondition out to 5,000 km matches the rough zoom band
//   where the user is still inspecting individual platforms.
export function labelFor(text: string): Cesium.LabelGraphics.ConstructorOptions {
  return {
    text,
    font: 'bold 11px "IBM Plex Mono", monospace',
    pixelOffset: new Cesium.Cartesian2(12, -2),
    fillColor: Cesium.Color.fromCssColorString('#c9d4e0'),
    outlineColor: Cesium.Color.fromCssColorString('#0b0e14'),
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    showBackground: true,
    backgroundColor: Cesium.Color.fromCssColorString('#0b0e14').withAlpha(0.65),
    backgroundPadding: new Cesium.Cartesian2(4, 2),
    scaleByDistance: new Cesium.NearFarScalar(1.5e5, 1.0, 1.0e7, 0.0),
    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5_000_000),
  };
}

// Resolve the best human-readable identifier for an aircraft feature.
// Preference order: callsign (e.g. "DAL123") → registration (tail) → ICAO 24-bit
// hex (uppercased). Returns null only when nothing identifying is available.
export function aircraftLabelText(props: Record<string, unknown>): string | null {
  const cs = (props['callsign'] as string | null | undefined)?.toString().trim() ?? null;
  if (cs) return cs;
  const reg = (props['registration'] as string | null | undefined)?.toString().trim() ?? null;
  if (reg) return reg;
  const icao = (props['icao24'] as string | null | undefined)?.toString().trim() ?? null;
  if (icao) return icao.toUpperCase();
  return null;
}

// Resolve the best human-readable identifier for a vessel feature.
// AIS frames with a static name (rare from Digitraffic, common from AISStream
// ShipStaticData) take precedence; otherwise we fall back to "MMSI 123456789"
// so the operator can still identify the contact in dense traffic.
export function vesselLabelText(props: Record<string, unknown>): string | null {
  const nm = (props['name'] as string | null | undefined)?.toString().trim() ?? null;
  if (nm) return nm;
  const mmsi = props['mmsi'];
  if (mmsi != null && String(mmsi).trim() !== '') return `MMSI ${mmsi}`;
  return null;
}
