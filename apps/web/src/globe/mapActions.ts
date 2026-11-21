// Shared map actions — the SAME set the right-click context menu exposes, so a
// drawn AREA box offers identical capabilities (collect imagery, ground recon,
// imagery diff, search-around, watchbox, AI assessment, situation…) scoped to
// the box instead of a single point. One source of truth: ContextMenu.tsx and
// the GlobeToolbar area readout both build from here, so they never drift.
import { useChip } from "../imagery/chipStore.js";
import { useWatchboxes } from "../watchbox/watchboxStore.js";
import { useAnnotations } from "../annotations/annotationStore.js";
import { useSituations } from "../situations/situationStore.js";
import { useSelection } from "../state/stores.js";
import { useImageryDiff } from "../imagery/imageryDiffStore.js";
import { useGround } from "../ground/groundStore.js";
import { useGeoScope } from "../state/geoScope.js";
import { useAgent } from "../state/agent.js";
import { useAlertDraft } from "../settings/alertDraft.js";
import type { AreaResult } from "./mapTools.js";

const KM_PER_NM = 1.852;

export interface MapAction {
  label: string;
  run: () => void | Promise<void>;
  /** Blueprint sprite id the menu draws beside the label. */
  icon?: string;
  /** Draw a rule above this item. */
  sep?: boolean;
}

const pointFeature = (lat: number, lon: number): string =>
  JSON.stringify({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {},
  });

// Point actions — the canonical right-click list. ContextMenu renders these
// verbatim so the two surfaces stay identical. The first six are the reference
// menu's own items in its order; the app's other point actions follow.
export function pointActions(lat: number, lon: number): MapAction[] {
  return [
    {
      label: "Collect satellite imagery...",
      icon: "satellite",
      run: () =>
        useChip.getState().setFocus({
          entityId: `aoi:${lat.toFixed(3)},${lon.toFixed(3)}`,
          lat,
          lon,
          radiusKm: 4,
        }),
    },
    {
      label: "Geosearch",
      icon: "geosearch",
      run: () =>
        useGeoScope.getState().setScope({
          lat,
          lon,
          radiusKm: 50,
          label: `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        }),
    },
    {
      label: "Create geofence",
      icon: "polygon-filter",
      run: () =>
        useWatchboxes.getState().add({
          label: `Watchbox ${lat.toFixed(1)},${lon.toFixed(1)}`,
          center: { lat, lon },
          radiusKm: 25,
          rule: "enter",
        }),
    },
    {
      label: "Alert me about this area",
      run: () =>
        useAlertDraft.getState().open({
          label: `Area ${lat.toFixed(2)}, ${lon.toFixed(2)}`,
          lat,
          lon,
          radius_nm: 15,
        }),
    },
    {
      label: "Copy coordinates",
      icon: "locate",
      sep: true,
      run: () =>
        navigator.clipboard?.writeText(`${lat.toFixed(5)},${lon.toFixed(5)}`),
    },
    {
      label: "Copy",
      icon: "duplicate",
      run: () => navigator.clipboard?.writeText(pointFeature(lat, lon)),
    },
    {
      label: "Export",
      icon: "export",
      run: () => {
        const url = URL.createObjectURL(
          new Blob([pointFeature(lat, lon)], { type: "application/geo+json" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = `point-${lat.toFixed(4)}_${lon.toFixed(4)}.geojson`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      },
    },
    {
      label: "Ground recon here",
      icon: "walk",
      sep: true,
      run: () => useGround.getState().openAt({ lat, lon, radiusKm: 2 }),
    },
    {
      label: "Imagery diff here",
      icon: "comparison",
      run: () => useImageryDiff.getState().openAt({ lat, lon }),
    },
    {
      label: "AI assess this location",
      icon: "predictive-analysis",
      run: () =>
        useAgent
          .getState()
          .ask(
            `Assess the location at ${lat.toFixed(4)}, ${lon.toFixed(4)}: what is here, notable activity, and risks?`,
          ),
    },
    {
      label: "Add annotation",
      icon: "annotation",
      run: () =>
        useAnnotations.getState().add({
          kind: "point",
          threat: "unknown",
          label: "Marker",
          coords: [[lon, lat]],
        }),
    },
    {
      label: "Create situation here",
      icon: "flag",
      run: async () => {
        const id = await useSituations.getState().create({
          name: `Situation ${lat.toFixed(1)},${lon.toFixed(1)}`,
          centroid: { lat, lon },
        });
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
      run: () =>
        useGeoScope
          .getState()
          .setScope({ lat, lon, radiusKm: searchRadius, label: "map area" }),
    },
    {
      label: "Collect imagery (centre)",
      run: () =>
        useChip.getState().setFocus({
          entityId: `aoi:${lat.toFixed(3)},${lon.toFixed(3)}`,
          lat,
          lon,
          radiusKm: imageryRadius,
        }),
    },
    {
      label: "Ground recon (centre)",
      run: () => useGround.getState().openAt({ lat, lon, radiusKm: 2 }),
    },
    {
      label: "Imagery diff (centre)",
      run: () => useImageryDiff.getState().openAt({ lat, lon }),
    },
    {
      label: "AI assess this area",
      run: () =>
        useAgent
          .getState()
          .ask(
            `Assess the map area bounded by ${boundsLabel} (~${Math.round(a.areaKm2).toLocaleString()} km²): what is inside it, notable activity, and risks?`,
          ),
    },
    {
      label: "Create watchbox over box",
      run: () =>
        useWatchboxes.getState().add({
          label: `Watchbox ${lat.toFixed(1)},${lon.toFixed(1)}`,
          center: { lat, lon },
          radiusKm: searchRadius,
          rule: "enter",
        }),
    },
    {
      label: "Alert me about this box",
      run: () =>
        useAlertDraft.getState().open({
          label: `Area ${lat.toFixed(2)}, ${lon.toFixed(2)}`,
          lat,
          lon,
          radius_nm: Math.max(1, Math.round(a.radiusKm / KM_PER_NM)),
        }),
    },
    {
      label: "Create situation here",
      run: async () => {
        const id = await useSituations.getState().create({
          name: `AOI ${lat.toFixed(1)},${lon.toFixed(1)}`,
          centroid: { lat, lon },
        });
        useSelection.getState().select(id);
      },
    },
    {
      label: "Copy bounds",
      run: () =>
        navigator.clipboard?.writeText(
          `${a.south.toFixed(5)},${a.west.toFixed(5)},${a.north.toFixed(5)},${a.east.toFixed(5)}`,
        ),
    },
  ];
}
