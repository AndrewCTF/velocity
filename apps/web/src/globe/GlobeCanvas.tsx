import { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useTime, useSelection } from '../state/stores.js';
import type { ImageryMode } from '../state/stores.js';
import { LayerCompositor } from './LayerCompositor.js';
import { installSelectionReticle } from './selectionReticle.js';
import { installSelectionTrack } from './selectionTrack.js';

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
  // Optional feature flag — if true AND imageryMode === '3d-sat' AND ionToken,
  // load Google Photorealistic 3D Tiles and hide the ellipsoid globe.
  enableGoogle3D?: boolean;
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

export function GlobeCanvas({
  ionToken,
  registry,
  onViewerReady,
  imageryMode = '2d-dark',
  enableGoogle3D = false,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const compositorRef = useRef<LayerCompositor | null>(null);
  // Track ion-stack primitives we add so we can tear them down on toggle
  // without disturbing other primitives in the scene.
  const osmBuildingsRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const googleTilesetRef = useRef<Cesium.Cesium3DTileset | null>(null);
  // Generation counter so out-of-order async tile loads (user spamming the
  // toggle) cannot install a stale tileset into the current scene.
  const stackGenRef = useRef(0);
  const sceneMode = useTime((s) => s.sceneMode);

  // One-time viewer construction. Always starts on the dark basemap so the
  // app boots without an ion token; if the initial imageryMode is '3d-sat'
  // and a token is present, the swap effect below upgrades the stack.
  useEffect(() => {
    if (!containerRef.current) return;
    if (viewerRef.current) return;

    Cesium.Ion.defaultAccessToken = ionToken;

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

    viewerRef.current = viewer;
    const compositor = new LayerCompositor(registry, viewer);
    compositor.start();
    compositorRef.current = compositor;
    onViewerReady?.(viewer);

    return () => {
      handler.destroy();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ionToken, registry, onViewerReady]);

  // Swap the imagery stack in place whenever imageryMode (or its inputs)
  // changes. This effect intentionally does NOT recreate the viewer.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const scene = viewer.scene;
    const hasIon = Boolean(ionToken);
    const wantSat = imageryMode === '3d-sat' && hasIon;

    const gen = ++stackGenRef.current;
    const stale = (): boolean => gen !== stackGenRef.current || !viewerRef.current;

    // Tear down any previous ion-stack primitives. Always safe to call —
    // both refs are null when we're already on the dark basemap.
    const teardownIonStack = (): void => {
      if (osmBuildingsRef.current) {
        scene.primitives.remove(osmBuildingsRef.current); // also destroys
        osmBuildingsRef.current = null;
      }
      if (googleTilesetRef.current) {
        scene.primitives.remove(googleTilesetRef.current);
        googleTilesetRef.current = null;
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
      // Cesium World Imagery (asset 2) is the satellite-look basemap.
      scene.imageryLayers.add(
        Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(2), {}),
      );

      // World Terrain (asset 1) gives proper elevation under buildings.
      Cesium.CesiumTerrainProvider.fromIonAssetId(1)
        .then((tp) => {
          if (stale()) return;
          viewer.terrainProvider = tp;
          scene.requestRender();
        })
        .catch((e: unknown) => console.warn('World Terrain failed:', e));

      // Drop any prior ion-stack tilesets before adding fresh ones.
      if (osmBuildingsRef.current) {
        scene.primitives.remove(osmBuildingsRef.current);
        osmBuildingsRef.current = null;
      }
      if (googleTilesetRef.current) {
        scene.primitives.remove(googleTilesetRef.current);
        googleTilesetRef.current = null;
      }

      // OSM 3D buildings. If the swap is invalidated mid-load, destroy the
      // late-arriving tileset so we don't leak WebGL resources on rapid toggle.
      Cesium.createOsmBuildingsAsync()
        .then((tileset) => {
          if (stale()) {
            tileset.destroy();
            return;
          }
          scene.primitives.add(tileset);
          osmBuildingsRef.current = tileset;
          scene.requestRender();
        })
        .catch((e: unknown) => console.warn('OSM buildings failed:', e));

      // Optional: Google Photorealistic 3D Tiles. When enabled, hide the
      // ellipsoid globe so the photogrammetry is the surface.
      if (enableGoogle3D) {
        Cesium.createGooglePhotorealistic3DTileset()
          .then((tileset) => {
            if (stale()) {
              tileset.destroy();
              return;
            }
            scene.primitives.add(tileset);
            googleTilesetRef.current = tileset;
            scene.globe.show = false;
            scene.requestRender();
          })
          .catch((e: unknown) => console.warn('Google Photorealistic 3D failed:', e));
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
