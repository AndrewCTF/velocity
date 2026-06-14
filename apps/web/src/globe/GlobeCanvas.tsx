import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import { MapboxTerrainProvider } from '@macrostrat/cesium-martini';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useTime, useSelection, useImagery } from '../state/stores.js';
import type { ImageryMode } from '../state/stores.js';
import { imageryOverlayUrl } from '../imagery/gibsUrl.js';
import { LayerCompositor } from './LayerCompositor.js';
import { installSelectionReticle } from './selectionReticle.js';
import { installSelectionTrack } from './selectionTrack.js';
import { prewarmIcons } from './icons.js';

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

// Dark, English-everywhere basemap (Carto Dark Matter, proxied through our
// backend so no third-party host appears in the browser network panel and
// the provider is swappable in one place). Works without any Cesium ion
// token, with full 3D rendering on the ellipsoid.
function buildDarkBasemap(): Cesium.ImageryLayer {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/basemap/{z}/{x}/{y}.png',
    maximumLevel: 18,
    credit: '© OpenStreetMap · © CARTO',
  });
  return Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider), {});
}

// Keyless satellite stack: EOX Sentinel-2 (z≤13) + Esri World Imagery
// (z≥14), proxied + disk-cached by the backend. No ion token involved.
function buildSatImagery(): Cesium.ImageryLayer {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/sat/{z}/{x}/{y}.jpg',
    maximumLevel: 19,
    credit: 'Sentinel-2 cloudless by EOX · © Esri',
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
    credit: providerId === 'cdse' ? 'Copernicus Sentinel / CDSE' : 'NASA EOSDIS GIBS',
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
    urlTemplate: '/tiles/terrain/{z}/{x}/{y}.png',
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
  const gibsLayerRef = useRef<Cesium.ImageryLayer | null>(null);

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
      scene.imageryLayers.add(lyr);
      gibsLayerRef.current = lyr;
    }
    scene.requestRender();
  }, [imageryOverlay]);

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
      maximumRenderTimeChange: Infinity,
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
    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2);
    scene.globe.maximumScreenSpaceError = 1.4;
    scene.globe.preloadSiblings = true;
    scene.screenSpaceCameraController.minimumZoomDistance = 2.0;
    // Keep the far plane huge so the whole disk still draws from orbit even
    // with the tighter near zoom.
    scene.screenSpaceCameraController.maximumZoomDistance = 60_000_000;

    // Strip the default credit logo so the dark chrome is clean.
    (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none';

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
      useSelection.getState().select(id ?? null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Pulsing reticle around the currently-selected entity.
    const detachReticle = installSelectionReticle(viewer);
    // Magenta polyline through the selected entity's last ~60 positions.
    const detachTrack = installSelectionTrack(viewer);

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

    return () => {
      handler.destroy();
      viewer.camera.changed.removeEventListener(onCameraChanged);
      detachReticle();
      detachTrack();
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
    };
    // Intentionally exclude imageryMode/enableGoogle3D — they are handled by
    // the swap effect below so toggling never remounts the viewer.
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

    // Replace the imagery layer base. removeAll() destroys old layers; we
    // re-add the appropriate provider for the new mode.
    scene.imageryLayers.removeAll();

    if (wantSat) {
      // Keyless satellite basemap via our cached proxy.
      scene.imageryLayers.add(buildSatImagery());

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
    } else {
      // '2d-dark' OR '3d-sat' without an ion token → fall back to dark basemap.
      scene.imageryLayers.add(buildDarkBasemap());
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

  return <div ref={containerRef} className="h-full w-full" data-testid="globe-container" />;
}
