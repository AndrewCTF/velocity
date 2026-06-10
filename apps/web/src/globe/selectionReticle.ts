import * as Cesium from 'cesium';
import { useSelection } from '../state/stores.js';

// Pulsing reticle around the selected entity. Implemented as a billboard
// whose position is sourced from the selected entity's position at every
// frame. The icon is rendered as an SVG once and reused.
//
// frontend.md §2 — "selection reticle slow-pulse", honour prefers-reduced-motion.

const RETICLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <circle cx="32" cy="32" r="22" fill="none" stroke="#2dd4bf" stroke-width="1.4" />
  <line x1="32" y1="2"  x2="32" y2="14" stroke="#2dd4bf" stroke-width="1.4"/>
  <line x1="32" y1="50" x2="32" y2="62" stroke="#2dd4bf" stroke-width="1.4"/>
  <line x1="2"  y1="32" x2="14" y2="32" stroke="#2dd4bf" stroke-width="1.4"/>
  <line x1="50" y1="32" x2="62" y2="32" stroke="#2dd4bf" stroke-width="1.4"/>
</svg>`;

const RETICLE_URI = `data:image/svg+xml;utf8,${encodeURIComponent(RETICLE_SVG)}`;

export function installSelectionReticle(viewer: Cesium.Viewer): () => void {
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ds = new Cesium.CustomDataSource('__reticle');
  viewer.dataSources.add(ds);

  let currentId: string | null = null;
  let entityRef: Cesium.Entity | null = null;
  let reticle: Cesium.Entity | null = null;

  const attachReticleEntity = (target: Cesium.Entity) => {
    entityRef = target;
    if (reticle) return;
    const pulse = new Cesium.CallbackProperty(() => {
      if (reduce) return 0.9;
      const phase = (Date.now() % 1400) / 1400;
      return 0.55 + 0.45 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
    }, false);
    const scaleProp = new Cesium.CallbackProperty(() => {
      if (reduce) return 0.6;
      const phase = (Date.now() % 1400) / 1400;
      return 0.55 + 0.1 * Math.sin(phase * 2 * Math.PI);
    }, false);
    const positionProp = new Cesium.CallbackPositionProperty((time, result) => {
      if (!entityRef?.position) return undefined;
      return entityRef.position.getValue(time, result) ?? undefined;
    }, false);
    reticle = ds.entities.add({
      id: '__reticle__',
      position: positionProp,
      billboard: {
        image: RETICLE_URI,
        scale: scaleProp as unknown as Cesium.Property,
        color: new Cesium.CallbackProperty(
          () => Cesium.Color.WHITE.withAlpha(pulse.getValue(Cesium.JulianDate.now()) as number),
          false,
        ) as unknown as Cesium.Property,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    viewer.scene.requestRender();
  };

  const updateReticle = (id: string | null) => {
    if (id === currentId) return;
    currentId = id;
    if (reticle) {
      ds.entities.remove(reticle);
      reticle = null;
    }
    entityRef = null;
    if (!id) return;
    // First attempt — entity may already exist (clicked an icon).
    const target = findEntity(viewer, id);
    if (target?.position) attachReticleEntity(target);
    // If not yet present (e.g. selected via search before ADS-B fetch lands),
    // the preUpdate hook below keeps trying until the entity appears.
  };

  // Initial sync + subscribe.
  updateReticle(useSelection.getState().selectedEntityId);
  const unsub = useSelection.subscribe((s) => updateReticle(s.selectedEntityId));

  // Throttled re-paint driven by Cesium's own per-frame tick. We only call
  // requestRender when (a) something is selected, (b) at most ~8 fps for the
  // pulse, (c) not in reduced-motion. When nothing is selected we revert to
  // requestRenderMode's idle path, preserving the documented ~88% CPU saving.
  let lastPaint = 0;
  let lastResolveAttempt = 0;
  const off = viewer.scene.preUpdate.addEventListener(() => {
    // If we have a selection but no reticle yet, keep trying to resolve
    // until the entity arrives in a data source (≤4 attempts/sec).
    if (currentId && !reticle) {
      const now = performance.now();
      if (now - lastResolveAttempt > 250) {
        lastResolveAttempt = now;
        const t = findEntity(viewer, currentId);
        if (t?.position) attachReticleEntity(t);
      }
    }
    if (!reticle || reduce) return;
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

function findEntity(viewer: Cesium.Viewer, id: string): Cesium.Entity | undefined {
  for (let i = 0; i < viewer.dataSources.length; i++) {
    const ds = viewer.dataSources.get(i);
    if (ds.name === '__reticle') continue;
    const e = ds.entities.getById(id);
    if (e) return e;
  }
  return viewer.entities.getById(id);
}
