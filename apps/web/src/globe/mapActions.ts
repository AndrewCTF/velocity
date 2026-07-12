// Shared map actions — the SAME set the right-click context menu exposes, so a
// drawn AREA box offers identical capabilities (collect imagery, ground recon,
// imagery diff, search-around, watchbox, AI assessment, situation…) scoped to
// the box instead of a single point. One source of truth: ContextMenu.tsx and
// the GlobeToolbar area readout both build from here, so they never drift.
import { useChip } from '../imagery/chipStore.js';
import { useWatchboxes } from '../watchbox/watchboxStore.js';
import { useAnnotations } from '../annotations/annotationStore.js';
import { useSituations } from '../situations/situationStore.js';
import { useSelection } from '../state/stores.js';
import { useImageryDiff } from '../imagery/imageryDiffStore.js';
import { useGround } from '../ground/groundStore.js';
import { useGeoScope } from '../state/geoScope.js';
import { useAgent } from '../state/agent.js';
import type { AreaResult } from './mapTools.js';

export interface MapAction {
  label: string;
  run: () => void | Promise<void>;
}

// Point actions — the canonical right-click list. ContextMenu renders these
// verbatim so the two surfaces stay identical.
export function pointActions(lat: number, lon: number): MapAction[] {
  return [
    {
      label: 'Collect imagery here',
      run: () =>
        useChip.getState().setFocus({ entityId: `aoi:${lat.toFixed(3)},${lon.toFixed(3)}`, lat, lon, radiusKm: 4 }),
    },
    {
      label: 'Ground recon here',
      run: () => useGround.getState().openAt({ lat, lon, radiusKm: 2 }),
    },
    {
      label: 'Imagery diff here',
      run: () => useImageryDiff.getState().openAt({ lat, lon }),
    },
    {
      label: 'Search objects nearby (50 km)',
      run: () =>
        useGeoScope.getState().setScope({ lat, lon, radiusKm: 50, label: `${lat.toFixed(2)}, ${lon.toFixed(2)}` }),
    },
    {
      label: 'AI assess this location',
      run: () =>
        useAgent
          .getState()
          .ask(`Assess the location at ${lat.toFixed(4)}, ${lon.toFixed(4)}: what is here, notable activity, and risks?`),
    },
    {
      label: 'Geosearch',
      run: () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })),
    },
    {
      label: 'Create watchbox',
      run: () =>
        useWatchboxes
          .getState()
          .add({ label: `Watchbox ${lat.toFixed(1)},${lon.toFixed(1)}`, center: { lat, lon }, radiusKm: 25, rule: 'enter' }),
    },
    {
      label: 'Add annotation',
      run: () => useAnnotations.getState().add({ kind: 'point', threat: 'unknown', label: 'Marker', coords: [[lon, lat]] }),
    },
    {
      label: 'Copy coordinates',
      run: () => navigator.clipboard?.writeText(`${lat.toFixed(5)},${lon.toFixed(5)}`),
    },
    {
      label: 'Create situation here',
      run: async () => {
        const id = await useSituations
          .getState()
          .create({ name: `Situation ${lat.toFixed(1)},${lon.toFixed(1)}`, centroid: { lat, lon } });
        useSelection.getState().select(id);
      },
    },
  ];
}

// Area actions — the same capabilities, scoped to a drawn box. Imagery / ground
// / diff use the box CENTRE; search / watchbox / AI use the box EXTENT so they
// cover the whole selection, not just the middle.
export function areaActions(a: AreaResult): MapAction[] {
  const { lat, lon } = a.center;
  const searchRadius = Math.max(1, Math.round(a.radiusKm));
  // Cap the imagery chip to something collectable even for a huge box.
  const imageryRadius = Math.max(1, Math.round(Math.min(a.radiusKm, 12)));
  const boundsLabel = `N ${a.north.toFixed(3)} S ${a.south.toFixed(3)} E ${a.east.toFixed(3)} W ${a.west.toFixed(3)}`;
  return [
    {
      label: `Search objects in box (${searchRadius} km)`,
      run: () => useGeoScope.getState().setScope({ lat, lon, radiusKm: searchRadius, label: 'map area' }),
    },
    {
      label: 'Collect imagery (centre)',
      run: () =>
        useChip.getState().setFocus({ entityId: `aoi:${lat.toFixed(3)},${lon.toFixed(3)}`, lat, lon, radiusKm: imageryRadius }),
    },
    {
      label: 'Ground recon (centre)',
      run: () => useGround.getState().openAt({ lat, lon, radiusKm: 2 }),
    },
    {
      label: 'Imagery diff (centre)',
      run: () => useImageryDiff.getState().openAt({ lat, lon }),
    },
    {
      label: 'AI assess this area',
      run: () =>
        useAgent
          .getState()
          .ask(`Assess the map area bounded by ${boundsLabel} (~${Math.round(a.areaKm2).toLocaleString()} km²): what is inside it, notable activity, and risks?`),
    },
    {
      label: 'Create watchbox over box',
      run: () =>
        useWatchboxes
          .getState()
          .add({ label: `Watchbox ${lat.toFixed(1)},${lon.toFixed(1)}`, center: { lat, lon }, radiusKm: searchRadius, rule: 'enter' }),
    },
    {
      label: 'Create situation here',
      run: async () => {
        const id = await useSituations.getState().create({ name: `AOI ${lat.toFixed(1)},${lon.toFixed(1)}`, centroid: { lat, lon } });
        useSelection.getState().select(id);
      },
    },
    {
      label: 'Copy bounds',
      run: () => navigator.clipboard?.writeText(`${a.south.toFixed(5)},${a.west.toFixed(5)},${a.north.toFixed(5)},${a.east.toFixed(5)}`),
    },
  ];
}
