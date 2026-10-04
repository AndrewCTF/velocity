import type { ImageryMode } from '../state/stores.js';
import { latestRuntimeConfig } from '../transport/config.js';

// Basemap picker options, in display order. Attribution strings double as
// the option tooltip — Esri/OpenTopoMap/USGS/EOX all require it per their
// ToS. The Cesium credit container itself stays off (dark-chrome invariant,
// GlobeCanvas.tsx) so this tooltip is the attribution surface for now; a
// future pass can also surface it in a persistent footer.
export const BASEMAP_OPTIONS: Array<{
  value: ImageryMode;
  label: string;
  title: string;
  /** Why this basemap cannot be chosen right now, or null. Absent = always can. */
  unavailable?: () => string | null;
}> = [
  { value: '2d-dark', label: '2D dark', title: 'Dark gray canvas (Esri, proxied, keyless)' },
  {
    value: '3d-sat',
    label: '3D sat',
    title: 'Keyless satellite imagery + 3D terrain (ion token adds OSM Buildings)',
  },
  {
    value: 'google-3d',
    label: 'Google 3D',
    title: 'Photoreal 3D cities from Google Earth, no key · Data (c) Google. Non-commercial use only',
    unavailable: () => {
      // No config yet is "not known", not "off": the backend answers a cold
      // boot late, and the menu can be opened before it does.
      const config = latestRuntimeConfig();
      if (!config) return 'Still connecting to the server.';
      return config.features.google3dKeyless
        ? null
        : 'This server has Google 3D switched off (GOOGLE_3D_KEYLESS).';
    },
  },
  {
    value: 'apple-sat',
    label: 'Apple sat',
    title: 'Apple Maps satellite (proxied, keyless) · Imagery (c) Apple. Non-commercial use only',
  },
  {
    value: 'esri-imagery',
    label: 'Esri imagery',
    title: 'Esri World Imagery · Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  { value: 'esri-topo', label: 'Esri topo', title: 'Esri World Topographic Map · Esri, HERE, Garmin, FAO, NOAA, USGS' },
  { value: 'esri-dark', label: 'Esri dark', title: 'Esri Dark Gray Canvas · Esri' },
  {
    value: 'opentopo',
    label: 'OpenTopo',
    title: 'OpenTopoMap · Map data (c) OpenStreetMap contributors, SRTM | Map style (c) OpenTopoMap (CC-BY-SA)',
  },
  { value: 'usgs-imagery', label: 'USGS imagery', title: 'USGS Imagery Only · USGS The National Map (public domain)' },
  {
    value: 'eox-s2',
    label: 'EOX S2',
    title: 'Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data)',
  },
];
