import * as Cesium from 'cesium';
import { useSelection } from '../state/stores.js';
import { tracks, type TrackPoint } from '../intel/tracks.js';

// Magenta/violet polyline through the selected entity's last ~60 positions,
// mirroring the "purple line" flightradar24 draws through a selected flight.
// Reads from the tracks ring buffer (apps/web/src/intel/tracks.ts) — never
// mutates it — and rebuilds a single polyline Entity inside a dedicated
// CustomDataSource so we never collide with feed-owned data sources.
//
// frontend.md §3 — "selected entity trail, accent magenta, no clamp" — drawn
// at the actual altitude so an airliner's track floats above terrain. For
// vessels (all alts ≈ 0) we clamp to ground so the line follows the sea
// surface curvature; for aircraft we keep alt so the line floats with the jet.

// Brighter magenta than the previous #d946ef — more contrast against both
// the dark basemap and the satellite imagery.
const ACCENT = Cesium.Color.fromCssColorString('#ff2bd6').withAlpha(0.95);
const OUTLINE = Cesium.Color.BLACK.withAlpha(0.5);
const REFRESH_MS = 250; // 4 Hz — line appears the moment the 2nd fix lands

// Effectively unlimited — at 200_000 km a viewer would be well past the moon.
// Past values (50_000 km) culled the trail at certain zoom-outs.
const SHOW_RANGE = new Cesium.DistanceDisplayCondition(0, 200_000_000);

export function installSelectionTrack(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource('__selectionTrack');
  viewer.dataSources.add(ds);

  let currentId: string | null = null;
  let outlineEntity: Cesium.Entity | null = null;
  let glowEntity: Cesium.Entity | null = null;
  let seedEntity: Cesium.Entity | null = null;
  let lastLen = 0;

  // Build positions. Returns the positions array and a clamp hint:
  // - if every alt is 0 (vessel feed) → clamp to ground so the line hugs
  //   the curving sea surface
  // - if any alt > 100 m (aircraft) → do not clamp so the line floats at altitude
  // Returns positions for ALL fixes (including the singleton case) — the
  // caller decides whether to draw a polyline (≥2) or a seed circle (1).
  const buildPositions = (id: string): { positions: Cesium.Cartesian3[]; clamp: boolean } => {
    const pts = tracks.get(id);
    if (pts.length === 0) return { positions: [], clamp: false };
    let anyAircraftAlt = false;
    const out = new Array<Cesium.Cartesian3>(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as TrackPoint;
      if (p.alt > 100) anyAircraftAlt = true;
      out[i] = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt);
    }
    return { positions: out, clamp: !anyAircraftAlt };
  };

  const removeSeed = () => {
    if (seedEntity) {
      ds.entities.remove(seedEntity);
      seedEntity = null;
    }
  };

  const removePolylines = () => {
    if (outlineEntity) {
      ds.entities.remove(outlineEntity);
      outlineEntity = null;
    }
    if (glowEntity) {
      ds.entities.remove(glowEntity);
      glowEntity = null;
    }
    lastLen = 0;
  };

  const renderTrack = (id: string | null) => {
    if (!id) {
      removePolylines();
      removeSeed();
      viewer.scene.requestRender();
      return;
    }
    const { positions, clamp } = buildPositions(id);
    if (positions.length === 0) {
      // Nothing yet — entity hasn't reported a single fix to the ring buffer.
      // Could happen if the user clicks something the moment it appears.
      removePolylines();
      removeSeed();
      return;
    }
    if (positions.length === 1) {
      // Single-point placeholder: a small magenta circle at the only known
      // fix. Replaced by the polyline as soon as a 2nd fix lands. Gives the
      // user immediate visual feedback that the selection is being tracked.
      removePolylines();
      const onlyPos = positions[0]!;
      if (!seedEntity) {
        seedEntity = ds.entities.add({
          id: '__selectionTrack__seed',
          position: onlyPos,
          point: {
            color: ACCENT,
            pixelSize: 12,
            outlineColor: OUTLINE,
            outlineWidth: 2,
            heightReference: clamp ? Cesium.HeightReference.CLAMP_TO_GROUND : Cesium.HeightReference.NONE,
            distanceDisplayCondition: SHOW_RANGE,
          },
        });
      } else {
        seedEntity.position = new Cesium.ConstantPositionProperty(onlyPos);
      }
      lastLen = 1;
      viewer.scene.requestRender();
      return;
    }
    // ≥2 points — draw the trail polyline and drop any seed circle.
    removeSeed();
    if (!outlineEntity) {
      // Dark, slightly wider polyline UNDER the glow line, so the magenta
      // trail stays readable against bright basemap pixels (clouds, daylight).
      outlineEntity = ds.entities.add({
        id: '__selectionTrack__outline',
        polyline: {
          positions: new Cesium.CallbackProperty(() => positions, false),
          width: 7,
          material: new Cesium.ColorMaterialProperty(OUTLINE),
          clampToGround: clamp,
          arcType: Cesium.ArcType.GEODESIC,
          distanceDisplayCondition: SHOW_RANGE,
        },
      });
    } else if (outlineEntity.polyline) {
      outlineEntity.polyline.positions = new Cesium.ConstantProperty(positions);
      outlineEntity.polyline.clampToGround = new Cesium.ConstantProperty(clamp);
    }
    if (!glowEntity) {
      glowEntity = ds.entities.add({
        id: '__selectionTrack__',
        polyline: {
          positions: new Cesium.CallbackProperty(() => positions, false),
          width: 5,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: ACCENT,
            glowPower: 0.25,
            taperPower: 1.0,
          }),
          clampToGround: clamp,
          arcType: Cesium.ArcType.GEODESIC,
          distanceDisplayCondition: SHOW_RANGE,
        },
      });
    } else if (glowEntity.polyline) {
      glowEntity.polyline.positions = new Cesium.ConstantProperty(positions);
      glowEntity.polyline.clampToGround = new Cesium.ConstantProperty(clamp);
    }
    lastLen = positions.length;
    viewer.scene.requestRender();
  };

  // Initial sync + selection subscription.
  const onSelect = (id: string | null) => {
    if (id === currentId) return;
    currentId = id;
    lastLen = 0;
    renderTrack(id);
  };
  onSelect(useSelection.getState().selectedEntityId);
  const unsub = useSelection.subscribe((s) => onSelect(s.selectedEntityId));

  // 4 Hz re-poll so the polyline appears as soon as a 2nd fix lands.
  const timer = window.setInterval(() => {
    if (!currentId) return;
    const len = tracks.get(currentId).length;
    if (len !== lastLen) renderTrack(currentId);
  }, REFRESH_MS);

  return () => {
    window.clearInterval(timer);
    unsub();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* gone */
    }
  };
}
