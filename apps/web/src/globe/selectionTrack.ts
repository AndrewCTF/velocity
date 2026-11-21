import * as Cesium from "cesium";
import { useSelection } from "../state/stores.js";
import { tracks, type TrackPoint } from "../intel/tracks.js";
import { apiFetch } from "../transport/http.js";
import { findEntity, readProperties } from "../entity-panel/read.js";

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
const ACCENT = Cesium.Color.fromCssColorString("#d946ef").withAlpha(0.95);
const OUTLINE = Cesium.Color.BLACK.withAlpha(0.5);
const REFRESH_MS = 250; // 4 Hz — line appears the moment the 2nd fix lands

// Effectively unlimited — at 200_000 km a viewer would be well past the moon.
// Past values (50_000 km) culled the trail at certain zoom-outs.
const SHOW_RANGE = new Cesium.DistanceDisplayCondition(0, 200_000_000);

// D89: the trace's recorded fixes are dotted every 11th point and the live end
// carries a callsign chip, as the saved-map frame draws the ADS-B trace. The
// dots ride the same historical trace the polyline is seeded from, so they
// vanish with the selection like the line does.
export const TRACE_DOT_STEP = 11;

/** Indices of the recorded fixes the copy dots (every 11th trace point). */
export function traceDotIndices(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += TRACE_DOT_STEP) out.push(i);
  return out;
}

const DOT_COLOR = Cesium.Color.fromCssColorString("#2d8fdf");

/** Chip text for the trace end: callsign, then registration, then ICAO24. */
export function traceChipText(props: {
  callsign?: string | null | undefined;
  registration?: string | null | undefined;
  icao24?: string | null | undefined;
  fallback: string;
}): string {
  for (const v of [props.callsign, props.registration, props.icao24]) {
    const t = (v ?? "").trim();
    if (t) return t;
  }
  return props.fallback;
}

export function installSelectionTrack(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource("__selectionTrack");
  viewer.dataSources.add(ds);

  let currentId: string | null = null;
  let outlineEntity: Cesium.Entity | null = null;
  let glowEntity: Cesium.Entity | null = null;
  let seedEntity: Cesium.Entity | null = null;
  let dotEntities: Cesium.Entity[] = [];
  let chipEntity: Cesium.Entity | null = null;
  // The trace array the dots were built from; redraw only when the merged
  // trail's identity changes (new selection, or the historical fetch landing).
  let dotsFor: TrackPoint[] | null = null;

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
    if (!id.startsWith("aircraft:")) return; // only aircraft have a trace upstream
    const icao = id.slice("aircraft:".length);
    try {
      const r = await apiFetch(`/api/adsb/trace/${encodeURIComponent(icao)}`);
      if (!r.ok) return;
      const b = (await r.json()) as {
        points?: { t: number; lon: number; lat: number; alt_m: number }[];
      };
      if (token !== fetchToken) return; // selection changed while we were fetching
      historical = (b.points ?? []).map((p) => ({
        t: p.t,
        lon: p.lon,
        lat: p.lat,
        alt: p.alt_m,
      }));
      renderTrack(id);
    } catch {
      /* keep the live-only trail */
    }
  };

  // Refill livePositions in place from the historical trace + the live ring's
  // newer tail; returns the point count.
  const rebuild = (id: string): number => {
    const ring = tracks.get(id) as TrackPoint[];
    const lastHistT = historical.length
      ? historical[historical.length - 1]!.t
      : -Infinity;
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

  // The merged trail the polyline is drawn from. Dots and the end chip read
  // the same array so they can never show a different flight than the line.
  const mergedTrail = (id: string): TrackPoint[] => {
    const ring = tracks.get(id) as TrackPoint[];
    if (!historical.length) return ring;
    const lastHistT = historical[historical.length - 1]!.t;
    return [...historical, ...ring.filter((p) => p.t > lastHistT)];
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

  const removeTraceMarks = () => {
    for (const e of dotEntities) ds.entities.remove(e);
    dotEntities = [];
    if (chipEntity) {
      ds.entities.remove(chipEntity);
      chipEntity = null;
    }
    dotsFor = null;
  };

  // D89: waypoint dots on every 11th recorded fix plus a callsign chip on the
  // live end, both for the selected aircraft's trace. Dots are static points
  // rebuilt only when the merged trail's identity changes; the chip reads the
  // live entity's callsign and follows the newest fix through the same stable
  // positions array the polyline reads.
  const syncTraceMarks = (id: string): void => {
    if (!id.startsWith("aircraft:")) return;
    const trail = mergedTrail(id);
    if (trail.length < 2) return;
    if (dotsFor !== trail) {
      for (const e of dotEntities) ds.entities.remove(e);
      dotEntities = [];
      dotsFor = trail;
      for (const i of traceDotIndices(trail.length)) {
        const p = trail[i]!;
        dotEntities.push(
          ds.entities.add({
            id: `__selectionTrack__dot${i}`,
            position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
            point: {
              color: DOT_COLOR,
              pixelSize: 9,
              outlineColor: OUTLINE,
              outlineWidth: 1,
              heightReference: liveClamp
                ? Cesium.HeightReference.CLAMP_TO_GROUND
                : Cesium.HeightReference.NONE,
              distanceDisplayCondition: SHOW_RANGE,
            },
          }),
        );
      }
    }
    const icao = id.slice("aircraft:".length);
    const live = findEntity(viewer, id);
    const props = live ? readProperties(live) : {};
    const text = traceChipText({
      callsign: props["callsign"] as string | null | undefined,
      registration: props["registration"] as string | null | undefined,
      icao24: props["icao24"] as string | null | undefined,
      fallback: icao.toUpperCase(),
    });
    const endPos = new Cesium.CallbackPositionProperty(
      (_time, result) =>
        result ?? livePositions[livePositions.length - 1]!,
      false,
    );
    if (!chipEntity) {
      chipEntity = ds.entities.add({
        id: "__selectionTrack__chip",
        position: endPos,
        label: {
          text,
          font: '600 13px "Source Sans 3", "Segoe UI", sans-serif',
          fillColor: Cesium.Color.WHITE,
          backgroundColor: Cesium.Color.fromCssColorString("#2d2f33").withAlpha(
            0.85,
          ),
          showBackground: true,
          outlineColor: OUTLINE,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          pixelOffset: new Cesium.Cartesian2(10, 0),
          heightReference: liveClamp
            ? Cesium.HeightReference.CLAMP_TO_GROUND
            : Cesium.HeightReference.NONE,
          distanceDisplayCondition: SHOW_RANGE,
        },
      });
    } else {
      const lbl = chipEntity.label;
      if (lbl && lbl.text instanceof Cesium.ConstantProperty) {
        if (lbl.text.getValue() !== text)
          lbl.text = new Cesium.ConstantProperty(text);
      }
    }
  };

  const renderTrack = (id: string | null) => {
    if (!id) {
      removePolylines();
      removeSeed();
      removeTraceMarks();
      viewer.scene.requestRender();
      return;
    }
    const n = rebuild(id);
    if (n === 0) {
      removePolylines();
      removeSeed();
      removeTraceMarks();
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
          id: "__selectionTrack__seed",
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
        (seedEntity.position as Cesium.ConstantPositionProperty).setValue(
          onlyPos,
        );
      }
      viewer.scene.requestRender();
      return;
    }
    // ≥2 points. Create the polylines ONCE (CallbackProperty reads the live
    // array every frame); on later fixes we only requestRender — the array was
    // already mutated by rebuild() above, so no property is reassigned and the
    // primitive is updated, not recreated. No flash.
    removeSeed();
    syncTraceMarks(id);
    if (!outlineEntity) {
      // ponytail: GEODESIC for ground-clamped vessels (follows the surface);
      // NONE for aircraft at altitude (straight Cartesian lines — segments are
      // short enough that curvature is invisible, and NONE avoids the
      // subdivision-density shift that makes the trail visually jump between
      // zoom levels).
      const arc = liveClamp ? Cesium.ArcType.GEODESIC : Cesium.ArcType.NONE;
      outlineEntity = ds.entities.add({
        id: "__selectionTrack__outline",
        polyline: {
          positions: new Cesium.CallbackProperty(() => livePositions, false),
          width: 6,
          material: new Cesium.ColorMaterialProperty(OUTLINE),
          clampToGround: liveClamp,
          arcType: arc,
          distanceDisplayCondition: SHOW_RANGE,
        },
      });
    }
    if (!glowEntity) {
      const arc = liveClamp ? Cesium.ArcType.GEODESIC : Cesium.ArcType.NONE;
      glowEntity = ds.entities.add({
        id: "__selectionTrack__",
        polyline: {
          positions: new Cesium.CallbackProperty(() => livePositions, false),
          width: 4,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: ACCENT,
            glowPower: 0.25,
            taperPower: 1.0,
          }),
          clampToGround: liveClamp,
          arcType: arc,
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
    removeTraceMarks();
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
