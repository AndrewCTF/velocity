import { useEffect } from 'react';
import * as Cesium from 'cesium';
import { Hand, Ruler, BoxSelect, MapPin, Move, LocateFixed, Plus, Minus, X } from 'lucide-react';
import { getDrawController, haversineKm, type LatLon, type DrawProgress } from './draw.js';
import { resetToTopDown } from './camera.js';
import { useMapTools, type MapTool } from './mapTools.js';
import { areaActions } from './mapActions.js';
import { useAnnotations } from '../annotations/annotationStore.js';

// Right-side globe toolbar (design §6.1) — quick map tools reachable without
// leaving the current tab: pan (rest), measure, area-select, annotate, move
// (reposition dropped markers) + camera quick-actions (reset / zoom). Every draw
// tool drives the SHARED DrawController (globe/draw.ts) so there is ONE handler
// on the canvas and the existing annotation / AOI plumbing is reused, not
// rebuilt. Floats just inside the right rail; pointer-scoped so it never blocks
// globe drag.

interface ToolDef {
  id: MapTool;
  icon: typeof Hand;
  label: string;
  hint: string;
}

const TOOLS: readonly ToolDef[] = [
  { id: 'pan', icon: Hand, label: 'Pan', hint: 'Navigate — drag to move, click to select (default)' },
  { id: 'measure', icon: Ruler, label: 'Measure', hint: 'Click points for a running distance; right-click to finish' },
  { id: 'area', icon: BoxSelect, label: 'Area select', hint: 'Click two corners for a box; search objects inside it' },
  { id: 'annotate', icon: MapPin, label: 'Annotate', hint: 'Click the map to drop labelled markers' },
  { id: 'move', icon: Move, label: 'Move marker', hint: 'Drag a dropped marker to reposition it' },
];

// Cumulative great-circle length of an ordered vertex list, in km.
function polylineKm(pts: readonly LatLon[]): number {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += haversineKm(pts[i - 1]!, pts[i]!);
  return sum;
}

function fmtKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function GlobeToolbar({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element | null {
  const tool = useMapTools((s) => s.tool);
  const setTool = useMapTools((s) => s.setTool);
  const measure = useMapTools((s) => s.measure);
  const area = useMapTools((s) => s.area);

  // Arm / disarm the active draw tool against the shared controller whenever the
  // selected tool changes. Each arming is self-re-arming (measure/annotate stay
  // active for repeated use) until the operator picks another tool.
  useEffect(() => {
    const draw = getDrawController();
    if (!draw || !viewer || viewer.isDestroyed()) return;
    const { setMeasure, setArea } = useMapTools.getState();

    // Reset any prior op + readouts before arming the new tool.
    draw.cancel();
    draw.setProgressListener(null);

    if (tool === 'measure') {
      setArea(null);
      draw.setProgressListener((p: DrawProgress) => {
        if (p.mode !== 'polyline') return;
        const pts = p.cursor ? [...p.verts, p.cursor] : [...p.verts];
        setMeasure({ distanceKm: polylineKm(pts), points: p.verts.length, live: true });
      });
      const armMeasure = (): void => {
        draw.drawPolyline((verts) => {
          setMeasure({ distanceKm: polylineKm(verts), points: verts.length, live: false });
          // Re-arm for the next measurement while the tool stays selected.
          if (useMapTools.getState().tool === 'measure') armMeasure();
        });
      };
      setMeasure(null);
      armMeasure();
    } else if (tool === 'area') {
      setMeasure(null);
      const armArea = (): void => {
        draw.drawRect((a, b) => {
          const north = Math.max(a.lat, b.lat);
          const south = Math.min(a.lat, b.lat);
          const east = Math.max(a.lon, b.lon);
          const west = Math.min(a.lon, b.lon);
          const center = { lat: (north + south) / 2, lon: (east + west) / 2 };
          // Box area ≈ (N-S span) × (E-W span at mid-latitude), both via haversine.
          const hKm = haversineKm({ lat: south, lon: center.lon }, { lat: north, lon: center.lon });
          const wKm = haversineKm({ lat: center.lat, lon: west }, { lat: center.lat, lon: east });
          const radiusKm = haversineKm(center, { lat: north, lon: east });
          setArea({ north, south, east, west, areaKm2: hKm * wKm, center, radiusKm });
          if (useMapTools.getState().tool === 'area') armArea();
        });
      };
      setArea(null);
      armArea();
    } else if (tool === 'annotate') {
      setMeasure(null);
      setArea(null);
      const { threat, label } = { threat: 'unknown' as const, label: '' };
      const armPoint = (): void => {
        draw.placePoint((p) => {
          useAnnotations.getState().add({ kind: 'point', threat, label, coords: [[p.lon, p.lat]] });
          if (useMapTools.getState().tool === 'annotate') armPoint();
        });
      };
      armPoint();
    } else {
      // 'pan' | 'move' — no DrawController op. Clear stale readouts on 'pan'.
      if (tool === 'pan') {
        setMeasure(null);
        setArea(null);
      }
    }

    return () => {
      draw.setProgressListener(null);
      draw.cancel();
    };
  }, [tool, viewer]);

  // 'move' tool: drag the nearest dropped point-annotation to reposition it. Owns
  // a dedicated screen-space handler (only while the tool is active) and locks
  // camera rotation during a drag so the marker moves, not the globe.
  useEffect(() => {
    if (tool !== 'move' || !viewer || viewer.isDestroyed()) return;
    const ell = viewer.scene.globe.ellipsoid;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    let dragId: string | null = null;

    const pick = (s: Cesium.Cartesian2): LatLon | null => {
      const cart = viewer.camera.pickEllipsoid(s, ell);
      if (!cart) return null;
      const c = Cesium.Cartographic.fromCartesian(cart);
      return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
    };

    // Only grab a marker whose SCREEN position is within this many pixels of the
    // click. Pixel-space (not km) is inherently zoom-aware: at world zoom a
    // marker on another continent projects far from the cursor and is left
    // alone, so a plain drag over empty map still pans instead of teleporting a
    // distant marker. Without this bound the tool hijacked the globally-nearest
    // marker on every drag and made panning impossible while Move was active.
    const GRAB_PX = 26;
    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const scene = viewer.scene;
      // Horizon occlusion (Cesium's EllipsoidalOccluder algorithm, inlined —
      // the class isn't in the public typings): reject markers on the FAR side
      // of the globe, which still project to a window coord, so a back-of-Earth
      // marker under the cursor isn't grabbed.
      const camScaled = ell.transformPositionToScaledSpace(viewer.camera.positionWC);
      const vhSq = Cesium.Cartesian3.magnitudeSquared(camScaled) - 1;
      const vt = new Cesium.Cartesian3();
      let best: { id: string; d: number } | null = null;
      for (const a of useAnnotations.getState().annotations) {
        if (a.kind !== 'point' || !a.coords?.[0]) continue;
        const [lon, lat] = a.coords[0];
        const world = Cesium.Cartesian3.fromDegrees(lon, lat);
        const target = ell.transformPositionToScaledSpace(world);
        Cesium.Cartesian3.subtract(target, camScaled, vt);
        const vtDotVc = -Cesium.Cartesian3.dot(vt, camScaled);
        const occluded =
          vhSq < 0
            ? vtDotVc > 0
            : vtDotVc > vhSq &&
              (vtDotVc * vtDotVc) / Cesium.Cartesian3.magnitudeSquared(vt) > vhSq;
        if (occluded) continue;
        const win = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world);
        if (!win) continue;
        const d = Math.hypot(win.x - e.position.x, win.y - e.position.y);
        if (d <= GRAB_PX && (!best || d < best.d)) best = { id: a.id, d };
      }
      if (best) {
        dragId = best.id;
        viewer.scene.screenSpaceCameraController.enableRotate = false;
        viewer.scene.screenSpaceCameraController.enableTranslate = false;
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!dragId) return;
      const p = pick(e.endPosition);
      if (!p) return;
      useAnnotations.getState().update(dragId, { coords: [[p.lon, p.lat]] });
      viewer.scene.requestRender();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    const endDrag = (): void => {
      dragId = null;
      viewer.scene.screenSpaceCameraController.enableRotate = true;
      viewer.scene.screenSpaceCameraController.enableTranslate = true;
    };
    handler.setInputAction(endDrag, Cesium.ScreenSpaceEventType.LEFT_UP);

    return () => {
      endDrag();
      handler.destroy();
    };
  }, [tool, viewer]);

  // Escape returns to pan (mirrors the globe's own "click empty clears" grammar).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (useMapTools.getState().tool !== 'pan') setTool('pan');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTool]);

  if (!viewer) return null;

  const zoom = (dir: 1 | -1): void => {
    const h = viewer.camera.positionCartographic?.height ?? 1e6;
    const amount = Math.max(1000, h * 0.35);
    if (dir === 1) viewer.camera.zoomIn(amount);
    else viewer.camera.zoomOut(amount);
  };

  return (
    <div
      className="absolute top-1/2 -translate-y-1/2 z-[var(--z-dock)] pointer-events-none flex items-center gap-2"
      style={{ right: 'calc(var(--rail-right-w, 360px) + 12px)' }}
    >
      {/* Live readout popover — sits to the LEFT of the rail so it never covers it. */}
      {(measure || area) && (
        <div className="pointer-events-auto mono text-[10px] rounded-md border border-line bg-bg-1/95 backdrop-blur-sm shadow-xl p-2 max-w-[190px] flex flex-col gap-1">
          {measure && (
            <>
              <div className="flex items-center justify-between">
                <span className="font-label uppercase tracking-[0.7px] text-txt-0 text-[10px]">Distance</span>
                <button type="button" className="text-txt-3 hover:text-txt-0" onClick={() => useMapTools.getState().setMeasure(null)} aria-label="Clear measurement">
                  <X size={11} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
              <span className="text-accent text-[15px] tabular-nums leading-none">{fmtKm(measure.distanceKm)}</span>
              <span className="text-txt-3 text-[9px]">
                {measure.points} pt{measure.points === 1 ? '' : 's'}{measure.live ? ' · click to add · right-click to finish' : ' · done'}
              </span>
            </>
          )}
          {area && (
            <>
              <div className="flex items-center justify-between">
                <span className="font-label uppercase tracking-[0.7px] text-txt-0 text-[10px]">Area</span>
                <button type="button" className="text-txt-3 hover:text-txt-0" onClick={() => useMapTools.getState().setArea(null)} aria-label="Clear area">
                  <X size={11} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
              <span className="text-txt-1 tabular-nums">{Math.round(area.areaKm2).toLocaleString()} km²</span>
              <span className="text-txt-3 text-[9px] tabular-nums leading-snug">
                N {area.north.toFixed(2)} · S {area.south.toFixed(2)}
                <br />E {area.east.toFixed(2)} · W {area.west.toFixed(2)}
              </span>
              {/* Same capabilities as the map right-click menu, scoped to the box
                  (imagery, ground recon, diff, search, AI assess, watchbox…). */}
              <div className="mt-0.5 flex flex-col gap-0.5 max-h-[220px] overflow-auto -mx-0.5">
                {areaActions(area).map((act) => (
                  <button
                    key={act.label}
                    type="button"
                    className="text-left rounded-sm px-1.5 py-1 text-[10px] text-txt-1 hover:bg-bg-2 hover:text-accent"
                    onClick={() => void act.run()}
                    title={act.label}
                  >
                    {act.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div
        className="pointer-events-auto flex flex-col rounded-md border border-line-2 overflow-hidden shadow-[0_8px_30px_-12px_rgba(0,0,0,0.85)]"
        role="toolbar"
        aria-label="Map tools"
        style={{ background: 'rgba(9,12,18,0.94)' }}
      >
        {TOOLS.map((t) => {
          const on = t.id === tool;
          const I = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              title={`${t.label} — ${t.hint}`}
              aria-pressed={on}
              aria-label={t.label}
              onClick={() => setTool(on && t.id !== 'pan' ? 'pan' : t.id)}
              className={`relative w-10 h-10 flex items-center justify-center transition-colors ${
                on ? 'text-accent bg-accent-dim' : 'text-txt-2 hover:text-txt-0 hover:bg-bg-2'
              }`}
            >
              <I size={17} strokeWidth={1.75} aria-hidden />
              {on && <span className="absolute right-0 top-1.5 bottom-1.5 w-[2px] bg-accent rounded-l-sm" />}
            </button>
          );
        })}

        <div className="mx-2 my-1 h-px bg-line-2" />

        <button type="button" title="Reset to top-down (nadir) view" aria-label="Reset view" onClick={() => resetToTopDown(viewer)} className="w-10 h-10 flex items-center justify-center text-txt-2 hover:text-accent hover:bg-bg-2">
          <LocateFixed size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoom(1)} className="w-10 h-10 flex items-center justify-center text-txt-2 hover:text-accent hover:bg-bg-2">
          <Plus size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoom(-1)} className="w-10 h-10 flex items-center justify-center text-txt-2 hover:text-accent hover:bg-bg-2">
          <Minus size={17} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  );
}
