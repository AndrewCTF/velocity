// Curated Map-layers catalog for the Normal dashboard's Palantir-Gotham left rail.
//
// The registry has 34 layers, many of which are redundant SOURCE feeds for the same
// capability (5 aviation feeds, 10 maritime feeds incl. 6 regional SAR windows). Showing
// every source as its own row is the "too detailed / which sources" clutter the operator
// rejected. This catalog groups them into a small set of clean domain FOLDERS, each with a
// few plain-English capability ROWS. A row can control one OR several real layer ids (e.g.
// "Earthquakes" = USGS + EMSC; "Dark-vessel SAR" = all six maritime.sar.* windows).
//
// Redundant breadth sources (adsb.fi, OpenSky, AISStream) are HIDDEN here — they still exist
// and are reachable on the Data sources tab's "Live data layers" list. Nothing is dropped.
//
// Pure data + registry-facade helpers; no React. Guarded by ./layerCatalog.test.ts.
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import type { IconName } from './Icon.js';

export interface CatalogRow {
  /** Plain capability label (no source name). */
  readonly label: string;
  readonly icon: IconName;
  /** The real registry layer id(s) this row enables/disables together. */
  readonly layerIds: readonly string[];
}

export interface CatalogFolder {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly defaultOpen?: boolean;
  readonly rows: readonly CatalogRow[];
}

export const MAP_LAYER_FOLDERS: readonly CatalogFolder[] = [
  {
    id: 'air',
    label: 'Air',
    icon: 'plane',
    defaultOpen: true,
    rows: [
      { label: 'Aircraft', icon: 'plane', layerIds: ['aviation.adsb.global'] },
      { label: 'Military', icon: 'jet', layerIds: ['aviation.adsb.live.mil'] },
      { label: 'Emergency', icon: 'warning', layerIds: ['aviation.adsb.live.emergencies'] },
      { label: 'TFR / Airspace', icon: 'warning', layerIds: ['airspace.tfr'] },
    ],
  },
  {
    id: 'maritime',
    label: 'Maritime',
    icon: 'ship',
    defaultOpen: true,
    rows: [
      { label: 'Vessels', icon: 'ship', layerIds: ['maritime.keyless'] },
      { label: 'Baltic AIS', icon: 'ship', layerIds: ['maritime.digitraffic'] },
      {
        label: 'Dark-vessel SAR',
        icon: 'crosshair',
        layerIds: [
          'maritime.sar.hormuz',
          'maritime.sar.bab-el-mandeb',
          'maritime.sar.gulf-of-aden',
          'maritime.sar.suez-gulf-approach',
          'maritime.sar.kerch-strait',
          'maritime.sar.taiwan-strait',
        ],
      },
      { label: 'Parking mode', icon: 'anchor', layerIds: ['maritime.parked'] },
      { label: 'Naval warnings', icon: 'warning', layerIds: ['maritime.warnings'] },
    ],
  },
  {
    id: 'space',
    label: 'Space',
    icon: 'satellite',
    rows: [
      { label: 'Stations / ISS', icon: 'satellite', layerIds: ['space.celestrak.stations'] },
      { label: 'Starlink', icon: 'satellite', layerIds: ['space.celestrak.starlink'] },
      { label: 'GPS', icon: 'satellite', layerIds: ['space.celestrak.gps'] },
      { label: 'Visual', icon: 'satellite', layerIds: ['space.celestrak.visual'] },
    ],
  },
  {
    id: 'ground',
    label: 'Ground & Hazards',
    icon: 'fire',
    rows: [
      {
        label: 'Earthquakes',
        icon: 'quake',
        layerIds: ['hazards.usgs.quakes', 'hazards.emsc.quakes'],
      },
      { label: 'Fires', icon: 'fire', layerIds: ['hazards.nasa.firms'] },
      { label: 'Natural events', icon: 'warning', layerIds: ['hazards.nasa.eonet'] },
      { label: 'Weather alerts', icon: 'warning', layerIds: ['hazards.nws.alerts'] },
      { label: 'GPS jamming', icon: 'signal', layerIds: ['env.jamming.nacp'] },
    ],
  },
  {
    id: 'signals',
    label: 'Signals & Events',
    icon: 'signal',
    rows: [
      { label: 'Armed conflict', icon: 'crosshair', layerIds: ['conflict.gdelt.live'] },
      { label: 'Fused warnings', icon: 'shield', layerIds: ['intel.incidents.live'] },
      { label: 'Internet outages', icon: 'signal', layerIds: ['cyber.ioda.outages'] },
      { label: 'GDELT events', icon: 'bell', layerIds: ['news.gdelt.events'] },
      { label: 'ACLED conflict', icon: 'bell', layerIds: ['news.acled.events'] },
    ],
  },
  {
    id: 'infra',
    label: 'Infrastructure',
    icon: 'network',
    rows: [
      {
        label: 'Submarine cables',
        icon: 'network',
        layerIds: ['infra.cables.lines', 'infra.cables.landings'],
      },
      { label: 'CCTV cameras', icon: 'image', layerIds: ['infra.cams.public'] },
      { label: 'Airports', icon: 'plane', layerIds: ['places.airports'] },
      { label: 'Ports', icon: 'anchor', layerIds: ['places.ports'] },
      { label: 'Military bases', icon: 'shield', layerIds: ['places.bases'] },
    ],
  },
  {
    id: 'reference',
    label: 'Reference',
    icon: 'layers',
    rows: [{ label: 'COP units', icon: 'shield', layerIds: ['mil.cop.notional'] }],
  },
];

// Registered layers deliberately NOT shown on Map layers — redundant breadth sources that are
// unioned server-side and belong on the Data sources tab, not as operator toggles here.
export const HIDDEN_SOURCE_IDS: readonly string[] = [
  'aviation.adsb.fi.global',
  'aviation.opensky.states',
  'maritime.aisstream',
];

/** Every layer id referenced by a catalog row (deduped). */
export function catalogLayerIds(): readonly string[] {
  const set = new Set<string>();
  for (const f of MAP_LAYER_FOLDERS) for (const r of f.rows) for (const id of r.layerIds) set.add(id);
  return [...set];
}

/** A row is "on" when ANY of its mapped layers is enabled. */
export function rowEnabled(registry: LayerRegistry, row: CatalogRow): boolean {
  return row.layerIds.some((id) => registry.isEnabled(id));
}

/** Toggle a row: if any mapped layer is on, turn them all OFF; else turn them all ON. */
export function toggleRow(registry: LayerRegistry, row: CatalogRow): void {
  const on = rowEnabled(registry, row);
  for (const id of row.layerIds) {
    if (on) registry.disable(id);
    else registry.enable(id);
  }
}

/** {on,total} capability-row counts for a folder header badge. */
export function folderCounts(registry: LayerRegistry, folder: CatalogFolder): { on: number; total: number } {
  let on = 0;
  for (const r of folder.rows) if (rowEnabled(registry, r)) on += 1;
  return { on, total: folder.rows.length };
}

/** Toggle a whole folder (the eye icon): any row on → all off; else all on. */
export function toggleFolder(registry: LayerRegistry, folder: CatalogFolder): void {
  const anyOn = folder.rows.some((r) => rowEnabled(registry, r));
  for (const r of folder.rows) for (const id of r.layerIds) {
    if (anyOn) registry.disable(id);
    else registry.enable(id);
  }
}
