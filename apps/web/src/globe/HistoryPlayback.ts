import * as Cesium from 'cesium';
import { aircraftStyle, vesselStyle } from './adapters/styles.js';
import { labelFor } from './adapters/labelStyle.js';
import { apiFetch } from '../transport/http.js';

// Historical playback — scrub/replay recorded aircraft + vessel tracks in 3D.
//
// Reads the backend SQLite position store (/api/history/tracks) for the current
// camera view + a time window, builds one moving billboard per track driven by
// a SampledPositionProperty, and animates the Cesium clock across the window.
//
// Guardrails honoured (CLAUDE.md):
//  - Icons: replay markers reuse aircraftStyle / vesselStyle, so every contact
//    is its category SVG (never a bare point), rotated by track/cog.
//  - requestRenderMode STAYS true. We do NOT flip it off. Instead, while a
//    replay is active we lower scene.maximumRenderTimeChange so Cesium renders
//    as simulation time advances; clear() restores it to Infinity, returning
//    the scene to its on-demand default.
//  - Interpolation uses LinearApproximation, matching the live adapter.

interface Track {
  id: string;
  kind: string; // 'aircraft' | 'vessel'
  points: [number, number, number, number][]; // [lon, lat, t(seconds), track_deg]
}
interface TracksResponse {
  tracks: Track[];
}

export interface PlaybackInfo {
  tracks: number;
  points: number;
  from: number; // epoch seconds
  to: number;
}

export interface PlaybackController {
  load(windowSec: number): Promise<PlaybackInfo | null>;
  clear(): void;
  isActive(): boolean;
  destroy(): void;
}

const AIR_TRAIL = Cesium.Color.fromCssColorString('#facc15').withAlpha(0.55);
const SEA_TRAIL = Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.55);

function julian(seconds: number): Cesium.JulianDate {
  return Cesium.JulianDate.fromDate(new Date(seconds * 1000));
}

export function installHistoryPlayback(viewer: Cesium.Viewer): PlaybackController {
  const ds = new Cesium.CustomDataSource('history-replay');
  void viewer.dataSources.add(ds);
  let hiddenLive: Cesium.DataSource[] = [];
  let active = false;

  // Hide every other (live) data source so the replay reads cleanly; remember
  // exactly which we hid so clear() restores them and nothing else.
  function hideLive(): void {
    hiddenLive = [];
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const d = viewer.dataSources.get(i);
      if (d === ds || !d.show) continue;
      d.show = false;
      hiddenLive.push(d);
    }
  }
  function restoreLive(): void {
    for (const d of hiddenLive) d.show = true;
    hiddenLive = [];
  }

  function buildTrackEntity(tr: Track, windowSec: number): number {
    const spp = new Cesium.SampledPositionProperty();
    spp.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    spp.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    spp.setInterpolationOptions({
      interpolationAlgorithm: Cesium.LinearApproximation,
      interpolationDegree: 1,
    });
    let added = 0;
    let lastTrackDeg = 0;
    for (const [lon, lat, t, trackDeg] of tr.points) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      spp.addSample(julian(t), Cesium.Cartesian3.fromDegrees(lon, lat));
      lastTrackDeg = trackDeg ?? 0;
      added++;
    }
    if (added === 0) return 0;

    const isAir = tr.kind === 'aircraft';
    const style = isAir
      ? aircraftStyle({ track_deg: lastTrackDeg })
      : vesselStyle({ cog: lastTrackDeg });
    const billboard: Cesium.BillboardGraphics.ConstructorOptions = {
      image: style.imageUri,
      scale: style.scale,
      rotation: style.rotationRad,
      alignedAxis: Cesium.Cartesian3.UNIT_Z,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
    };
    const labelText = isAir ? tr.id.replace(/^aircraft:/, '') : tr.id.replace(/^vessel:/, '');

    ds.entities.add({
      id: `hist:${tr.id}`,
      position: spp,
      billboard,
      label: labelFor(labelText),
      path: {
        material: new Cesium.ColorMaterialProperty(isAir ? AIR_TRAIL : SEA_TRAIL),
        width: 2,
        leadTime: 0,
        trailTime: windowSec,
        resolution: 30,
      },
    });
    return added;
  }

  async function load(windowSec: number): Promise<PlaybackInfo | null> {
    const now = Date.now() / 1000;
    const from = now - windowSec;
    const to = now;

    let bboxQ = '';
    const rect = viewer.camera.computeViewRectangle();
    if (rect) {
      const w = Cesium.Math.toDegrees(rect.west);
      const s = Cesium.Math.toDegrees(rect.south);
      const e = Cesium.Math.toDegrees(rect.east);
      const n = Cesium.Math.toDegrees(rect.north);
      bboxQ = `&min_lon=${w}&min_lat=${s}&max_lon=${e}&max_lat=${n}`;
    }

    let data: TracksResponse;
    try {
      const r = await apiFetch(
        `/api/history/tracks?from_ts=${from}&to_ts=${to}&limit_ids=2000${bboxQ}`,
      );
      if (!r.ok) return null;
      data = (await r.json()) as TracksResponse;
    } catch {
      return null;
    }

    ds.entities.removeAll();
    let pts = 0;
    for (const tr of data.tracks ?? []) {
      pts += buildTrackEntity(tr, windowSec);
    }

    // Drive the clock across the window. The Timeline's existing play/speed
    // controls keep working (they set shouldAnimate + multiplier).
    viewer.clock.startTime = julian(from);
    viewer.clock.stopTime = julian(to);
    viewer.clock.currentTime = julian(from);
    viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
    viewer.clock.shouldAnimate = true;
    // requestRenderMode stays true; this just lets time advancement trigger
    // renders so the replay actually animates.
    viewer.scene.maximumRenderTimeChange = 0.2;

    hideLive();
    active = true;
    viewer.scene.requestRender();
    return { tracks: (data.tracks ?? []).length, points: pts, from, to };
  }

  function clear(): void {
    ds.entities.removeAll();
    restoreLive();
    // Return the clock + render policy to their live defaults.
    viewer.clock.clockRange = Cesium.ClockRange.UNBOUNDED;
    viewer.clock.currentTime = Cesium.JulianDate.now();
    viewer.clock.shouldAnimate = true;
    viewer.scene.maximumRenderTimeChange = Infinity;
    active = false;
    viewer.scene.requestRender();
  }

  function destroy(): void {
    if (active) clear();
    viewer.dataSources.remove(ds, true);
  }

  return { load, clear, isActive: () => active, destroy };
}
