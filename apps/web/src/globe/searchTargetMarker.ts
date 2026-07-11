import * as Cesium from 'cesium';
import { useSearchTarget, type SearchTarget } from '../state/stores.js';

// Pinned marker for a location jumped-to from the search box (airport / port /
// place / chokepoint / coordinate). Unlike the selection reticle
// (selectionReticle.ts), which locks onto a LIVE entity's moving position,
// this is anchored to a STATIC coordinate the operator searched for — so it
// works even though the airports/ports layers are off-by-default and
// zoom-gated. It draws an amber drop-pin + a text label so, among a cluster of
// look-alike airport icons, the operator can see exactly which one is "JFK".
//
// Amber (#f59e0b) deliberately differs from the teal (#2dd4bf) selection
// reticle so a search pin never reads as a live-entity selection.

const PIN_COLOR = '#f59e0b';

// A downward teardrop pin with a hollow centre + a soft pulsing halo ring. The
// tip sits at the anchored coordinate (VerticalOrigin.BOTTOM), the ring is
// centred on the tip.
const PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 64" width="48" height="64">
  <circle cx="24" cy="58" r="5" fill="none" stroke="${PIN_COLOR}" stroke-width="1.4" opacity="0.9"/>
  <path d="M24 62 C24 62 9 40 9 24 A15 15 0 1 1 39 24 C39 40 24 62 24 62 Z"
        fill="${PIN_COLOR}" fill-opacity="0.22" stroke="${PIN_COLOR}" stroke-width="2"/>
  <circle cx="24" cy="24" r="6" fill="none" stroke="${PIN_COLOR}" stroke-width="2"/>
</svg>`;

const PIN_URI = `data:image/svg+xml;utf8,${encodeURIComponent(PIN_SVG)}`;

export function installSearchTargetMarker(viewer: Cesium.Viewer): () => void {
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ds = new Cesium.CustomDataSource('__searchtarget');
  viewer.dataSources.add(ds);

  let marker: Cesium.Entity | null = null;

  const clear = (): void => {
    if (marker) {
      ds.entities.remove(marker);
      marker = null;
    }
  };

  const render = (t: SearchTarget | null): void => {
    clear();
    if (!t) {
      viewer.scene.requestRender();
      return;
    }
    // Soft halo pulse on the pin's alpha; the ring at the tip reads as a
    // target even when zoomed out enough that the label overlaps neighbours.
    const alpha = new Cesium.CallbackProperty(() => {
      if (reduce) return 1;
      const phase = (Date.now() % 1400) / 1400;
      return 0.6 + 0.4 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
    }, false);
    marker = ds.entities.add({
      id: '__searchtarget__',
      position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat),
      billboard: {
        image: PIN_URI,
        scale: 0.8,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        color: new Cesium.CallbackProperty(
          () => Cesium.Color.WHITE.withAlpha(alpha.getValue(Cesium.JulianDate.now()) as number),
          false,
        ) as unknown as Cesium.Property,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: t.label,
        font: '600 13px ui-sans-serif, system-ui, sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#fde68a'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#1c1917').withAlpha(0.82),
        backgroundPadding: new Cesium.Cartesian2(7, 5),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(0, -60),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    viewer.scene.requestRender();
  };

  // Initial sync + subscribe.
  render(useSearchTarget.getState().target);
  const unsub = useSearchTarget.subscribe((s) => render(s.target));

  // Drive the halo pulse the same way the reticle does: only request renders
  // while a pin exists and motion is allowed, throttled to ~8 fps, so we keep
  // requestRenderMode's idle CPU saving when nothing is pinned.
  let lastPaint = 0;
  const off = viewer.scene.preUpdate.addEventListener(() => {
    if (!marker || reduce) return;
    const now = performance.now();
    if (now - lastPaint < 120) return;
    lastPaint = now;
    viewer.scene.requestRender();
  });

  return () => {
    unsub();
    off();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* gone */
    }
  };
}
