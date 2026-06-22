import * as Cesium from 'cesium';

// Shared map-draw toolbox built on the same ScreenSpaceEventHandler +
// pickEllipsoid pattern as SimController.beginPlace. One controller per viewer,
// owns ONE handler and ONE draft CustomDataSource for the live rubber-band; the
// committed geometry is handed back to the caller, which owns the final render
// (COP store, watchbox, annotations…). Idle by default — the handler no-ops
// until a draw op is armed, so it coexists with the globe's selection click.

export type LatLon = { lat: number; lon: number };

type Mode = 'idle' | 'point' | 'polyline' | 'circle';

const DRAFT = Cesium.Color.fromCssColorString('#4fa0d8'); // --accent

// Great-circle distance in km (exported for unit test).
export function haversineKm(a: LatLon, b: LatLon): number {
  const R = 6371.0088;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface DrawController {
  /** Arm a one-shot click → returns the picked ground point. */
  placePoint(cb: (p: LatLon) => void): void;
  /** Multi-click polyline with a live rubber-band; finish() or right-click commits. */
  drawPolyline(onDone: (verts: LatLon[]) => void): void;
  /** Click a centre, move to size, click again to commit (center + radius km). */
  drawCircle(onDone: (center: LatLon, radiusKm: number) => void): void;
  /** Commit an in-progress polyline (≥2 vertices) — for a UI "Finish" button. */
  finish(): void;
  /** Abort any in-progress op and clear the draft. */
  cancel(): void;
  /** True while a draw op is armed/active. */
  readonly active: boolean;
  dispose(): void;
}

// Shared singleton — one controller per viewer, set by GlobeCanvas on viewer
// ready so any panel (COP editor, watchbox, annotations) can drive map drawing
// without prop-drilling. Null before the viewer mounts / after teardown.
let _controller: DrawController | null = null;
export function getDrawController(): DrawController | null {
  return _controller;
}
export function setDrawController(c: DrawController | null): void {
  _controller = c;
  if (typeof window !== 'undefined' && import.meta.env?.DEV) {
    (window as unknown as { __draw: DrawController | null }).__draw = c;
  }
}

export function createDrawController(viewer: Cesium.Viewer): DrawController {
  const draftDs = new Cesium.CustomDataSource('__draw_draft');
  void viewer.dataSources.add(draftDs);
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  let mode: Mode = 'idle';
  let pointCb: ((p: LatLon) => void) | null = null;
  let polyCb: ((v: LatLon[]) => void) | null = null;
  let circleCb: ((c: LatLon, r: number) => void) | null = null;
  const verts: LatLon[] = [];
  let center: LatLon | null = null;
  let cursor: LatLon | null = null;

  const pick = (screen: Cesium.Cartesian2): LatLon | null => {
    const cart = viewer.camera.pickEllipsoid(screen, viewer.scene.globe.ellipsoid);
    if (!cart) return null;
    const c = Cesium.Cartographic.fromCartesian(cart);
    return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
  };

  const clearDraft = (): void => {
    draftDs.entities.removeAll();
    verts.length = 0;
    center = null;
    cursor = null;
    viewer.scene.requestRender();
  };

  const reset = (): void => {
    mode = 'idle';
    pointCb = null;
    polyCb = null;
    circleCb = null;
    clearDraft();
  };

  const polyPositions = (): Cesium.Cartesian3[] => {
    const pts = cursor ? [...verts, cursor] : verts;
    return pts.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat));
  };

  const addPolylineDraft = (): void => {
    draftDs.entities.add({
      id: '__draw_poly',
      polyline: {
        positions: new Cesium.CallbackProperty(() => polyPositions(), false),
        width: 2,
        material: new Cesium.PolylineDashMaterialProperty({ color: DRAFT }),
        arcType: Cesium.ArcType.GEODESIC,
        clampToGround: true,
      },
    });
  };

  const circleRadiusM = (): number =>
    center && cursor ? haversineKm(center, cursor) * 1000 : 0;

  const addCircleDraft = (): void => {
    draftDs.entities.add({
      id: '__draw_circle',
      position: new Cesium.CallbackPositionProperty(
        () => (center ? Cesium.Cartesian3.fromDegrees(center.lon, center.lat) : undefined),
        false,
      ),
      ellipse: {
        semiMajorAxis: new Cesium.CallbackProperty(() => Math.max(1, circleRadiusM()), false),
        semiMinorAxis: new Cesium.CallbackProperty(() => Math.max(1, circleRadiusM()), false),
        material: DRAFT.withAlpha(0.08),
        outline: true,
        outlineColor: DRAFT,
        outlineWidth: 2,
        height: 0,
      },
    });
  };

  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    if (mode === 'idle') return;
    const p = pick(e.position);
    if (!p) return;
    if (mode === 'point') {
      const cb = pointCb;
      reset();
      cb?.(p);
    } else if (mode === 'polyline') {
      verts.push(p);
      viewer.scene.requestRender();
    } else if (mode === 'circle') {
      if (!center) {
        center = p;
        cursor = p;
        viewer.scene.requestRender();
      } else {
        const r = haversineKm(center, p);
        const c = center;
        const cb = circleCb;
        reset();
        cb?.(c, r);
      }
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
    if (mode !== 'polyline' && mode !== 'circle') return;
    const p = pick(e.endPosition);
    if (!p) return;
    cursor = p;
    viewer.scene.requestRender();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // Right-click commits a polyline (mirror of a UI "Finish").
  handler.setInputAction(() => {
    if (mode === 'polyline') finish();
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

  function finish(): void {
    if (mode === 'polyline' && polyCb && verts.length >= 2) {
      const out = [...verts];
      const cb = polyCb;
      reset();
      cb(out);
    } else if (mode === 'polyline') {
      reset(); // not enough points → abort
    }
  }

  return {
    placePoint(cb) {
      reset();
      mode = 'point';
      pointCb = cb;
    },
    drawPolyline(onDone) {
      reset();
      mode = 'polyline';
      polyCb = onDone;
      addPolylineDraft();
    },
    drawCircle(onDone) {
      reset();
      mode = 'circle';
      circleCb = onDone;
      addCircleDraft();
    },
    finish,
    cancel() {
      reset();
    },
    get active() {
      return mode !== 'idle';
    },
    dispose() {
      reset();
      handler.destroy();
      try {
        viewer.dataSources.remove(draftDs, true);
      } catch {
        /* gone */
      }
    },
  };
}
