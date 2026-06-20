// Inline SVG icons baked as data URIs. Top-down silhouettes so a heading
// rotation (Cesium billboard `rotation` field) puts them in the right
// orientation on the map. Pure SVG + currentColor so we can tint them per
// entity by repainting the SVG into a canvas.

function dataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// 24×24 viewBox, nose-up. Source: simplified Tabler plane outline.
function aircraftSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <path d="M12 1.5 L13.6 11.3 L22.5 14 L22.5 16 L13.6 14.2 L13.6 19.5 L16 21 L16 22.5 L12 21.5 L8 22.5 L8 21 L10.4 19.5 L10.4 14.2 L1.5 16 L1.5 14 L10.4 11.3 Z"
      fill="${color}" stroke="${outline}" stroke-width="0.75" stroke-linejoin="round"/>
  </svg>`;
}

// Smaller plane silhouette for light / private aircraft (A1/A2). Same
// nose-up orientation as `aircraftSvg`, narrower wingspan + shorter fuselage
// so it visually reads as a piston single / light twin next to airliners.
function privateAircraftSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <path d="M12 3 L13.1 11.6 L19.5 13.5 L19.5 15 L13.1 13.9 L13.1 18.5 L15 19.7 L15 20.8 L12 20 L9 20.8 L9 19.7 L10.9 18.5 L10.9 13.9 L4.5 15 L4.5 13.5 L10.9 11.6 Z"
      fill="${color}" stroke="${outline}" stroke-width="0.6" stroke-linejoin="round"/>
  </svg>`;
}

// Glider silhouette — long thin wings, narrow fuselage, no engine bulge.
// Wingspan extends nearly edge-to-edge of the viewBox to read as a sailplane.
function gliderSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <path d="M11.6 2 L12.4 2 L12.7 11 L23 12 L23 13 L12.7 13.4 L12.7 19.2 L14.6 20.4 L14.6 21.5 L12 21 L9.4 21.5 L9.4 20.4 L11.3 19.2 L11.3 13.4 L1 13 L1 12 L11.3 11 Z"
      fill="${color}" stroke="${outline}" stroke-width="0.6" stroke-linejoin="round"/>
  </svg>`;
}

// Generic helicopter / rotorcraft silhouette (top-down)
function helicopterSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <line x1="2" y1="12" x2="22" y2="12" stroke="${color}" stroke-width="1"/>
    <ellipse cx="12" cy="12" rx="3" ry="5" fill="${color}" stroke="${outline}" stroke-width="0.75"/>
    <line x1="12" y1="17" x2="12" y2="21" stroke="${color}" stroke-width="1.2"/>
  </svg>`;
}

// Top-down ship silhouette (bow up) — generic fallback used when ITU ship
// type is unknown or doesn't fit any specific category.
function vesselSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <path d="M12 2 L17 8 L17 19 L15 22 L9 22 L7 19 L7 8 Z"
      fill="${color}" stroke="${outline}" stroke-width="0.75" stroke-linejoin="round"/>
  </svg>`;
}

// Cargo ship (ITU 70-79): wider rectangular silhouette with stacked container
// blocks visible from above. Bow up.
function cargoShipSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <path d="M12 1.5 L17 6 L17 21 L15.5 22.5 L8.5 22.5 L7 21 L7 6 Z"
      fill="${color}" stroke="${outline}" stroke-width="0.75" stroke-linejoin="round"/>
    <rect x="8.5" y="8" width="7" height="2.2" fill="${outline}" opacity="0.55"/>
    <rect x="8.5" y="11" width="7" height="2.2" fill="${outline}" opacity="0.55"/>
    <rect x="8.5" y="14" width="7" height="2.2" fill="${outline}" opacity="0.55"/>
    <rect x="8.5" y="17" width="7" height="2.2" fill="${outline}" opacity="0.55"/>
  </svg>`;
}

// Tanker (ITU 80-89): long narrow vessel with rounded ends and a centerline
// manifold strip. Bow up.
function tankerSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <path d="M12 1.5 C15 1.5 16.5 4 16.5 7 L16.5 18 C16.5 21 15 22.5 12 22.5 C9 22.5 7.5 21 7.5 18 L7.5 7 C7.5 4 9 1.5 12 1.5 Z"
      fill="${color}" stroke="${outline}" stroke-width="0.75" stroke-linejoin="round"/>
    <line x1="12" y1="6" x2="12" y2="19" stroke="${outline}" stroke-width="0.6" opacity="0.7"/>
    <circle cx="12" cy="10" r="0.9" fill="${outline}" opacity="0.7"/>
    <circle cx="12" cy="14" r="0.9" fill="${outline}" opacity="0.7"/>
  </svg>`;
}

// Fishing vessel (ITU 30): small vessel with mast/boom triangle on top to
// suggest fishing gear / outriggers.
function fishingSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22">
    <path d="M12 5 L15.5 9 L15.5 19 L14 22 L10 22 L8.5 19 L8.5 9 Z"
      fill="${color}" stroke="${outline}" stroke-width="0.75" stroke-linejoin="round"/>
    <path d="M12 5 L9 1.5 L15 1.5 Z" fill="${color}" stroke="${outline}" stroke-width="0.6" stroke-linejoin="round"/>
    <line x1="12" y1="11" x2="12" y2="18" stroke="${outline}" stroke-width="0.5" opacity="0.7"/>
  </svg>`;
}

// Pleasure craft / yacht (ITU 37): small smooth pointed vessel.
function pleasureCraftSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <path d="M12 4 C14 7 15 10 15 15 C15 19 14 21 12 22 C10 21 9 19 9 15 C9 10 10 7 12 4 Z"
      fill="${color}" stroke="${outline}" stroke-width="0.6" stroke-linejoin="round"/>
  </svg>`;
}

// Flame for fires
function fireSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14">
    <path d="M12 2 C9 6 5 8 5 13 a7 7 0 0 0 14 0 c0 -3 -2 -5 -4 -7 c1 3 -1 4 -2 4 c0 -3 -1 -5 -1 -8 z"
      fill="${color}" stroke="#000" stroke-width="0.75"/>
  </svg>`;
}

// Filled circle with outer ring for quakes; size set by Cesium scale
function quakeSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <circle cx="12" cy="12" r="6" fill="${color}" stroke="#000" stroke-width="0.75"/>
    <circle cx="12" cy="12" r="10" fill="none" stroke="${color}" stroke-opacity="0.5" stroke-width="1"/>
  </svg>`;
}

// Small satellite silhouette (kept simple for performance)
function satelliteSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
    <rect x="9" y="9" width="6" height="6" fill="${color}" stroke="#000" stroke-width="0.5"/>
    <rect x="2" y="10.5" width="6" height="3" fill="${color}" stroke="#000" stroke-width="0.5"/>
    <rect x="16" y="10.5" width="6" height="3" fill="${color}" stroke="#000" stroke-width="0.5"/>
  </svg>`;
}

// Dark-vessel candidate marker (diamond + question mark visual)
function darkVesselSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <path d="M12 2 L22 12 L12 22 L2 12 Z" fill="${color}" stroke="#000" stroke-width="0.75"/>
    <text x="12" y="16" text-anchor="middle" font-family="monospace" font-size="11" fill="#000" font-weight="bold">?</text>
  </svg>`;
}

// CCTV camera — housing + lens barrel + mount stem.
function cameraSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <rect x="3" y="6" width="13" height="8" rx="2" fill="${color}" stroke="#000" stroke-width="0.75"/>
    <path d="M16 8.5 L21 6.5 L21 13.5 L16 11.5 Z" fill="${color}" stroke="#000" stroke-width="0.75"/>
    <circle cx="8" cy="10" r="2.2" fill="#0b0e14"/>
    <rect x="8.5" y="14" width="2" height="4" fill="${color}" stroke="#000" stroke-width="0.5"/>
  </svg>`;
}

// Fixed-wing attack/loitering drone (top-down, nose up) — delta planform with a
// fuselage spine. Used by the simulation layer for swarm contacts.
function uavSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <path d="M12 2 L20 19 L12 15 L4 19 Z" fill="${color}" stroke="${outline}" stroke-width="0.6" stroke-linejoin="round"/>
    <rect x="11" y="3" width="2" height="14" rx="1" fill="${color}" stroke="${outline}" stroke-width="0.4"/>
  </svg>`;
}

// Quadcopter (top-down) — central body, four arms, rotor discs. Smaller drones.
function droneSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
    <line x1="6" y1="6" x2="18" y2="18" stroke="${color}" stroke-width="1.4"/>
    <line x1="18" y1="6" x2="6" y2="18" stroke="${color}" stroke-width="1.4"/>
    <circle cx="6" cy="6" r="3" fill="none" stroke="${color}" stroke-width="1.2"/>
    <circle cx="18" cy="6" r="3" fill="none" stroke="${color}" stroke-width="1.2"/>
    <circle cx="6" cy="18" r="3" fill="none" stroke="${color}" stroke-width="1.2"/>
    <circle cx="18" cy="18" r="3" fill="none" stroke="${color}" stroke-width="1.2"/>
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="${color}" stroke="${outline}" stroke-width="0.5"/>
  </svg>`;
}

// Surface-to-air missile / air-defence site (top-down) — launcher box with a
// raised radar/mast. Used by the simulation defence layer (Phase C).
function samSiteSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22">
    <rect x="5" y="9" width="14" height="9" rx="1.5" fill="${color}" stroke="${outline}" stroke-width="0.6"/>
    <path d="M8 9 L10 4 L12 9 Z" fill="${color}" stroke="${outline}" stroke-width="0.5"/>
    <path d="M12 9 L14 4 L16 9 Z" fill="${color}" stroke="${outline}" stroke-width="0.5"/>
    <circle cx="12" cy="13.5" r="1.6" fill="${outline}" opacity="0.6"/>
  </svg>`;
}

// Generic ground unit (top-down) — NATO-style rectangle, for troop formations.
function groundUnitSvg(color: string, outline = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="16">
    <rect x="3" y="4" width="18" height="12" rx="1" fill="${color}" stroke="${outline}" stroke-width="0.6"/>
    <line x1="4" y1="5" x2="20" y2="15" stroke="${outline}" stroke-width="0.7" opacity="0.7"/>
    <line x1="20" y1="5" x2="4" y2="15" stroke="${outline}" stroke-width="0.7" opacity="0.7"/>
  </svg>`;
}

// Emergency triangle
function emergencySvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22">
    <path d="M12 2 L22 21 L2 21 Z" fill="${color}" stroke="#000" stroke-width="0.75"/>
    <text x="12" y="18" text-anchor="middle" font-family="monospace" font-size="13" font-weight="bold" fill="#000">!</text>
  </svg>`;
}

export const icons = {
  aircraft: (color: string) => dataUri(aircraftSvg(color)),
  privateAircraft: (color: string) => dataUri(privateAircraftSvg(color)),
  glider: (color: string) => dataUri(gliderSvg(color)),
  helicopter: (color: string) => dataUri(helicopterSvg(color)),
  vessel: (color: string) => dataUri(vesselSvg(color)),
  cargoShip: (color: string) => dataUri(cargoShipSvg(color)),
  tanker: (color: string) => dataUri(tankerSvg(color)),
  fishing: (color: string) => dataUri(fishingSvg(color)),
  pleasureCraft: (color: string) => dataUri(pleasureCraftSvg(color)),
  fire: (color: string) => dataUri(fireSvg(color)),
  quake: (color: string) => dataUri(quakeSvg(color)),
  satellite: (color: string) => dataUri(satelliteSvg(color)),
  darkVessel: (color: string) => dataUri(darkVesselSvg(color)),
  emergency: (color: string) => dataUri(emergencySvg(color)),
  camera: (color: string) => dataUri(cameraSvg(color)),
  uav: (color: string) => dataUri(uavSvg(color)),
  drone: (color: string) => dataUri(droneSvg(color)),
  samSite: (color: string) => dataUri(samSiteSvg(color)),
  groundUnit: (color: string) => dataUri(groundUnitSvg(color)),
};

// Cache so we don't reflow data URIs every render.
const _cache = new Map<string, string>();
export function cachedIcon(key: string, factory: () => string): string {
  let v = _cache.get(key);
  if (!v) {
    v = factory();
    _cache.set(key, v);
  }
  return v;
}

// Every (key → factory) the style layer can ask for, enumerated so we can
// build + GPU-decode them ONCE up front instead of lazily on the first heavy
// render frame (13k+ entities). Keep in sync with styles.ts cachedIcon keys.
const PREWARM: Array<[string, () => string]> = [
  ['aircraft:#ef4444', () => icons.aircraft('#ef4444')], // emergency (tinted airliner)
  ['aircraft:#f59e0b', () => icons.aircraft('#f59e0b')], // military
  ['aircraft:#facc15', () => icons.aircraft('#facc15')], // airliner
  ['heli:#c084fc', () => icons.helicopter('#c084fc')],
  ['glider:#93c5fd', () => icons.glider('#93c5fd')],
  ['private:#2dd4bf', () => icons.privateAircraft('#2dd4bf')],
  ['vessel:cargo:#14b8a6', () => icons.cargoShip('#14b8a6')],
  ['vessel:tanker:#d97706', () => icons.tanker('#d97706')],
  ['vessel:fishing:#5eead4', () => icons.fishing('#5eead4')],
  ['vessel:passenger:#38bdf8', () => icons.vessel('#38bdf8')],
  ['vessel:vessel-mil:#f59e0b', () => icons.vessel('#f59e0b')],
  ['vessel:sailing:#a5f3fc', () => icons.pleasureCraft('#a5f3fc')],
  ['vessel:pleasure:#4ade80', () => icons.pleasureCraft('#4ade80')],
  ['vessel:tug:#c084fc', () => icons.vessel('#c084fc')],
  ['vessel:sar:#ef4444', () => icons.vessel('#ef4444')],
  ['vessel:generic:#34d399', () => icons.vessel('#34d399')],
  ['vessel:dark:#ef4444', () => icons.darkVessel('#ef4444')],
];

let _prewarmed = false;

// Build every known icon data URI into the cache AND kick off the browser's
// async image decode for each, so by the time the first poll's billboards
// reference them the textures are already decoded — no per-icon decode stall
// interleaved with the first render frame. Idempotent. Safe to call before
// the Cesium viewer is interactive. No-op outside the browser (SSR/tests).
export function prewarmIcons(): void {
  if (_prewarmed) return;
  _prewarmed = true;
  for (const [key, factory] of PREWARM) {
    const uri = cachedIcon(key, factory);
    if (typeof Image !== 'undefined') {
      const img = new Image();
      img.src = uri;
      // decode() warms the GPU/image cache off the critical path; ignore
      // rejection (e.g. detached document) — it's a best-effort warmup.
      void img.decode?.().catch(() => {});
    }
  }
}
