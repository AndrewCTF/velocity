import * as Cesium from 'cesium';
import { aircraftStyle, vesselStyle } from './adapters/styles.js';
import { labelFor } from './adapters/labelStyle.js';
import { apiFetch } from '../transport/http.js';
import { haversineKm } from './draw.js';

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
  load(windowSec: number, onlyId?: string): Promise<PlaybackInfo | null>;
  clear(): void;
  isActive(): boolean;
  destroy(): void;
}

const AIR_TRAIL = Cesium.Color.fromCssColorString('#facc15').withAlpha(0.55);
const SEA_TRAIL = Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.55);
const DWELL = Cesium.Color.fromCssColorString('#d946ef'); // pattern-of-life dwell highlight
const DWELL_KM = 0.6; // cluster radius
const DWELL_S = 240; // min seconds stationary to count as a dwell

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

  // Pattern-of-life dwell clusters: stretches where the entity stayed within
  // DWELL_KM for ≥ DWELL_S get a magenta ring + duration label.
  function addDwellMarkers(tr: Track): void {
    const pts = tr.points;
    let i = 0;
    while (i < pts.length) {
      const [lon0, lat0, t0] = pts[i]!;
      let j = i + 1;
      let sumLon = lon0;
      let sumLat = lat0;
      let cnt = 1;
      while (j < pts.length) {
        const [lon, lat] = pts[j]!;
        if (haversineKm({ lat: lat0, lon: lon0 }, { lat, lon }) > DWELL_KM) break;
        sumLon += lon;
        sumLat += lat;
        cnt++;
        j++;
      }
      const dur = (pts[j - 1]?.[2] ?? t0) - t0;
      if (dur >= DWELL_S && cnt >= 3) {
        ds.entities.add({
          id: `dwell:${tr.id}:${i}`,
          position: Cesium.Cartesian3.fromDegrees(sumLon / cnt, sumLat / cnt),
          ellipse: {
            semiMajorAxis: 700,
            semiMinorAxis: 700,
            material: DWELL.withAlpha(0.18),
            outline: true,
            outlineColor: DWELL,
            outlineWidth: 2,
            height: 0,
          },
          label: {
            text: `dwell ${Math.round(dur / 60)}m`,
            font: '600 10px "IBM Plex Mono", monospace',
            fillColor: DWELL,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0c0e11').withAlpha(0.78),
            backgroundPadding: new Cesium.Cartesian2(5, 3),
            pixelOffset: new Cesium.Cartesian2(0, -10),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
      i = Math.max(j, i + 1);
    }
  }

  async function load(windowSec: number, onlyId?: string): Promise<PlaybackInfo | null> {
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
    let tracks = data.tracks ?? [];
    if (onlyId) tracks = tracks.filter((t) => t.id === onlyId);
    for (const tr of tracks) {
      pts += buildTrackEntity(tr, windowSec);
    }
    if (onlyId && tracks[0]) addDwellMarkers(tracks[0]);

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
    return { tracks: tracks.length, points: pts, from, to };
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
    // Runs from Timeline's effect cleanup, which can fire after the viewer is
    // already destroyed (HMR teardown / globe ErrorBoundary). A destroyed
    // viewer disposes its data sources for us and throws on access — bail.
    if (viewer.isDestroyed()) return;
    if (active) clear();
    viewer.dataSources.remove(ds, true);
  }

  return { load, clear, isActive: () => active, destroy };
}
