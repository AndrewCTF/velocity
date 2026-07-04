import * as Cesium from 'cesium';
import { create } from 'zustand';
import { useSelection } from '../state/stores.js';

// Field-of-view footprint for the selected satellite or aircraft, with optional
// boresight lines from the platform down to the footprint edge.
//
//  - SATELLITE FOV is REAL geometry: ground footprint radius = altitude *
//    tan(halfAngle) at a nominal sensor half-angle. (Flat-Earth approximation —
//    a slight under-estimate at the limb, honest enough for "how wide is it".)
//  - AIRCRAFT FOV is NOTIONAL: a downward camera cone at a notional half-angle,
//    labelled NOTIONAL so it never reads as a real sensor cut.
//
// Altitude comes straight from the entity's live position height, so this works
// for any selected platform without extra metadata, and the platform is told
// apart by properties.kind === 'satellite' (fallback: height > 80 km).

interface FovState {
  enabled: boolean; // footprint area
  lines: boolean; // boresight lines
  setEnabled: (b: boolean) => void;
  toggle: () => void;
  setLines: (b: boolean) => void;
}

export const useFov = create<FovState>((set) => ({
  enabled: false,
  lines: true,
  setEnabled: (b) => set({ enabled: b }),
  toggle: () => set((s) => ({ enabled: !s.enabled })),
  setLines: (b) => set({ lines: b }),
}));

// Nominal sensor half-angles (deg). Satellite is a real access cone; aircraft is
// a notional camera cone.
const SAT_HALF_DEG = 5;
const AIR_HALF_DEG = 20;
const SAT_FILL = Cesium.Color.fromCssColorString('#7dd3fc'); // cyan — real
const AIR_FILL = Cesium.Color.fromCssColorString('#f59e0b'); // amber — notional
const N_LINES = 8;

interface Footprint {
  sub: Cesium.Cartesian3; // ground point under the platform (h=0)
  platform: Cesium.Cartesian3; // platform 3D position
  radiusM: number;
  lat: number;
  lon: number;
  isSat: boolean;
}

function destPoint(lat: number, lon: number, rKm: number, th: number): Cesium.Cartesian3 {
  const dLatDeg = (rKm / 110.574) * Math.cos(th);
  const dLonDeg = (rKm / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))) * Math.sin(th);
  return Cesium.Cartesian3.fromDegrees(lon + dLonDeg, lat + dLatDeg, 0);
}

export function installFov(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource('__fov');
  viewer.dataSources.add(ds);

  let entityRef: Cesium.Entity | null = null;
  let currentId: string | null = null;

  const isSatEntity = (e: Cesium.Entity, heightM: number): boolean => {
    const k = (
      e.properties as unknown as { kind?: { getValue?: () => unknown } } | undefined
    )?.kind?.getValue?.();
    if (typeof k === 'string') return k === 'satellite';
    return heightM > 80_000;
  };

  // Live footprint computed from the selected entity's current position.
  const footprint = (): Footprint | null => {
    if (!entityRef?.position) return null;
    const pos = entityRef.position.getValue(viewer.clock.currentTime);
    if (!pos) return null;
    const c = Cesium.Cartographic.fromCartesian(pos);
    const lat = Cesium.Math.toDegrees(c.latitude);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const isSat = isSatEntity(entityRef, c.height);
    const half = ((isSat ? SAT_HALF_DEG : AIR_HALF_DEG) * Math.PI) / 180;
    const radiusM = Math.max(500, c.height * Math.tan(half));
    return {
      sub: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      platform: pos,
      radiusM,
      lat,
      lon,
      isSat,
    };
  };

  const active = (): boolean => useFov.getState().enabled && footprint() != null;
  const fillFor = (isSat: boolean): Cesium.Color => (isSat ? SAT_FILL : AIR_FILL);

  // Footprint disc on the ground, glued to the sub-satellite/sub-aircraft point.
  const subPos = new Cesium.CallbackPositionProperty(() => footprint()?.sub, false);
  const radius = new Cesium.CallbackProperty(() => footprint()?.radiusM ?? 0, false);
  ds.entities.add({
    id: '__fov__disc',
    position: subPos,
    ellipse: {
      semiMajorAxis: radius,
      semiMinorAxis: radius,
      material: new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty(() => {
          const f = footprint();
          return fillFor(f?.isSat ?? true).withAlpha(0.14);
        }, false),
      ),
      outline: true,
      outlineColor: new Cesium.CallbackProperty(
        () => fillFor(footprint()?.isSat ?? true),
        false,
      ) as unknown as Cesium.Color,
      outlineWidth: 2,
      height: 0,
      show: new Cesium.CallbackProperty(() => active(), false) as unknown as boolean,
    },
    label: {
      text: new Cesium.CallbackProperty(() => {
        const f = footprint();
        if (!f) return '';
        const km = (f.radiusM / 1000) * 2;
        const half = f.isSat ? SAT_HALF_DEG : AIR_HALF_DEG;
        return f.isSat
          ? `FOV ≈ ${km.toFixed(0)} km (nominal ${half}°)`
          : `FOV ≈ ${km.toFixed(1)} km (NOTIONAL ${half}° cam)`;
      }, false) as unknown as string,
      font: 'bold 11px "IBM Plex Mono", monospace',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString('#05070b'),
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#05070b').withAlpha(0.7),
      pixelOffset: new Cesium.Cartesian2(0, -16),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      // Depth-tested so the globe occludes the FOV label on the far side
      // instead of it bleeding through the opposite hemisphere.
      show: new Cesium.CallbackProperty(() => active(), false) as unknown as boolean,
    },
  });

  // Boresight lines: platform → N points on the footprint edge. Toggle separately.
  const linesActive = (): boolean => active() && useFov.getState().lines;
  for (let i = 0; i < N_LINES; i++) {
    const th = (i / N_LINES) * Math.PI * 2;
    ds.entities.add({
      id: `__fov__line_${i}`,
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const f = footprint();
          if (!f) return [];
          return [f.platform, destPoint(f.lat, f.lon, f.radiusM / 1000, th)];
        }, false),
        width: 1.5,
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(
            () => fillFor(footprint()?.isSat ?? true).withAlpha(0.6),
            false,
          ),
        ),
        arcType: Cesium.ArcType.NONE,
        show: new Cesium.CallbackProperty(() => linesActive(), false) as unknown as boolean,
      },
    });
  }

  const findEntity = (id: string): Cesium.Entity | undefined => {
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const d = viewer.dataSources.get(i);
      if (d.name === '__fov') continue;
      const e = d.entities.getById(id);
      if (e) return e;
    }
    return viewer.entities.getById(id);
  };

  const updateTarget = (id: string | null): void => {
    if (id === currentId) return;
    currentId = id;
    entityRef = id ? findEntity(id) ?? null : null;
    viewer.scene.requestRender();
  };

  updateTarget(useSelection.getState().selectedEntityId);
  const unsubSel = useSelection.subscribe((s) => updateTarget(s.selectedEntityId));
  const unsubFov = useFov.subscribe(() => viewer.scene.requestRender());

  // Keep the footprint glued to a moving platform under requestRenderMode.
  let lastPaint = 0;
  let lastResolve = 0;
  const off = viewer.scene.preUpdate.addEventListener(() => {
    if (currentId && !entityRef) {
      const now = performance.now();
      if (now - lastResolve > 250) {
        lastResolve = now;
        entityRef = findEntity(currentId) ?? null;
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
    unsubFov();
    off();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* gone */
    }
  };
}
