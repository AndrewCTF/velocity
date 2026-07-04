import * as Cesium from 'cesium';
import { create } from 'zustand';
import { useSelection } from '../state/stores.js';

// Sensor fog-of-war spotlight that follows the selected sim drone.
//
// A wide dark "fog" polygon is drawn around the drone with a CIRCULAR HOLE
// punched at the drone's live position (PolygonHierarchy holes), revealing the
// basemap inside the sensor footprint and darkening everything outside — the
// Palantir-style "spotlight on the ground that follows the drone" the operator
// asked for. A bright ring marks the footprint edge.
//
// The hole + ring track the drone every frame via a CallbackProperty reading
// the live entity position (the same pattern as selectionReticle/selectionTrack),
// so it stays glued to the real loiter orbit with no synthesised motion.
//
// The FMV "SENSOR" toggle drives `enabled`; nothing renders until a sim drone is
// selected AND the sensor is on, so the world view is untouched by default.

interface SpotlightState {
  enabled: boolean;
  radiusKm: number; // notional sensor footprint radius
  setEnabled: (b: boolean) => void;
  toggle: () => void;
  setRadiusKm: (km: number) => void;
}

export const useSpotlight = create<SpotlightState>((set) => ({
  enabled: false,
  radiusKm: 2.5,
  setEnabled: (b) => set({ enabled: b }),
  toggle: () => set((s) => ({ enabled: !s.enabled })),
  setRadiusKm: (km) => set({ radiusKm: Math.max(0.25, Math.min(50, km)) }),
}));

const FOG = Cesium.Color.fromCssColorString('#05070b').withAlpha(0.66);
const RING = Cesium.Color.fromCssColorString('#7dd3fc');
// Fog half-extent around the drone (deg). ~12° (~1300 km) blankets the screen at
// the zoom an operator watches a drone from; a screen-filling box avoids the
// antimeridian/pole artefacts a single global polygon would hit.
const BOX_DEG = 12;

function circlePositions(
  lat: number,
  lon: number,
  radiusKm: number,
  n = 96,
): Cesium.Cartesian3[] {
  const flat: number[] = [];
  const dLatDeg = radiusKm / 110.574;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const dLonDeg = radiusKm / (111.32 * cosLat);
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    flat.push(lon + dLonDeg * Math.sin(th), lat + dLatDeg * Math.cos(th));
  }
  return Cesium.Cartesian3.fromDegreesArray(flat);
}

function boxPositions(lat: number, lon: number, half = BOX_DEG): Cesium.Cartesian3[] {
  // Clamp the centre so the box never crosses a pole (Cesium polygon edges go
  // haywire past ±90°); the hole stays at the true drone latitude regardless.
  const c = Math.min(85 - half, Math.max(-85 + half, lat));
  const w = lon - half;
  const e = lon + half;
  const s = c - half;
  const nn = c + half;
  return Cesium.Cartesian3.fromDegreesArray([w, s, e, s, e, nn, w, nn]);
}

export function installSpotlight(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource('__spotlight');
  viewer.dataSources.add(ds);

  let currentId: string | null = null;
  let entityRef: Cesium.Entity | null = null;

  const centerLatLon = (): { lat: number; lon: number } | null => {
    if (!entityRef?.position) return null;
    const pos = entityRef.position.getValue(viewer.clock.currentTime);
    if (!pos) return null;
    const c = Cesium.Cartographic.fromCartesian(pos);
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
    };
  };

  const active = (): boolean =>
    useSpotlight.getState().enabled && entityRef != null && centerLatLon() != null;

  // Fog polygon: wide dark box around the drone, circular hole at the drone,
  // recomputed every frame from the live entity position.
  const hierarchyProp = new Cesium.CallbackProperty(() => {
    const c = centerLatLon();
    if (!c) return new Cesium.PolygonHierarchy([]);
    const r = useSpotlight.getState().radiusKm;
    return new Cesium.PolygonHierarchy(boxPositions(c.lat, c.lon), [
      new Cesium.PolygonHierarchy(circlePositions(c.lat, c.lon, r)),
    ]);
  }, false);

  ds.entities.add({
    id: '__spotlight__fog',
    polygon: {
      hierarchy: hierarchyProp,
      material: new Cesium.ColorMaterialProperty(FOG),
      height: 0,
      show: new Cesium.CallbackProperty(() => active(), false) as unknown as boolean,
    },
  });

  // Bright sensor ring, position glued to the drone via a CallbackPositionProperty.
  const ringPos = new Cesium.CallbackPositionProperty((time, result) => {
    if (!entityRef?.position) return undefined;
    return entityRef.position.getValue(time, result) ?? undefined;
  }, false);
  const radiusMeters = new Cesium.CallbackProperty(
    () => useSpotlight.getState().radiusKm * 1000,
    false,
  );
  ds.entities.add({
    id: '__spotlight__ring',
    position: ringPos,
    ellipse: {
      semiMajorAxis: radiusMeters,
      semiMinorAxis: radiusMeters,
      material: new Cesium.ColorMaterialProperty(RING.withAlpha(0.04)),
      outline: true,
      outlineColor: RING,
      outlineWidth: 2,
      height: 0,
      show: new Cesium.CallbackProperty(() => active(), false) as unknown as boolean,
    },
  });

  const findEntity = (id: string): Cesium.Entity | undefined => {
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const d = viewer.dataSources.get(i);
      if (d.name === '__spotlight') continue;
      const e = d.entities.getById(id);
      if (e) return e;
    }
    return viewer.entities.getById(id);
  };

  const isSimDrone = (e: Cesium.Entity, id: string): boolean => {
    if (!e.position) return false;
    if (id.startsWith('sim:')) return true;
    const k = (
      e.properties as unknown as { kind?: { getValue?: () => unknown } } | undefined
    )?.kind?.getValue?.();
    return typeof k === 'string' && k.startsWith('sim');
  };

  const updateTarget = (id: string | null): void => {
    if (id === currentId) return;
    currentId = id;
    entityRef = null;
    if (id) {
      const t = findEntity(id);
      if (t && isSimDrone(t, id)) entityRef = t;
    }
    viewer.scene.requestRender();
  };

  updateTarget(useSelection.getState().selectedEntityId);
  const unsubSel = useSelection.subscribe((s) => updateTarget(s.selectedEntityId));
  const unsubSpot = useSpotlight.subscribe(() => viewer.scene.requestRender());

  // Drive per-frame tracking under requestRenderMode: while active, ask for a
  // render ~30 fps so the hole + ring stay glued to the moving drone. Also keep
  // trying to resolve the entity if it appears after the selection (sim start).
  let lastPaint = 0;
  let lastResolve = 0;
  const off = viewer.scene.preUpdate.addEventListener(() => {
    if (currentId && !entityRef) {
      const now = performance.now();
      if (now - lastResolve > 250) {
        lastResolve = now;
        const t = findEntity(currentId);
        if (t && isSimDrone(t, currentId)) entityRef = t;
      }
    }
    if (!active()) return;
    const now = performance.now();
    if (now - lastPaint < 33) return;
    lastPaint = now;
    viewer.scene.requestRender();
  });

  return () => {
    unsubSel();
    unsubSpot();
    off();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* gone */
    }
  };
}
