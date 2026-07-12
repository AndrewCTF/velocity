import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { useSelection } from '../state/stores.js';

// Instrument overlays drawn over the globe (.gov in the mockup): a category
// legend, a north compass, a scale bar, live cursor + selection coordinates,
// and a projection/zoom readout. Everything here reflects REAL camera and
// selection state — no decorative placeholders. The container is
// pointer-events-none so it never steals globe interaction.

interface Props {
  viewer: Cesium.Viewer | null;
}

interface LegendItem {
  color: string;
  label: string;
}

// The rendered data categories. These mirror the icon dispatch in
// globe/adapters/styles.ts — truthful, not invented.
const LEGEND: readonly LegendItem[] = [
  { color: '#facc15', label: 'aircraft' },
  { color: '#14b8a6', label: 'vessels' },
  { color: '#ef4444', label: 'dark candidate' },
  { color: 'rgba(255,90,82,0.5)', label: 'GPS jamming' },
];

function fmtLat(lat: number): string {
  const h = lat >= 0 ? 'N' : 'S';
  return `${Math.abs(lat).toFixed(2)}°${h}`;
}
function fmtLon(lon: number): string {
  const h = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lon).toFixed(2)}°${h}`;
}
function fmtAlt(m: number): string {
  if (m >= 1_000_000) return `${(m / 1_000_000).toFixed(1)} Mm`;
  if (m >= 1000) return `${Math.round(m / 1000)} km`;
  return `${Math.round(m)} m`;
}

// Round a distance down to a 1/2/5 × 10ⁿ "nice" value for the scale bar.
function niceDistance(m: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(m)));
  const f = m / pow;
  const nice = f >= 5 ? 5 : f >= 2 ? 2 : 1;
  return nice * pow;
}
function fmtKm(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${km >= 10 ? Math.round(km) : km.toFixed(1)} km`;
}

export function GlobeOverlays({ viewer }: Props): JSX.Element | null {
  const selId = useSelection((s) => s.selectedEntityId);
  const [center, setCenter] = useState<{ lon: number; lat: number; alt: number } | null>(null);
  const [cursor, setCursor] = useState<{ lon: number; lat: number } | null>(null);
  const [headingDeg, setHeadingDeg] = useState(0);
  const [scale, setScale] = useState<{ px: number; label: string } | null>(null);
  const [sel, setSel] = useState<{ lon: number; lat: number } | null>(null);
  const lastRef = useRef<string>('');

  useEffect(() => {
    if (!viewer) return;
    const ell = Cesium.Ellipsoid.WGS84;

    const readCamera = (): void => {
      // A destroyed viewer (HMR teardown, or the globe ErrorBoundary swapping
      // GlobeCanvas out from under a live rail) still satisfies `!== null`, but
      // its `.scene`/`.camera` getters throw. Bail before touching them.
      if (viewer.isDestroyed()) return;
      const carto = viewer.camera.positionCartographic;
      if (carto) {
        setCenter({
          lon: Cesium.Math.toDegrees(carto.longitude),
          lat: Cesium.Math.toDegrees(carto.latitude),
          alt: carto.height,
        });
      }
      setHeadingDeg(Cesium.Math.toDegrees(viewer.camera.heading));

      // Scale bar: pick two ellipsoid points ~100px apart at screen centre.
      const canvas = viewer.scene.canvas;
      const w = canvas.clientWidth || canvas.width;
      const h = canvas.clientHeight || canvas.height;
      const a = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(w / 2 - 50, h / 2), ell);
      const b = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(w / 2 + 50, h / 2), ell);
      if (a && b) {
        const distM = Cesium.Cartesian3.distance(a, b);
        const mPerPx = distM / 100;
        const target = mPerPx * 120; // aim for a ~120px bar
        const nice = niceDistance(target);
        setScale({ px: Math.round(nice / mPerPx), label: fmtKm(nice) });
      } else {
        setScale(null);
      }
    };

    const onMouseMove = (movement: { endPosition: Cesium.Cartesian2 }): void => {
      if (viewer.isDestroyed()) return;
      const cart = viewer.camera.pickEllipsoid(movement.endPosition, ell);
      if (!cart) {
        setCursor(null);
        return;
      }
      const c = Cesium.Cartographic.fromCartesian(cart);
      setCursor({ lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) });
    };

    readCamera();
    const removeChanged = viewer.camera.changed.addEventListener(readCamera);
    // camera.changed only fires past a movement threshold; a low-freq tick
    // catches inertial drift + initial layout without thrashing React.
    const tick = window.setInterval(readCamera, 500);

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onMouseMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    return () => {
      removeChanged();
      window.clearInterval(tick);
      handler.destroy();
    };
  }, [viewer]);

  // Track the selected entity's live position for the "sel" coordinate line.
  useEffect(() => {
    if (!viewer || !selId) {
      setSel(null);
      return;
    }
    const read = (): void => {
      if (viewer.isDestroyed()) return;
      let e: Cesium.Entity | undefined;
      for (let i = 0; i < viewer.dataSources.length; i++) {
        e = viewer.dataSources.get(i).entities.getById(selId);
        if (e) break;
      }
      e ??= viewer.entities.getById(selId);
      const pos = e?.position?.getValue(viewer.clock.currentTime);
      if (!pos) return;
      const c = Cesium.Cartographic.fromCartesian(pos);
      const next = { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
      const key = `${next.lon.toFixed(3)}|${next.lat.toFixed(3)}`;
      if (key !== lastRef.current) {
        lastRef.current = key;
        setSel(next);
      }
    };
    read();
    const id = window.setInterval(read, 700);
    return () => window.clearInterval(id);
  }, [viewer, selId]);

  if (!viewer) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[6] mono select-none">
      {/* mobile live readout — pinned top-center, always on-screen (the desktop
          side/bottom HUD below is rail-offset and off-screen on phones). Updates
          with the camera via the same `center`/`headingDeg` state. */}
      <div className="md:hidden absolute top-2 left-2 right-2 flex justify-center">
        <div
          className="px-2.5 py-1 rounded-md border border-line text-[10px] text-txt-1 flex items-center gap-2"
          style={{ background: 'rgba(8,10,15,0.6)' }}
        >
          <span className="text-txt-0">
            {center ? `${fmtLat(center.lat)}  ${fmtLon(center.lon)}` : '—'}
          </span>
          <span className="text-txt-3">·</span>
          <span className="text-txt-3">{center ? fmtAlt(center.alt) : '—'}</span>
          <span className="text-txt-3">·</span>
          <span className="text-txt-3">{headingDeg.toFixed(0)}°</span>
        </div>
      </div>

      {/* category legend — top-left, hugs the live left rail (icon rail = 44px,
          resizable rail otherwise) via --rail-left-w so it never leaves a gap. */}
      <div
        className="hidden md:flex absolute flex-col gap-1 text-[10px] text-txt-3"
        style={{ left: 'calc(var(--rail-left-w, 44px) + 12px)', top: 14 }}
      >
        {LEGEND.map((l) => (
          <span key={l.label} className="flex items-center gap-1.5">
            <i className="inline-block w-[7px] h-[7px] rounded-full" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>

      {/* compass — top-right, rotates with camera heading; hugs the live right rail */}
      <div
        className="hidden md:flex absolute w-[34px] h-[34px] border border-line rounded-full items-center justify-center text-[10px] text-txt-2"
        style={{ background: 'rgba(8,10,15,0.5)', right: 'calc(var(--rail-right-w, 360px) + 12px)', top: 14 }}
        title={`heading ${headingDeg.toFixed(0)}°`}
      >
        <span style={{ transform: `rotate(${-headingDeg}deg)`, display: 'inline-block' }}>N</span>
      </div>

      {/* scale bar — bottom-left above the coords */}
      {scale && (
        <div className="hidden md:block absolute bottom-[62px]" style={{ left: 'calc(var(--rail-left-w, 44px) + 12px)' }}>
          <div
            className="h-[5px]"
            style={{
              width: scale.px,
              borderLeft: '1px solid var(--txt-2)',
              borderRight: '1px solid var(--txt-2)',
              borderBottom: '1px solid var(--txt-2)',
            }}
          />
          <div className="text-[10px] text-txt-3 mt-[3px] tracking-[0.4px]">{scale.label}</div>
        </div>
      )}

      {/* cursor + selection coordinates — bottom-left */}
      <div
        className="hidden md:block absolute bottom-[14px] text-[10px] text-txt-2 leading-[1.7]"
        style={{ left: 'calc(var(--rail-left-w, 44px) + 12px)' }}
      >
        <div>
          cursor{' '}
          <span className="text-txt-1">
            {cursor ? `${fmtLat(cursor.lat)}  ${fmtLon(cursor.lon)}` : '—'}
          </span>
        </div>
        <div>
          sel{'    '}
          <span className="text-txt-1">{sel ? `${fmtLat(sel.lat)}  ${fmtLon(sel.lon)}` : '—'}</span>
        </div>
      </div>

      {/* projection / center / zoom — bottom-right, hugs the live right rail */}
      <div
        className="hidden md:block absolute bottom-[14px] text-[10px] text-txt-3 tracking-[0.5px] text-right leading-[1.7]"
        style={{ right: 'calc(var(--rail-right-w, 360px) + 12px)' }}
      >
        <div>
          center{' '}
          <span className="text-txt-2">
            {center ? `${fmtLon(center.lon)} ${fmtLat(center.lat)}` : '—'}
          </span>
        </div>
        <div>alt {center ? fmtAlt(center.alt) : '—'}</div>
      </div>
    </div>
  );
}
