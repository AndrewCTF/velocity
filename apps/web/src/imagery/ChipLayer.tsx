// Focused satellite-imagery "chip" draped on the globe around a selected
// entity (a sim drone, a swarm roll-up, an aircraft, or a vessel). Driven by
// the shared `useChip` focus the EntityPanel's "Load imagery here" button sets.
//
// Design constraints (CLAUDE.md + §4.2 of the plan):
//   - The chip URL (`/api/imagery/chip`) is KEYLESS by design — the backend
//     mirrors the `imagery_tile` proxy with no auth dep — because Cesium's
//     SingleTileImageryProvider fetches the image itself and can't carry the
//     apiFetch/withWsKey header. So we deliberately do NOT use apiFetch here.
//   - We fetch the chip ONCE as a blob (to read the honest X-Chip metadata
//     headers: provider / gsd / acquired / cloud%), then hand Cesium an
//     object URL built from that same blob — no second download, no CORS hop.
//   - The drape rectangle is the bbox the SERVER reports in X-Chip (it renders
//     pixels for a grid-rounded bbox, not the exact AOI), so the image aligns
//     pixel-for-pixel with where it was actually rendered.
//   - PRELOAD-THEN-SWAP to avoid the blank-hole flash under requestRenderMode:
//     add the new layer, await its provider + first tile, THEN remove the old.
//   - Re-frame CONSERVATIVELY: satellite imagery is static per pass and the
//     entity is the only thing moving, so we re-request only when the entity
//     leaves the current chip rectangle, debounced ≥3 s, and accept staleness
//     (the Caveat stamps the acquisition date so it never reads as "live").
//   - Touches NONE of requestRenderMode / maximumRenderTimeChange / the motion
//     model / the SVG-icon dispatch.

import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';

import { useChip, type ChipFocus } from './chipStore.js';
import { Widget, Caveat, MicroLabel } from '../shell/instruments.js';

// How long (ms) to wait between re-frames once the entity has drifted out of
// the current chip rectangle. Imagery is static per pass; re-fetching faster
// just churns the cache for no visual gain.
const REFRAME_DEBOUNCE_MS = 3_000;
// How often (ms) we poll the focused entity's live position to decide whether
// it has left the chip rectangle. Cheap (one getValue + a bbox compare).
const DRIFT_POLL_MS = 1_000;
// Safety cap so a SingleTileImageryProvider that never fires readyEvent can't
// leave the preloaded layer hidden forever (we reveal + swap anyway).
const PRELOAD_TIMEOUT_MS = 8_000;

// The honest metadata the backend reports in the X-Chip JSON header.
interface ChipMeta {
  provider: string; // 'maxar' | 'sentinel' | 'gibs'
  bbox: { min_lon: number; min_lat: number; max_lon: number; max_lat: number };
  datetime: string | null;
  gsd_m: number | null;
  cloud_pct: number | null;
  layer: string | null;
  note: string | null;
}

interface DrapedChip {
  layer: Cesium.ImageryLayer;
  objectUrl: string;
  meta: ChipMeta;
  // The rectangle the pixels cover (server bbox), in degrees, for drift checks.
  rect: { west: number; south: number; east: number; north: number };
}

// Most-recent commonly-available imagery date. Satellite passes are not
// same-day; yesterday (UTC) is the freshest date GIBS VIIRS reliably has and a
// sane anchor for the Sentinel/Maxar scene search the backend does.
function defaultChipDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Square AOI bbox around a centre — MUST match the backend's bbox_from_radius
// (intel/geo.py): lon widened by sec(lat). Used only as the request AOI; the
// drape itself uses the server-reported (grid-rounded) bbox from X-Chip.
function aoiCenterRadius(
  lat: number,
  lon: number,
  radiusKm: number,
): { lat: number; lon: number; radiusKm: number } {
  return { lat, lon, radiusKm: Math.max(0.1, Math.min(100, radiusKm)) };
}

// Pull the live AOI for a `sim-swarm` roll-up straight off its Cesium entity:
// position = the centroid CallbackPositionProperty, ellipse.semiMajorAxis = the
// bounding-circle radius (metres) — i.e. SimController.swarmAoi() already
// evaluated and rendered, read without a cross-module controller handle. Falls
// back to null when the entity has no ellipse (not a swarm) or no position yet.
function swarmAoiFromEntity(
  entity: Cesium.Entity,
  t: Cesium.JulianDate,
): { lat: number; lon: number; radiusKm: number } | null {
  const pos = entity.position?.getValue(t);
  if (!pos) return null;
  const carto = Cesium.Cartographic.fromCartesian(pos);
  if (!carto) return null;
  const semiMajor = entity.ellipse?.semiMajorAxis?.getValue(t);
  const radiusM = typeof semiMajor === 'number' && semiMajor > 0 ? semiMajor : null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
    // Pad the bounding circle a touch so the chip frames the whole swarm AOI
    // with margin; clamp to the endpoint's range.
    radiusKm: radiusM ? Math.max(0.5, Math.min(100, (radiusM / 1000) * 1.15)) : 4,
  };
}

// Find the focused entity across all datasources (sim lives in its own
// CustomDataSource; aircraft/vessels in the compositor's). null when gone.
function findEntity(viewer: Cesium.Viewer, id: string): Cesium.Entity | null {
  for (let i = 0; i < viewer.dataSources.length; i++) {
    const e = viewer.dataSources.get(i).entities.getById(id);
    if (e) return e;
  }
  return null;
}

// Resolve the AOI to request for a focus: a sim-swarm re-derives its live AOI
// from the entity; everything else uses the focus centre + radius.
function resolveAoi(
  viewer: Cesium.Viewer,
  focus: ChipFocus,
): { lat: number; lon: number; radiusKm: number } {
  if (focus.entityId) {
    const ent = findEntity(viewer, focus.entityId);
    const kind = ent?.properties?.getValue(viewer.clock.currentTime)?.kind as string | undefined;
    if (ent && kind === 'sim-swarm') {
      const aoi = swarmAoiFromEntity(ent, viewer.clock.currentTime);
      if (aoi) return aoi;
    }
  }
  return aoiCenterRadius(focus.lat, focus.lon, focus.radiusKm);
}

function chipUrl(aoi: { lat: number; lon: number; radiusKm: number }, date: string): string {
  const p = new URLSearchParams({
    lat: aoi.lat.toFixed(5),
    lon: aoi.lon.toFixed(5),
    radius_km: aoi.radiusKm.toFixed(3),
    date,
    source: 'auto',
  });
  return `/api/imagery/chip?${p.toString()}`;
}

// Fetch the chip once: returns the blob (pixels) + parsed honest metadata.
// Keyless on purpose (see header). Throws on a non-2xx so the caller can show
// a graceful "no imagery" state rather than a broken drape.
async function fetchChip(
  url: string,
  signal: AbortSignal,
): Promise<{ blob: Blob; meta: ChipMeta }> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`chip ${r.status}`);
  const blob = await r.blob();
  let meta: ChipMeta;
  try {
    meta = JSON.parse(r.headers.get('X-Chip') ?? '{}') as ChipMeta;
  } catch {
    meta = {
      provider: r.headers.get('X-Imagery-Provider') ?? 'unknown',
      bbox: { min_lon: 0, min_lat: 0, max_lon: 0, max_lat: 0 },
      datetime: r.headers.get('X-Imagery-Datetime') || null,
      gsd_m: Number(r.headers.get('X-Imagery-Gsd-M')) || null,
      cloud_pct: null,
      layer: null,
      note: null,
    };
  }
  return { blob, meta };
}

// Wait for a freshly-added ImageryLayer's provider + first tiles, so the swap
// reveals a painted layer (no blank hole). Resolves on readyEvent or a hard
// timeout (never hangs the swap).
function awaitLayerReady(viewer: Cesium.Viewer, layer: Cesium.ImageryLayer): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = window.setTimeout(finish, PRELOAD_TIMEOUT_MS);
    layer.readyEvent.addEventListener(() => {
      window.clearTimeout(timer);
      // One render so the provider's tiles get a chance to upload before we
      // drop the old layer underneath it.
      viewer.scene.requestRender();
      finish();
    });
    // If the provider rejects, don't hang — reveal anyway (it'll just be empty
    // and the next focus replaces it).
    layer.errorEvent.addEventListener(() => {
      window.clearTimeout(timer);
      finish();
    });
  });
}

// Human-readable acquisition stamp from the chip metadata.
function acquiredLabel(meta: ChipMeta): string {
  if (!meta.datetime) return 'archive';
  // datetime may be a full ISO timestamp or a date; keep the date part.
  return meta.datetime.slice(0, 10);
}

function providerLabel(provider: string): string {
  if (provider === 'maxar') return 'MAXAR';
  if (provider === 'sentinel') return 'SENTINEL-2';
  if (provider === 'gibs') return 'GIBS VIIRS';
  return provider.toUpperCase();
}

function gsdLabel(meta: ChipMeta): string {
  if (meta.gsd_m == null) return '— m';
  return meta.gsd_m >= 1 ? `${Math.round(meta.gsd_m)} m` : `${meta.gsd_m.toFixed(1)} m`;
}

export function ChipLayer({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element | null {
  const focus = useChip((s) => s.focus);
  const clear = useChip((s) => s.clear);

  // The currently-draped chip (layer + object URL + meta + rect). Held in a ref
  // because the async load/swap reads it outside React's render cycle.
  const drapedRef = useRef<DrapedChip | null>(null);
  // Generation guard: every (re)load bumps this; a stale async load that loses
  // the race (entity moved / focus changed) is dropped instead of installed.
  const genRef = useRef(0);
  const lastReframeRef = useRef(0);

  const [meta, setMeta] = useState<ChipMeta | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [opacity, setOpacity] = useState(0.85);

  // Tear down the current drape (layer + object URL). Safe to call when empty.
  const teardown = (): void => {
    const v = viewer;
    const d = drapedRef.current;
    if (d) {
      if (v && !v.isDestroyed()) {
        try {
          v.scene.imageryLayers.remove(d.layer, true);
        } catch {
          /* layer already gone */
        }
        v.scene.requestRender();
      }
      URL.revokeObjectURL(d.objectUrl);
      drapedRef.current = null;
    }
  };

  // Load (or re-frame) the chip for a given AOI, preload-then-swap. `gen` is the
  // generation this load belongs to; if it's superseded mid-flight we bail.
  const loadChip = async (
    aoi: { lat: number; lon: number; radiusKm: number },
    gen: number,
    signal: AbortSignal,
  ): Promise<void> => {
    const v = viewer;
    if (!v || v.isDestroyed()) return;
    setStatus('loading');
    let blob: Blob;
    let chipMeta: ChipMeta;
    try {
      const res = await fetchChip(chipUrl(aoi, defaultChipDate()), signal);
      blob = res.blob;
      chipMeta = res.meta;
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return;
      if (gen === genRef.current) setStatus('error');
      return;
    }
    if (gen !== genRef.current || v.isDestroyed()) return;

    const b = chipMeta.bbox;
    // Degenerate bbox (parse fell back to zeros) → don't drape a world-spanning
    // rectangle; surface the metadata only.
    const hasRect =
      b && (b.max_lon !== b.min_lon || b.max_lat !== b.min_lat) && Number.isFinite(b.min_lon);
    if (!hasRect) {
      setMeta(chipMeta);
      setStatus('idle');
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    const rectangle = Cesium.Rectangle.fromDegrees(b.min_lon, b.min_lat, b.max_lon, b.max_lat);
    let newLayer: Cesium.ImageryLayer;
    try {
      newLayer = Cesium.ImageryLayer.fromProviderAsync(
        Cesium.SingleTileImageryProvider.fromUrl(objectUrl, { rectangle }),
        {},
      );
    } catch {
      URL.revokeObjectURL(objectUrl);
      if (gen === genRef.current) setStatus('error');
      return;
    }
    // Add the new layer (on top), preload it, THEN remove the old one — so the
    // operator never sees the hole the old layer leaves under requestRenderMode.
    newLayer.alpha = opacity;
    v.scene.imageryLayers.add(newLayer);
    v.scene.requestRender();
    await awaitLayerReady(v, newLayer);

    // Lost the race while preloading (focus changed / entity moved far) — drop
    // the layer we just added and bail; the winning load owns the scene.
    if (gen !== genRef.current || v.isDestroyed()) {
      try {
        v.scene.imageryLayers.remove(newLayer, true);
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(objectUrl);
      return;
    }

    // Swap: the new layer is painted; remove + revoke the previous one.
    const prev = drapedRef.current;
    if (prev) {
      try {
        v.scene.imageryLayers.remove(prev.layer, true);
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(prev.objectUrl);
    }
    drapedRef.current = {
      layer: newLayer,
      objectUrl,
      meta: chipMeta,
      rect: { west: b.min_lon, south: b.min_lat, east: b.max_lon, north: b.max_lat },
    };
    v.scene.requestRender();
    setMeta(chipMeta);
    setStatus('idle');
    lastReframeRef.current = Date.now();
  };

  // Primary effect: (re)load the chip when the focus changes. Tears down on
  // clear / unmount and aborts any in-flight fetch.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !focus) {
      genRef.current++;
      teardown();
      setMeta(null);
      setStatus('idle');
      return;
    }
    const gen = ++genRef.current;
    const aborter = new AbortController();
    const aoi = resolveAoi(viewer, focus);
    void loadChip(aoi, gen, aborter.signal);
    return () => {
      aborter.abort();
    };
    // opacity is intentionally excluded — its own effect sets layer.alpha live
    // without a reload (a reload would flash). entityId/lat/lon/radius identity
    // is what should trigger a fresh frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, focus?.entityId, focus?.lat, focus?.lon, focus?.radiusKm]);

  // Live opacity — set the draped layer's alpha without rebuilding (a rebuild
  // would flash the tiles), so the slider feels instant.
  useEffect(() => {
    const d = drapedRef.current;
    if (!viewer || viewer.isDestroyed() || !d) return;
    d.layer.alpha = opacity;
    viewer.scene.requestRender();
  }, [viewer, opacity]);

  // Drift watcher: poll the focused entity's live position; when it leaves the
  // current chip rectangle, re-frame (debounced ≥3 s). Accept staleness until
  // then — the imagery is from an earlier pass, not live.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !focus?.entityId) return;
    const v = viewer;
    const entityId = focus.entityId;
    const timer = window.setInterval(() => {
      const d = drapedRef.current;
      if (!d) return;
      const ent = findEntity(v, entityId);
      if (!ent) return;
      // For a swarm, re-derive the live AOI; for a normal entity, use its point.
      const t = v.clock.currentTime;
      const kind = ent.properties?.getValue(t)?.kind as string | undefined;
      let aoi: { lat: number; lon: number; radiusKm: number } | null = null;
      let inside = true;
      if (kind === 'sim-swarm') {
        aoi = swarmAoiFromEntity(ent, t);
        if (aoi) {
          // Re-frame when the swarm centroid nears/exits the chip edge.
          inside =
            aoi.lon > d.rect.west &&
            aoi.lon < d.rect.east &&
            aoi.lat > d.rect.south &&
            aoi.lat < d.rect.north;
        }
      } else {
        const pos = ent.position?.getValue(t);
        if (pos) {
          const c = Cesium.Cartographic.fromCartesian(pos);
          const lon = Cesium.Math.toDegrees(c.longitude);
          const lat = Cesium.Math.toDegrees(c.latitude);
          inside =
            lon > d.rect.west && lon < d.rect.east && lat > d.rect.south && lat < d.rect.north;
          aoi = aoiCenterRadius(lat, lon, focus.radiusKm);
        }
      }
      if (inside || !aoi) return;
      if (Date.now() - lastReframeRef.current < REFRAME_DEBOUNCE_MS) return;
      const gen = ++genRef.current;
      const aborter = new AbortController();
      void loadChip(aoi, gen, aborter.signal);
    }, DRIFT_POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, focus?.entityId, focus?.radiusKm]);

  // Tear down on unmount (covers the case where the component unmounts while a
  // chip is draped and `focus` is still set). Any in-flight load is already
  // aborted by the focus effect's own cleanup, so this only drops the drape.
  useEffect(() => {
    return () => {
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!focus) return null;

  return (
    <div className="absolute bottom-3 right-3 z-[1400] w-[232px] pointer-events-auto">
      <Widget
        title="Focused imagery"
        action={
          <button
            type="button"
            onClick={clear}
            className="mono text-[10px] text-txt-3 hover:text-alert px-1"
            title="Clear chip"
          >
            ✕
          </button>
        }
      >
        {status === 'loading' && !meta && <MicroLabel>fetching chip…</MicroLabel>}
        {status === 'error' && !meta && (
          <MicroLabel className="block text-warn">no imagery for this AOI</MicroLabel>
        )}
        {meta && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Caveat
                level={providerLabel(meta.provider)}
                note={gsdLabel(meta)}
                tone={meta.provider === 'maxar' ? 'neutral' : 'warn'}
              />
              <Caveat level={`ACQ ${acquiredLabel(meta)}`} />
              {meta.cloud_pct != null && <Caveat level={`CLOUD ${Math.round(meta.cloud_pct)}%`} />}
            </div>
            {/* Honesty: this is an archived pass, not live collection. */}
            <MicroLabel className="block">
              {meta.provider === 'gibs'
                ? 'coarse daily mosaic · not live · archived pass'
                : 'archived satellite pass · not live'}
            </MicroLabel>
            {meta.note && <MicroLabel className="block text-txt-3">{meta.note}</MicroLabel>}
            <div className="flex items-center gap-2">
              <MicroLabel>Opacity</MicroLabel>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
                className="flex-1 accent-[var(--accent)]"
                aria-label="chip opacity"
              />
            </div>
            {status === 'loading' && <MicroLabel className="block">re-framing…</MicroLabel>}
          </div>
        )}
      </Widget>
    </div>
  );
}
