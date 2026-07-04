import * as Cesium from 'cesium';
import { create } from 'zustand';
import { useSelection } from '../state/stores.js';
import { reachableRing, destinationPoint, KN_TO_KMH } from './projection.js';

// Route-projection overlay — the "Project ship location" decision-support layer.
//
// Draws REACHABLE-AREA rings (+1h / +3h / +6h) from an entity's LAST REAL FIX and
// reported speed. These are dashed amber rings on their OWN data source, computed
// ONCE (static — they do NOT advance with the clock) and cleared on deselect.
//
// GUARDRAIL (operator anti-dead-reckoning rule): this never touches the live
// entity, its position, the selection polyline, or tracks.ts/history. It is a
// labelled "where could it be" projection, NOT synthesised observed motion, so it
// can never be mistaken for a track. See CLAUDE.md.

const AMBER = Cesium.Color.fromCssColorString('#f59e0b');
const HOURS = [1, 3, 6] as const;

interface ProjectionState {
  entityId: string | null;
  lat: number;
  lon: number;
  speedKn: number;
  cog: number | null; // course over ground (deg), if known
  show: boolean;
  project: (p: { entityId: string; lat: number; lon: number; speedKn: number; cog?: number | null }) => void;
  clear: () => void;
}

export const useProjection = create<ProjectionState>((set) => ({
  entityId: null,
  lat: 0,
  lon: 0,
  speedKn: 0,
  cog: null,
  show: false,
  project: (p) =>
    set({ entityId: p.entityId, lat: p.lat, lon: p.lon, speedKn: p.speedKn, cog: p.cog ?? null, show: true }),
  clear: () => set({ show: false, entityId: null }),
}));

export function installProjection(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource('__projection');
  viewer.dataSources.add(ds);

  const rebuild = (): void => {
    ds.entities.removeAll();
    const s = useProjection.getState();
    if (!s.show || s.speedKn <= 0) {
      viewer.scene.requestRender();
      return;
    }
    for (const h of HOURS) {
      const radiusKm = s.speedKn * KN_TO_KMH * h;
      const ring = reachableRing(s.lat, s.lon, radiusKm);
      ds.entities.add({
        id: `__projection__ring_${h}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(ring),
          width: 2,
          material: new Cesium.PolylineDashMaterialProperty({
            color: AMBER.withAlpha(0.9),
            dashLength: 14,
          }),
          clampToGround: false,
        },
      });
      // Label the ring at its northern edge.
      const top = destinationPoint(s.lat, s.lon, 0, radiusKm);
      ds.entities.add({
        id: `__projection__lbl_${h}`,
        position: Cesium.Cartesian3.fromDegrees(top.lon, top.lat),
        label: {
          text: `+${h}h PROJECTED`,
          font: '600 10px "IBM Plex Mono", monospace',
          fillColor: AMBER,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.6),
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -2),
          // Depth-tested so the globe occludes a far-side projection label
          // rather than bleeding it through the opposite hemisphere.
        },
      });
    }
    // Heading ray to the +6h reachable edge, if a course is known.
    if (s.cog != null) {
      const far = destinationPoint(s.lat, s.lon, s.cog, s.speedKn * KN_TO_KMH * 6);
      ds.entities.add({
        id: '__projection__cog',
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray([s.lon, s.lat, far.lon, far.lat]),
          width: 1.5,
          material: new Cesium.PolylineDashMaterialProperty({ color: AMBER.withAlpha(0.5), dashLength: 8 }),
        },
      });
    }
    viewer.scene.requestRender();
  };

  rebuild();
  const unsubProj = useProjection.subscribe(rebuild);
  // Clear the projection when the selection moves off the projected entity (so a
  // stale "where could it be" ring never lingers over a different selection).
  const unsubSel = useSelection.subscribe((sel) => {
    const p = useProjection.getState();
    if (p.show && p.entityId && sel.selectedEntityId !== p.entityId) p.clear();
  });

  return () => {
    unsubProj();
    unsubSel();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* gone */
    }
  };
}
