import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { MapboxTerrainProvider } from '@macrostrat/cesium-martini';
import { isMobileDevice } from '../shell/device.js';
import { useSettings } from '../state/settings.js';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useTime, useSelection, useSearchTarget, useImagery, useSim } from '../state/stores.js';
import type { ImageryMode } from '../state/stores.js';
import { imageryOverlayUrl } from '../imagery/gibsUrl.js';
import { loadLod1, loadLod1Bbox, clearLod1 } from '../lod1/lod1Layer.js';
import { LayerCompositor } from './LayerCompositor.js';
import { installSelectionReticle } from './selectionReticle.js';
import { installSearchTargetMarker } from './searchTargetMarker.js';
import { installSelectionTrack } from './selectionTrack.js';
import { installSpotlight } from './SpotlightLayer.js';
import { installFov } from './FovLayer.js';
import { installProjection } from './ProjectionLayer.js';
import { createDrawController, setDrawController, getDrawController } from './draw.js';
import { useContextMenu } from './contextMenuStore.js';
import { installAnnotations } from './AnnotationLayer.js';
import { installControl } from './ControlLayer.js';
import { installWatchboxes } from './WatchboxLayer.js';
import { installCaptures } from './CaptureLayer.js';
import { installDetections } from './DetectLayer.js';
import { useInvestigation } from '../graph/investigationStore.js';
import { prewarmIcons } from './icons.js';
import { perfOnRender } from './perf.js';
import { presetKnobs } from './qualityPresets.js';
import { setCameraMoving } from './cameraMotion.js';
import { hasRenderNeed } from './renderNeeds.js';
import { ChipLayer } from '../imagery/ChipLayer.js';
import { backendUrl } from '../transport/http.js';

interface Props {
  ionToken: string;
  registry: LayerRegistry;
  onViewerReady?: (viewer: Cesium.Viewer | null) => void;
  // Imagery stack:
  //  - '2d-dark' (default): proxied Carto Dark Matter, no terrain, no buildings.
  //                         Works without any ion token.
  //  - '3d-sat':            Cesium World Imagery + World Terrain + OSM Buildings.
  //                         Requires ionToken; with runtime google flag, also
  //                         adds Google Photorealistic 3D Tiles.
  imageryMode?: ImageryMode;
  // Optional feature flag — if true AND imageryMode === '3d-sat' AND a Google
  // Maps key is set, load Google Photorealistic 3D Tiles (global photogrammetry)
  // and hide the ellipsoid globe.
  enableGoogle3D?: boolean;
  // Google Maps Platform key (Map Tiles API). Set as Cesium.GoogleMaps.defaultApiKey
  // so createGooglePhotorealistic3DTileset() can fetch the global 3D tiles.
  googleApiKey?: string;
}

// Above this camera altitude the Google photogrammetry is sub-pixel — hide
// it and show the (free) sat globe instead so orbit panning burns zero
// Google quota.
const GOOGLE_3D_MAX_CAMERA_HEIGHT_M = 30_000;

// Above this camera altitude OSM extruded buildings are sub-pixel — you
// can't see them, so hiding the tileset above it skips their tile fetch +
// draw entirely. Below it (city / street scale) they paint as before.
const OSM_BUILDINGS_MAX_CAMERA_HEIGHT_M = 100_000;

// Auto-fill won't refetch until the view centre has moved at least this far
// (degrees) — ~half the backend's clamped district span (MAX_BBOX_SPAN 0.09),
// so panning within one district reuses what's already extruded.
const LOD1_AUTO_MIN_MOVE_DEG = 0.045;

// Hide the OSM buildings tileset when the camera is too high to see it.
// No-ops when the show state didn't change, so it's safe to call from
// camera.changed under requestRenderMode (render only requested on flips).
function applyBuildingsGate(
  viewer: Cesium.Viewer,
  tileset: Cesium.Cesium3DTileset,
): void {
  const h = viewer.camera.positionCartographic.height;
  const visible = h < OSM_BUILDINGS_MAX_CAMERA_HEIGHT_M;
  if (tileset.show !== visible) {
    tileset.show = visible;
    viewer.scene.requestRender();
  }
}

// Flip the Google tileset/globe/credit trio in one place. No-ops when the
// state didn't change, so calling it from camera.changed stays cheap and
// requestRenderMode-friendly (render only requested on actual flips).
function applyGoogleGate(
  viewer: Cesium.Viewer,
  tileset: Cesium.Cesium3DTileset,
  wanted: boolean,
): void {
  const h = viewer.camera.positionCartographic.height;
  const visible = wanted && h < GOOGLE_3D_MAX_CAMERA_HEIGHT_M;
  if (tileset.show !== visible) {
    tileset.show = visible;
    viewer.scene.globe.show = !visible;
    // Google ToS requires visible attribution while their tiles render.
    const credit = viewer.cesiumWidget.creditContainer as HTMLElement;
    credit.style.display = visible ? '' : 'none';
    viewer.scene.requestRender();
  }
}

// Dark, English-everywhere basemap proxied through the backend. The backend
// caches Carto @2x tiles and supports deep zoom; a previous bundled z0-6 tile
// pack booted offline but became blurry when the camera got close.
function buildDarkBasemap(): Cesium.ImageryLayer {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: backendUrl('/tiles/basemap/{z}/{x}/{y}.png'),
    maximumLevel: 22,
  });
  return Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider), {});
}

// Keyless satellite stack: EOX Sentinel-2 (z≤13) + Esri World Imagery
// (z≥14), proxied + disk-cached by the backend. No ion token involved.
function buildSatImagery(): Cesium.ImageryLayer {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: backendUrl('/tiles/sat/{z}/{x}/{y}.jpg'),
    maximumLevel: 19,
  });
  return Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider), {});
}

// Direct-from-browser third-party basemaps (2026-07, docs/places-airspace-plan.md
// §6). These stream straight from each host's tile server — NOT through the
// /tiles/ proxy that buildDarkBasemap/buildSatImagery use for caching, because
// wiring a new host into tiles.py is app/routes/tiles.py's owner's call, not
// this picker's. A future pass can move them behind /tiles/ once that's done.
// Axis order differs by host: Esri/USGS serve {z}/{y}/{x}; OpenTopoMap/EOX
// serve {z}/{x}/{y} — verified live 2026-07-11 (curl -4 -sI each z3 tile, 200).
export type ThirdPartyImageryMode = Exclude<ImageryMode, '2d-dark' | '3d-sat'>;

interface ThirdPartyBasemapDef {
  url: string;
  maximumLevel: number;
  // Shown in the Cesium credit container when visible, and as the picker's
  // option tooltip (CommandBar.tsx) — each host's ToS requires attribution.
  credit: string;
}

export const THIRD_PARTY_BASEMAPS: Record<ThirdPartyImageryMode, ThirdPartyBasemapDef> = {
  'esri-imagery': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 19,
    credit: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  'esri-topo': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 19,
    credit: 'Esri, HERE, Garmin, FAO, NOAA, USGS',
  },
  'esri-dark': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 19,
    credit: 'Esri',
  },
  opentopo: {
    url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    maximumLevel: 17,
    credit: 'Map data: (c) OpenStreetMap contributors, SRTM | Map style: (c) OpenTopoMap (CC-BY-SA)',
  },
  'usgs-imagery': {
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 16,
    credit: 'USGS The National Map: Imagery (public domain)',
  },
  'eox-s2': {
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
    maximumLevel: 14,
    credit: 'Sentinel-2 cloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data)',
  },
};

function buildThirdPartyBasemap(def: ThirdPartyBasemapDef): Cesium.ImageryLayer {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: def.url,
    maximumLevel: def.maximumLevel,
    credit: def.credit,
  });
  return Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider), {});
}

// Imagery overlay (date-templated) drawn ON TOP of the base layer. Proxied +
// disk-cached by the backend at /api/imagery/{provider}/* (GIBS or CDSE).
function buildImageryOverlay(
  providerId: string,
  layer: string,
  date: string,
  maxLevel: number,
): Cesium.ImageryLayer {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: imageryOverlayUrl(providerId, layer, date),
    maximumLevel: maxLevel,
  });
  return Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider), {});
}

// Terrain from our /tiles/terrain proxy (terrarium transcoded server-side
// to Mapbox terrain-RGB), meshed client-side by cesium-martini. Replaces
// ion World Terrain — keyless, disk-cached.
//
// MapboxTerrainProvider (not MartiniTerrainProvider) on purpose: the
// package's bare MartiniTerrainProvider has an upstream bug — its default
// decoder constructs a WorkerFarm with no worker and crashes with
// "Cannot set properties of undefined (setting 'onmessage')". The Mapbox
// wrapper wires the bundled decode worker correctly and accepts a custom
// urlTemplate, and our proxy serves exactly the Mapbox terrain-RGB
// encoding it decodes.
function buildFreeTerrain(): Cesium.TerrainProvider {
  return new MapboxTerrainProvider({
    urlTemplate: backendUrl('/tiles/terrain/{z}/{x}/{y}.png'),
    maxZoom: 15,
    tileSize: 256,
  }) as unknown as Cesium.TerrainProvider;
}

export function GlobeCanvas({
  ionToken,
  registry,
  onViewerReady,
  imageryMode = '2d-dark',
  enableGoogle3D = false,
  googleApiKey = '',
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  // Reactive copy of the viewer so globe-side React layers (ChipLayer) mount
  // once the imperative Cesium viewer exists. Set on construction, cleared on
  // teardown — a ref alone wouldn't re-render this component to mount them.
  const [viewerState, setViewerState] = useState<Cesium.Viewer | null>(null);
  const compositorRef = useRef<LayerCompositor | null>(null);
  // Track ion-stack primitives we add so we can tear them down on toggle
  // without disturbing other primitives in the scene.
  const osmBuildingsRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const googleTilesetRef = useRef<Cesium.Cesium3DTileset | null>(null);
  // Google tileset is created at most once per session and toggled via
  // .show — re-enabling must never re-fetch the root tileset (quota diet).
  const googleCreatingRef = useRef(false);
  const googleWantedRef = useRef(false);
  // Generation counter so out-of-order async tile loads (user spamming the
  // toggle) cannot install a stale tileset into the current scene.
  const stackGenRef = useRef(0);
  const sceneMode = useTime((s) => s.sceneMode);
  const imageryOverlay = useImagery((s) => s.overlay);
  const overlayOpacity = useImagery((s) => s.overlayOpacity);
  const lod1Aoi = useImagery((s) => s.lod1Aoi);
  const lod1Here = useImagery((s) => s.lod1Here);
  const clearLod1Here = useImagery((s) => s.clearLod1Here);
  const lod1Auto = useImagery((s) => s.lod1Auto);
  const flyTo = useImagery((s) => s.flyTo);
  const clearFlyTo = useImagery((s) => s.clearFlyTo);
  const gibsLayerRef = useRef<Cesium.ImageryLayer | null>(null);

  // LOD1 war-damage 3D: load + extrude the curated AOI's buildings on request.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (!lod1Aoi) {
      clearLod1(viewer);
      return;
    }
    loadLod1(viewer, lod1Aoi).catch((e) => console.warn('lod1 load failed:', e));
  }, [lod1Aoi]);

  // On-demand 3D buildings anywhere: resolve the current camera view to a bbox
  // and extrude OSM footprints there. The backend size-clamps the bbox, so a
  // zoomed-out request quietly loads a city-district-sized patch at the centre.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !lod1Here) return;
    const rect = viewer.camera.computeViewRectangle();
    let bbox: [number, number, number, number] | null = null;
    if (rect) {
      bbox = [
        Cesium.Math.toDegrees(rect.west),
        Cesium.Math.toDegrees(rect.south),
        Cesium.Math.toDegrees(rect.east),
        Cesium.Math.toDegrees(rect.north),
      ];
    } else {
      // Camera sees space/horizon — fall back to the point under the camera.
      const c = viewer.camera.positionCartographic;
      if (c) {
        const lon = Cesium.Math.toDegrees(c.longitude);
        const lat = Cesium.Math.toDegrees(c.latitude);
        bbox = [lon - 0.04, lat - 0.04, lon + 0.04, lat + 0.04];
      }
    }
    if (bbox) {
      loadLod1Bbox(viewer, bbox).catch((e) => console.warn('lod1 (here) load failed:', e));
    }
    clearLod1Here();
  }, [lod1Here, clearLod1Here]);

  // Keyless AUTO-FILL: while lod1Auto is on, extrude OSM buildings for the
  // current viewport every time the camera settles below the visible-buildings
  // altitude — so panning across any city on Earth fills in 3D with no clicking
  // and no API key (footprints from public Overpass mirrors, backend-cached
  // 12h). Debounced + move-distance-gated so a settle-storm doesn't hammer the
  // mirrors; reuses loadLod1Bbox's replace-in-place semantics (one district
  // shown at a time → bounded memory, and revisits hit the 12h cache).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !lod1Auto) return;
    let timer: number | null = null;
    let inFlight = false;
    let lastCenter: { lon: number; lat: number } | null = null;

    const maybeLoad = (): void => {
      if (viewer.isDestroyed() || inFlight) return;
      const c = viewer.camera.positionCartographic;
      if (!c || c.height >= OSM_BUILDINGS_MAX_CAMERA_HEIGHT_M) return;
      const rect = viewer.camera.computeViewRectangle();
      let bbox: [number, number, number, number];
      if (rect) {
        bbox = [
          Cesium.Math.toDegrees(rect.west),
          Cesium.Math.toDegrees(rect.south),
          Cesium.Math.toDegrees(rect.east),
          Cesium.Math.toDegrees(rect.north),
        ];
      } else {
        const lon = Cesium.Math.toDegrees(c.longitude);
        const lat = Cesium.Math.toDegrees(c.latitude);
        bbox = [lon - 0.04, lat - 0.04, lon + 0.04, lat + 0.04];
      }
      const center = { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
      // Skip a refetch until the view has moved ~half a clamped tile — otherwise
      // every tiny settle re-hits Overpass for essentially the same district.
      if (lastCenter) {
        const moved =
          Math.abs(center.lon - lastCenter.lon) >= LOD1_AUTO_MIN_MOVE_DEG ||
          Math.abs(center.lat - lastCenter.lat) >= LOD1_AUTO_MIN_MOVE_DEG;
        if (!moved) return;
      }
      lastCenter = center;
      inFlight = true;
      loadLod1Bbox(viewer, bbox)
        .catch((e) => console.warn('lod1 auto-fill failed:', e))
        .finally(() => {
          inFlight = false;
        });
    };

    const onSettle = (): void => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(maybeLoad, 500);
    };
    viewer.camera.moveEnd.addEventListener(onSettle);
    maybeLoad(); // fill wherever the camera already is the moment auto is enabled
    return () => {
      if (timer != null) window.clearTimeout(timer);
      viewer.camera.moveEnd.removeEventListener(onSettle);
    };
  }, [lod1Auto]);

  // Events-anywhere: fly the camera to an operator-chosen point. One-shot
  // request from useImagery (ImageryControl city-search / lat-lon / event
  // list); mirrors the lod1Here request/clear pattern. `seq` in the request
  // object guarantees this effect re-fires even for repeated identical coords.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !flyTo) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        flyTo.lon,
        flyTo.lat,
        flyTo.altMeters ?? 350_000,
      ),
      duration: 1.0,
    });
    clearFlyTo();
  }, [flyTo, clearFlyTo]);

  // GIBS overlay: add/remove a date-templated imagery layer on top of the
  // base when the store's `overlay` changes. Guarded on the viewer existing
  // so declaration order vs the viewer-creation effect doesn't matter.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const scene = viewer.scene;
    if (gibsLayerRef.current) {
      scene.imageryLayers.remove(gibsLayerRef.current, true);
      gibsLayerRef.current = null;
    }
    if (imageryOverlay) {
      const lyr = buildImageryOverlay(
        imageryOverlay.provider,
        imageryOverlay.layer,
        imageryOverlay.date,
        imageryOverlay.maxZ,
      );
      lyr.alpha = overlayOpacity;
      scene.imageryLayers.add(lyr);
      gibsLayerRef.current = lyr;
    }
    scene.requestRender();
    // overlayOpacity is read only to seed the freshly-added layer's initial
    // alpha; live opacity changes are handled by the dedicated effect below
    // (which avoids a tile-flashing layer rebuild), so it must NOT be a
    // dependency here or every slider tick would re-add the whole layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageryOverlay]);

  // Live overlay opacity — set the layer alpha without rebuilding the layer
  // (a rebuild would flash the tiles), so the slider feels instant.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !gibsLayerRef.current) return;
    gibsLayerRef.current.alpha = overlayOpacity;
    viewer.scene.requestRender();
  }, [overlayOpacity]);

  // One-time viewer construction. Always starts on the dark basemap so the
  // app boots without an ion token; if the initial imageryMode is '3d-sat'
  // and a token is present, the swap effect below upgrades the stack.
  useEffect(() => {
    if (!containerRef.current) return;
    if (viewerRef.current) return;

    // Build + decode every entity icon before the compositor starts polling,
    // so the first (13k+ entity) render frame doesn't stall decoding icons.
    prewarmIcons();

    Cesium.Ion.defaultAccessToken = ionToken;
    // Global Photorealistic 3D Tiles fetch via the Google Map Tiles API key
    // (not ion). Without this, createGooglePhotorealistic3DTileset() can't init.
    if (googleApiKey) Cesium.GoogleMaps.defaultApiKey = googleApiKey;

    const viewerOpts: Cesium.Viewer.ConstructorOptions = {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      requestRenderMode: true,
      // 0 (was Infinity): under requestRenderMode, a render is requested when
      // the simulation clock advances past this many seconds. Infinity meant
      // ONLY explicit requestRender() calls painted — so interpolated aircraft/
      // vessel motion only stepped forward once per poll (a visible hop, the
      // "teleport / inconsistent refresh" report). 0 re-renders every frame the
      // clock advances, so SampledPositionProperty interpolation plays smoothly
      // between fixes while live; when the timeline is paused (shouldAnimate
      // false) the clock is frozen, nothing changes, and the scene idles — so
      // requestRenderMode still saves GPU when nothing is moving.
      maximumRenderTimeChange: 0,
      // Ask the browser for the discrete GPU. On hybrid-graphics laptops
      // WebGL defaults to the integrated chip, which chokes on the dense
      // billboard/label scene; 'high-performance' picks the dGPU when one
      // exists (no-op on single-GPU machines, so it's always safe).
      // failIfMajorPerformanceCaveat:false keeps us running (software fallback)
      // rather than throwing on locked-down boxes.
      contextOptions: {
        webgl: {
          powerPreference: 'high-performance',
          failIfMajorPerformanceCaveat: false,
        },
      },
      // Boot on the proxied dark basemap; the 3D-sat stack is applied as a
      // post-construction swap so toggling never remounts the viewer.
      baseLayer: buildDarkBasemap(),
    };

    const viewer = new Cesium.Viewer(containerRef.current, viewerOpts);
    // DEV-only handle for debugging/introspection (mirrors __useSelection).
    if (import.meta.env?.DEV) (window as unknown as { __viewer: Cesium.Viewer }).__viewer = viewer;
    const scene = viewer.scene;

    // Dark space + globe undertone — globe.baseColor is what shows through
    // before imagery loads and between tiles at high tilt.
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b0e14');
    scene.backgroundColor = Cesium.Color.fromCssColorString('#070a10');
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.show = true;
      scene.skyAtmosphere.hueShift = -0.08;
      scene.skyAtmosphere.brightnessShift = -0.35;
      scene.skyAtmosphere.saturationShift = -0.4;
    }
    scene.fog.enabled = true;
    scene.fog.density = 0.0002;
    scene.globe.enableLighting = false;
    scene.globe.showGroundAtmosphere = true;

    // Full-resolution close-up. requestRenderMode stays true (these only change
    // how sharp a *requested* frame is, not how often we render):
    //  - resolutionScale → native device pixels (capped at 2 so a 3x phone
    //    doesn't quadruple the GPU load).
    //  - lower globe maximumScreenSpaceError → finer terrain/imagery tiles when
    //    the camera is close (2 is the default; ~1.4 ≈ "full res").
    //  - minimumZoomDistance ~2 m so an analyst can drop right onto a contact
    //    or a runway instead of stopping ~100 m up.
    // VRAM/throughput budget (a 14k-entity scene + global terrain+imagery was
    // filling ~24 GB and thrashing even a high-end GPU). Three levers, tuned so
    // the GPU isn't the bottleneck:
    //  - resolutionScale capped at 1.5 (was 2.0): a 2x render on a 4K panel is an
    //    8K back-buffer (and Cesium keeps several full-screen passes), so the cap
    //    roughly halves render-target VRAM with no visible softening at 1.5x.
    //  - maximumScreenSpaceError 2.0 (was 1.4): 1.4 loads ~2x the terrain/imagery
    //    tiles of the 2.0 default for an imperceptible sharpness gain — the main
    //    driver of the tile-cache VRAM blow-up.
    //  - preloadSiblings OFF (was on): stop speculatively loading the ring of
    //    adjacent tiles (~3x tile fetch/upload); the visible set is enough.
    // Mobile renders at 1× device pixels (a 3× Samsung panel supersamples to a
    // brutal fill rate otherwise — the overheating). Desktop keeps up to 1.5×.
    // Render at NATIVE device pixels (sharp), capped by the operator's
    // renderPixelCap setting so an extreme DPR can't explode the back-buffer.
    // The old line set resolutionScale = min(DPR, 1.5) but left
    // useBrowserRecommendedResolution at its DEFAULT (true), which forces the
    // device-pixel base to 1.0 and only multiplies by resolutionScale — so on a
    // DPR=2 (Retina / 200% scale / Chrome zoom) display the globe rendered at
    // css×1.5 = 0.75× native (measured), the "pixelated in Chrome, sharp in
    // Firefox" report. Setting it false makes Cesium honour devicePixelRatio;
    // resolutionScale then trims the buffer to css × min(DPR, cap).
    viewer.useBrowserRecommendedResolution = false;
    // ADAPTIVE resolution — the cure for "sharp but laggy". Render at native
    // device pixels (capped by renderPixelCap) when the camera is STILL, and drop
    // to ~1× device pixels WHILE the camera moves: you can't see the softness
    // mid-pan, and the lower fill keeps the drag smooth. Full-res is sharp but
    // heavy; this pays that cost only on the still frame where it actually shows.
    // buffer = css × dpr × resolutionScale ⇒ resolutionScale = min(dpr,cap)/dpr.
    const MOTION_PIXEL_CAP = 1.0; // device-pixel cap during camera motion
    let restoreTimer: number | null = null;
    const setScale = (cap: number): void => {
      if (viewer.isDestroyed()) return;
      const dpr = window.devicePixelRatio || 1;
      const next = Math.min(1, cap / dpr);
      if (Math.abs(viewer.resolutionScale - next) < 0.005) return; // no realloc if unchanged
      viewer.resolutionScale = next;
      viewer.scene.requestRender();
    };
    const idleCap = (): number => (isMobileDevice() ? 1.0 : useSettings.getState().renderPixelCap);
    const toIdle = (): void => setScale(idleCap());
    const toMotion = (): void => setScale(Math.min(idleCap(), MOTION_PIXEL_CAP));
    toIdle();
    // §5.2.4 during-motion degrade: coarsen terrain/imagery + drop FXAA while the
    // camera moves (invisible mid-pan), restore at settle. Cheap fill-rate win on
    // top of the resolutionScale drop. The idle/motion screen-space-error targets
    // come from the map-quality preset (globe/qualityPresets.ts) so the operator
    // can trade tile detail for FPS on a weak GPU; 'high' reproduces the old
    // hardcoded 2.0 / 3.2.
    const setMotionQuality = (motion: boolean): void => {
      if (viewer.isDestroyed()) return;
      const k = presetKnobs(useSettings.getState().mapQuality);
      scene.globe.maximumScreenSpaceError = motion ? k.motionSSE : k.idleSSE;
      const fx = scene.postProcessStages?.fxaa;
      if (fx) fx.enabled = !motion;
    };
    const onMoveStart = (): void => {
      if (restoreTimer != null) {
        window.clearTimeout(restoreTimer);
        restoreTimer = null;
      }
      setCameraMoving(true);
      toMotion();
      setMotionQuality(true);
    };
    const onMoveEnd = (): void => {
      setCameraMoving(false);
      // Debounce so an inertial settle doesn't snap to sharp then re-drop.
      if (restoreTimer != null) window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(() => {
        toIdle();
        setMotionQuality(false);
        evalGovernor(); // re-decide continuous vs idle after a zoom settles
      }, 180);
    };
    viewer.camera.moveStart.addEventListener(onMoveStart);
    viewer.camera.moveEnd.addEventListener(onMoveEnd);
    // Live: re-apply when the operator changes the quality preset / sharpness
    // slider, and when the window moves to a monitor of a different DPR. Preset
    // changes also shift the idle screen-space-error, so re-apply that too (the
    // camera is idle when settings change; a mid-pan change is corrected at the
    // next moveEnd via setMotionQuality(false)).
    const applyQualitySettings = (): void => {
      toIdle();
      setMotionQuality(false);
    };
    const unsubRenderScale = useSettings.subscribe(applyQualitySettings);
    window.addEventListener('resize', toIdle);
    scene.globe.maximumScreenSpaceError = presetKnobs(useSettings.getState().mapQuality).idleSSE;
    scene.globe.preloadSiblings = false;
    // Terrain+imagery tile cache. Kept at the Cesium default (100): an earlier
    // bump to 1000 pushed VRAM the wrong way (these tiles are GPU textures, not
    // system RAM), which on a high-VRAM card let the cache balloon. 100 is a
    // sane resident-tile bound; the real "smoothness" lever is the discrete GPU,
    // not a bigger cache.
    scene.globe.tileCacheSize = 100;
    scene.screenSpaceCameraController.minimumZoomDistance = 2.0;
    // Keep the far plane huge so the whole disk still draws from orbit even
    // with the tighter near zoom.
    scene.screenSpaceCameraController.maximumZoomDistance = 60_000_000;
    // MSAA OFF (Cesium defaults to 4x). 4x multisampling quadruples every HDR
    // float framebuffer in the pipeline (scene color, OIT, bloom, …); on a 4K
    // panel at the device pixel ratio that is gigabytes of render-target VRAM —
    // the dominant slice of the 20+ GB allocation, with the GPU otherwise idle.
    // FXAA gives clean edges at a fraction of the memory + fill cost.
    scene.msaaSamples = 1;
    const fxaa = scene.postProcessStages?.fxaa;
    if (fxaa) fxaa.enabled = true;

    // Strip the default credit logo so the dark chrome is clean.
    (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none';

    // Perf instrument (design §5.7): count REAL renders (not rAF frames) so the
    // render-governor work can be measured. postRender fires once per painted
    // frame; window.__perf.rendersPerSec is the governor's headline metric.
    const onPostRender = (_s: Cesium.Scene, time: Cesium.JulianDate): void => {
      perfOnRender(performance.now());
      void time;
    };
    scene.postRender.addEventListener(onPostRender);

    // P0d render-on-demand governor (design §5.1). DEFAULT OFF (settings) — while
    // off, maximumRenderTimeChange stays 0 exactly as the CLAUDE.md guardrail
    // requires (render every animated frame → smooth interpolation). When the
    // operator opts in, we relax to Infinity (no clock-driven renders) ONLY in the
    // genuinely-idle case: world view, teleport aircraft, frozen vessels, nothing
    // selected, no sim, no registered render-need (satellites / emergency pulse).
    // Any doubt → 0 (continuous). Camera moves + explicit requestRender() calls
    // (selection, layers, scrub) still paint under requestRenderMode either way.
    const WORLD_VIEW_ALT_M = 2_000_000;
    const evalGovernor = (): void => {
      if (viewer.isDestroyed()) return;
      if (!useSettings.getState().continuousRenderGovernor) {
        if (scene.maximumRenderTimeChange !== 0) scene.maximumRenderTimeChange = 0;
        return;
      }
      const worldView = viewer.camera.positionCartographic.height > WORLD_VIEW_ALT_M;
      const deadReckon = useSettings.getState().aircraftDeadReckon;
      const simActive = useSim.getState().active;
      const hasSel = !!useSelection.getState().selectedEntityId;
      const idle = worldView && !deadReckon && !simActive && !hasSel && !hasRenderNeed();
      const next = idle ? Infinity : 0;
      if (scene.maximumRenderTimeChange !== next) {
        scene.maximumRenderTimeChange = next;
        // Paint one fresh frame as we stop clock-driven rendering.
        if (next === Infinity) scene.requestRender();
      }
    };
    const govTimer = window.setInterval(evalGovernor, 250);
    evalGovernor();

    if (import.meta.env.DEV) {
      (window as unknown as { __viewer: Cesium.Viewer; __Cesium: typeof Cesium }).__viewer = viewer;
      (window as unknown as { __Cesium: typeof Cesium }).__Cesium = Cesium;
    }

    // Default camera: high orbital view looking nearly straight down so the
    // whole disk is in frame on first paint.
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(15, 30, 20_000_000),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-85),
        roll: 0,
      },
    });

    // Click → useSelection
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
    handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const picked = scene.pick(click.position);
      // EntityCluster picks return picked.id as an Entity[] (the merged
      // cluster contents) rather than a single Entity. Treating that as a
      // miss would clear the current selection every time the analyst
      // clicked on a vessel cluster bubble — a real "lost my selection"
      // bug. Promote the first child entity instead; if even that's
      // missing, no-op so we don't clobber an existing selection.
      const pickedId = picked?.id;
      if (Array.isArray(pickedId)) {
        const first = pickedId[0];
        const firstEntityId = (first as { id?: string } | undefined)?.id;
        if (firstEntityId) useSelection.getState().select(firstEntityId);
        return;
      }
      const id = (pickedId as { id?: string } | undefined)?.id;
      // The search pin / reticle are non-selectable helper overlays — a click on
      // one is a no-op, never a selection change.
      if (id === '__searchtarget__' || id === '__reticle__') return;
      useSelection.getState().select(id ?? null);
      // Clicking empty globe is the "clear everything" gesture — retire the
      // search pin too so it doesn't linger after the operator moves on.
      if (!id) useSearchTarget.getState().setTarget(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Right-click an entity → "Search around" (expand its 2-hop links in the
    // Investigation graph), mirroring the EntityPanel button. The draw toolbox's
    // own right-click only fires while a polyline draw is in progress, so the
    // two coexist.
    handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const picked = scene.pick(click.position);
      const pid = (picked as { id?: unknown } | undefined)?.id;
      const ent = Array.isArray(pid) ? pid[0] : pid;
      const id = (ent as { id?: string } | undefined)?.id;
      if (id && /^(aircraft|vessel|sim|incident):/.test(id)) {
        useSelection.getState().select(id);
        useInvestigation.getState().searchAround(id);
        return;
      }
      // Empty ground (and not mid-draw) → open the map context menu at the
      // picked lat/lon. The draw toolbox's own right-click only matters while a
      // draw op is armed, so it still wins then.
      if (getDrawController()?.active) return;
      const cart = viewer.camera.pickEllipsoid(click.position, scene.globe.ellipsoid);
      if (!cart) return;
      const c = Cesium.Cartographic.fromCartesian(cart);
      const rect = viewer.canvas.getBoundingClientRect();
      useContextMenu
        .getState()
        .openAt(
          rect.left + click.position.x,
          rect.top + click.position.y,
          Cesium.Math.toDegrees(c.latitude),
          Cesium.Math.toDegrees(c.longitude),
        );
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    // Pulsing reticle around the currently-selected entity.
    const detachReticle = installSelectionReticle(viewer);
    // Amber pin + label at a static location jumped-to from the search box.
    const detachSearchTarget = installSearchTargetMarker(viewer);
    // Magenta polyline through the selected entity's last ~60 positions.
    const detachTrack = installSelectionTrack(viewer);
    // Sensor fog-of-war spotlight that follows the selected sim drone (FMV toggle).
    const detachSpotlight = installSpotlight(viewer);
    // FOV footprint + boresight lines for the selected satellite (real) or
    // aircraft (notional). Toggled from the EntityPanel.
    const detachFov = installFov(viewer);
    // Route-projection reachable-area overlay (decision support, on-demand).
    const detachProjection = installProjection(viewer);
    // Shared map-draw toolbox (COP placement, watchbox AOIs, annotations).
    const drawCtl = createDrawController(viewer);
    setDrawController(drawCtl);
    // Free-hand annotations / graphics layer (renders the annotation store).
    const detachAnnotations = installAnnotations(viewer);
    // Territorial-control layer: hatched controlled/contested areas + front lines.
    const detachControl = installControl(viewer);
    // Geofence/watchbox AOIs + client-side enter/exit/loiter evaluator.
    const detachWatchbox = installWatchboxes(viewer);
    // Captured observations (YOLO detections pinned from cams/panos).
    const detachCaptures = installCaptures(viewer);
    // Imagery-CV detections (YOLO over a satellite chip for an AOI).
    const detachDetections = installDetections(viewer);

    // Height gate for Google photogrammetry — applyGoogleGate no-ops when
    // nothing changed, so this listener stays requestRenderMode-friendly.
    const onCameraChanged = (): void => {
      const ts = googleTilesetRef.current;
      if (ts) applyGoogleGate(viewer, ts, googleWantedRef.current);
      const bld = osmBuildingsRef.current;
      if (bld) applyBuildingsGate(viewer, bld);
    };
    viewer.camera.changed.addEventListener(onCameraChanged);

    viewerRef.current = viewer;
    const compositor = new LayerCompositor(registry, viewer);
    compositor.start();
    compositorRef.current = compositor;
    onViewerReady?.(viewer);
    setViewerState(viewer);

    return () => {
      handler.destroy();
      scene.postRender.removeEventListener(onPostRender);
      window.clearInterval(govTimer);
      viewer.camera.changed.removeEventListener(onCameraChanged);
      unsubRenderScale();
      window.removeEventListener('resize', toIdle);
      viewer.camera.moveStart.removeEventListener(onMoveStart);
      viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      if (restoreTimer != null) window.clearTimeout(restoreTimer);
      detachReticle();
      detachSearchTarget();
      detachTrack();
      detachSpotlight();
      detachFov();
      detachProjection();
      drawCtl.dispose();
      setDrawController(null);
      detachAnnotations();
      detachControl();
      detachWatchbox();
      detachCaptures();
      detachDetections();
      compositorRef.current?.stop();
      compositorRef.current = null;
      onViewerReady?.(null);
      // Drop any ion-stack tilesets we still hold so they don't outlive the
      // viewer (Viewer.destroy() also tears down scene.primitives, but being
      // explicit keeps our refs in sync).
      osmBuildingsRef.current = null;
      googleTilesetRef.current = null;
      viewer.destroy();
      viewerRef.current = null;
      setViewerState(null);
    };
    // Intentionally exclude imageryMode/enableGoogle3D/googleApiKey — the stack
    // is handled by the swap effect below and the Google key is read once at
    // construction, so toggling never remounts the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ionToken, registry, onViewerReady]);

  // Swap the imagery stack in place whenever imageryMode (or its inputs)
  // changes. This effect intentionally does NOT recreate the viewer.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const scene = viewer.scene;
    const hasIon = Boolean(ionToken);
    // 3d-sat no longer requires ion: imagery + terrain come from our own
    // keyless proxies. ion remains an optional bonus (OSM Buildings).
    const wantSat = imageryMode === '3d-sat';
    const thirdPartyDef =
      imageryMode === '2d-dark' || imageryMode === '3d-sat'
        ? undefined
        : THIRD_PARTY_BASEMAPS[imageryMode];

    const gen = ++stackGenRef.current;
    const stale = (): boolean => gen !== stackGenRef.current || !viewerRef.current;

    // Tear down any previous ion-stack primitives. Always safe to call —
    // both refs are null when we're already on the dark basemap.
    const teardownIonStack = (): void => {
      if (osmBuildingsRef.current) {
        scene.primitives.remove(osmBuildingsRef.current); // also destroys
        osmBuildingsRef.current = null;
      }
      // Hide — never destroy — the Google tileset: re-enabling later must
      // not re-fetch the root tileset (quota). Viewer.destroy() reaps it
      // at unmount via scene.primitives.
      googleWantedRef.current = false;
      if (googleTilesetRef.current) {
        applyGoogleGate(viewer, googleTilesetRef.current, false);
      }
      // Reset terrain to the cheap ellipsoid. Setting viewer.terrainProvider
      // here also resets viewer.scene.terrainProvider.
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      scene.globe.show = true;
      scene.requestRender();
    };

    // Replace the imagery layer base. Add the new layer BEFORE removing the
    // old one(s) — removeAll()-then-add() left a one-frame blank globe under
    // requestRenderMode; snapshotting first and removing after guarantees at
    // least one (and, once the removes land, exactly one) basemap layer is
    // ever active.
    const oldLayers: Cesium.ImageryLayer[] = [];
    for (let i = 0; i < scene.imageryLayers.length; i++) {
      oldLayers.push(scene.imageryLayers.get(i));
    }
    const swapInLayer = (layer: Cesium.ImageryLayer): void => {
      scene.imageryLayers.add(layer);
      for (const old of oldLayers) scene.imageryLayers.remove(old, true);
    };

    if (wantSat) {
      // Keyless satellite basemap via our cached proxy.
      swapInLayer(buildSatImagery());

      // Keyless terrain via cesium-martini over /tiles/terrain.
      try {
        viewer.terrainProvider = buildFreeTerrain();
      } catch (e) {
        console.warn('martini terrain failed, staying on ellipsoid:', e);
      }
      scene.requestRender();

      // Drop any prior OSM buildings before adding fresh ones. The Google
      // tileset is deliberately NOT dropped — it's session-cached.
      if (osmBuildingsRef.current) {
        scene.primitives.remove(osmBuildingsRef.current);
        osmBuildingsRef.current = null;
      }

      // OSM 3D buildings — the only remaining ion consumer, so it's gated
      // on the token. If the swap is invalidated mid-load, destroy the
      // late-arriving tileset so we don't leak WebGL resources on rapid toggle.
      if (hasIon) {
        Cesium.createOsmBuildingsAsync()
          .then((tileset) => {
            if (stale()) {
              tileset.destroy();
              return;
            }
            // Hard-cap the buildings tileset VRAM (defaults can overflow well
            // past 1 GB) and coarsen it so far fewer building tiles are resident.
            tileset.cacheBytes = 256 * 1024 * 1024;
            tileset.maximumCacheOverflowBytes = 256 * 1024 * 1024;
            tileset.maximumScreenSpaceError = 24;
            scene.primitives.add(tileset);
            osmBuildingsRef.current = tileset;
            // Apply the height gate immediately so a high boot camera never
            // pays to draw sub-pixel buildings before the first camera move.
            applyBuildingsGate(viewer, tileset);
            scene.requestRender();
          })
          .catch((e: unknown) => console.warn('OSM buildings failed:', e));
      }

      // Optional: Google Photorealistic 3D Tiles. Created once per session
      // (lazy), then toggled via .show + the camera-height gate so orbit
      // views and re-toggles burn no quota.
      googleWantedRef.current = enableGoogle3D;
      if (enableGoogle3D) {
        if (googleTilesetRef.current) {
          applyGoogleGate(viewer, googleTilesetRef.current, true);
        } else if (!googleCreatingRef.current) {
          googleCreatingRef.current = true;
          Cesium.createGooglePhotorealistic3DTileset(undefined, {
            // 24 (vs default 16) ≈ half the tile fetches for slightly softer
            // detail; big cache so revisiting a city reuses tiles.
            maximumScreenSpaceError: 24,
            cacheBytes: 512 * 1024 * 1024,
            maximumCacheOverflowBytes: 1024 * 1024 * 1024,
          })
            .then((tileset) => {
              googleCreatingRef.current = false;
              if (!viewerRef.current) {
                tileset.destroy();
                return;
              }
              scene.primitives.add(tileset);
              googleTilesetRef.current = tileset;
              applyGoogleGate(viewer, tileset, googleWantedRef.current);
            })
            .catch((e: unknown) => {
              googleCreatingRef.current = false;
              console.warn('Google Photorealistic 3D failed:', e);
            });
        }
      } else if (googleTilesetRef.current) {
        applyGoogleGate(viewer, googleTilesetRef.current, false);
      } else {
        scene.globe.show = true;
      }
    } else if (thirdPartyDef) {
      // One of the six direct-from-browser third-party basemaps (Esri/
      // OpenTopoMap/USGS/EOX) — see THIRD_PARTY_BASEMAPS above.
      swapInLayer(buildThirdPartyBasemap(thirdPartyDef));
      teardownIonStack();
    } else {
      // '2d-dark' (default) → proxied dark basemap.
      swapInLayer(buildDarkBasemap());
      teardownIonStack();
    }

    return () => {
      // Bump generation so any in-flight tile promise for this run is a no-op.
      // stackGenRef is a monotonic counter, not a DOM ref — reading the live
      // value in cleanup is exactly the point of the generation pattern.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      stackGenRef.current++;
    };
  }, [imageryMode, ionToken, enableGoogle3D]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const target =
      sceneMode === '3D'
        ? Cesium.SceneMode.SCENE3D
        : sceneMode === '2D'
          ? Cesium.SceneMode.SCENE2D
          : Cesium.SceneMode.COLUMBUS_VIEW;
    if (v.scene.mode === target) return;
    if (target === Cesium.SceneMode.SCENE2D) v.scene.morphTo2D(0.8);
    else if (target === Cesium.SceneMode.COLUMBUS_VIEW) v.scene.morphToColumbusView(0.8);
    else v.scene.morphTo3D(0.8);
  }, [sceneMode]);

  return (
    <>
      <div ref={containerRef} className="h-full w-full" data-testid="globe-container" />
      {/* Focused satellite-imagery chip draped around the selected entity/swarm.
          Driven by the shared useChip focus the EntityPanel sets; renders its own
          control card. Mounts only once the Cesium viewer exists. */}
      <ChipLayer viewer={viewerState} />
    </>
  );
}
