import * as Cesium from 'cesium';
import { useSelection } from '../state/stores.js';
import { tracks, type TrackPoint } from '../intel/tracks.js';
import { apiFetch } from '../transport/http.js';

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

// CLAUDE.md operator-visible spec: selection magenta polyline #d946ef
// width 4 + black outline width 6. Do not "brighten" without updating the
// guardrail doc — past drift here shipped an off-spec #ff2bd6/5/7 combo.
const ACCENT = Cesium.Color.fromCssColorString('#d946ef').withAlpha(0.95);
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

  // STABLE positions array. The polylines read it via a CallbackProperty, so we
  // mutate it IN PLACE every fix and never reassign the polyline.positions
  // property — replacing the property with a fresh ConstantProperty each update
  // (the old behaviour) made Cesium destroy + rebuild the polyline primitive,
  // which is exactly the "trail flashes on every new position" the operator saw.
  const livePositions: Cesium.Cartesian3[] = [];
  let liveClamp = false; // set once when the polyline is created (homogeneous track)

  // Full recent flight trail fetched once on selection (tar1090 trace_full via
  // /api/adsb/trace). The client ring only accumulates positions since the page
  // opened (≤60 points) — short and slow to fill — so we seed the polyline with
  // the real flight history and let the live ring extend its tail.
  let historical: TrackPoint[] = [];
  let fetchToken = 0;

  const loadHistorical = async (id: string, token: number): Promise<void> => {
    if (!id.startsWith('aircraft:')) return; // only aircraft have a trace upstream
    const icao = id.slice('aircraft:'.length);
    try {
      const r = await apiFetch(`/api/adsb/trace/${encodeURIComponent(icao)}`);
      if (!r.ok) return;
      const b = (await r.json()) as { points?: { t: number; lon: number; lat: number; alt_m: number }[] };
      if (token !== fetchToken) return; // selection changed while we were fetching
      historical = (b.points ?? []).map((p) => ({ t: p.t, lon: p.lon, lat: p.lat, alt: p.alt_m }));
      renderTrack(id);
    } catch {
      /* keep the live-only trail */
    }
  };

  // Refill livePositions in place from the historical trace + the live ring's
  // newer tail; returns the point count.
  const rebuild = (id: string): number => {
    const ring = tracks.get(id) as TrackPoint[];
    const lastHistT = historical.length ? historical[historical.length - 1]!.t : -Infinity;
    const tail = historical.length ? ring.filter((p) => p.t > lastHistT) : ring;
    const merged = historical.length ? [...historical, ...tail] : ring;
    livePositions.length = 0;
    let anyAircraftAlt = false;
    for (const p of merged) {
      if (p.alt > 100) anyAircraftAlt = true;
      livePositions.push(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt));
    }
    if (merged.length > 0) liveClamp = !anyAircraftAlt;
    return merged.length;
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
  };

  const renderTrack = (id: string | null) => {
    if (!id) {
      removePolylines();
      removeSeed();
      viewer.scene.requestRender();
      return;
    }
    const n = rebuild(id);
    if (n === 0) {
      removePolylines();
      removeSeed();
      return;
    }
    if (n === 1) {
      // Single-point placeholder until a 2nd fix lands. Mutate the seed in
      // place too (ConstantPositionProperty on a point primitive is cheap and
      // doesn't rebuild a line).
      removePolylines();
      const onlyPos = livePositions[0]!;
      if (!seedEntity) {
        seedEntity = ds.entities.add({
          id: '__selectionTrack__seed',
          position: new Cesium.ConstantPositionProperty(onlyPos),
          point: {
            color: ACCENT,
            pixelSize: 12,
            outlineColor: OUTLINE,
            outlineWidth: 2,
            heightReference: liveClamp
              ? Cesium.HeightReference.CLAMP_TO_GROUND
              : Cesium.HeightReference.NONE,
            distanceDisplayCondition: SHOW_RANGE,
          },
        });
      } else {
        (seedEntity.position as Cesium.ConstantPositionProperty).setValue(onlyPos);
      }
      viewer.scene.requestRender();
      return;
    }
    // ≥2 points. Create the polylines ONCE (CallbackProperty reads the live
    // array every frame); on later fixes we only requestRender — the array was
    // already mutated by rebuild() above, so no property is reassigned and the
    // primitive is updated, not recreated. No flash.
    removeSeed();
    if (!outlineEntity) {
      outlineEntity = ds.entities.add({
        id: '__selectionTrack__outline',
        polyline: {
          positions: new Cesium.CallbackProperty(() => livePositions, false),
          width: 6,
          material: new Cesium.ColorMaterialProperty(OUTLINE),
          clampToGround: liveClamp,
          arcType: Cesium.ArcType.GEODESIC,
          distanceDisplayCondition: SHOW_RANGE,
        },
      });
    }
    if (!glowEntity) {
      glowEntity = ds.entities.add({
        id: '__selectionTrack__',
        polyline: {
          positions: new Cesium.CallbackProperty(() => livePositions, false),
          width: 4,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: ACCENT,
            glowPower: 0.25,
            taperPower: 1.0,
          }),
          clampToGround: liveClamp,
          arcType: Cesium.ArcType.GEODESIC,
          distanceDisplayCondition: SHOW_RANGE,
        },
      });
    }
    viewer.scene.requestRender();
  };

  // Initial sync + selection subscription. On a NEW selection, drop the old
  // primitives so the fresh track doesn't inherit the previous flight's clamp.
  const onSelect = (id: string | null) => {
    if (id === currentId) return;
    currentId = id;
    historical = [];
    fetchToken++;
    removePolylines();
    removeSeed();
    renderTrack(id);
    if (id) void loadHistorical(id, fetchToken);
  };
  onSelect(useSelection.getState().selectedEntityId);
  const unsub = useSelection.subscribe((s) => onSelect(s.selectedEntityId));

  // 4 Hz re-render so the trail follows the live fixes (and keeps following
  // even once the ring buffer is full at MAX_POINTS — length stops growing but
  // the contents still shift, so a length check alone would freeze the trail).
  const timer = window.setInterval(() => {
    if (currentId) renderTrack(currentId);
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
