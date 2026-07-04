import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap, type LngLatBoundsLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers as pmLayers, namedFlavor } from '@protomaps/basemaps';
import type { LayerDescriptor } from '@osint/shared';

// Register the pmtiles:// protocol ONCE so MapLibre can range-read a local
// PMTiles archive (no tile server, no per-tile request). BSD-3, fully offline.
maplibregl.addProtocol('pmtiles', new Protocol().tile);
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useFeeds, useSelection } from '../state/stores.js';
import { useAoi } from '../state/aoi.js';
import { apiFetch } from '../transport/http.js';
import { tracks } from '../intel/tracks.js';

interface Props {
  registry: LayerRegistry;
}

// Minimal MapLibre v5 mirror. Same LayerRegistry, but rendering via MapLibre's
// own GeoJSON source / layer primitives. We poll each GeoJSON endpoint with
// the same TTL the registry advertises and update the source data in place
// (no removeAll churn). Carto Dark Matter style via vector tiles is too
// heavy here, so we use the same /tiles/basemap raster tiles wired as a
// MapLibre raster source.
export function MapLibreCanvas({ registry }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const activeAoi = useAoi((s) => s.active);

  // High-fidelity dark VECTOR basemap from a LOCAL PMTiles file (Protomaps planet
  // region, ODbL/OSM) rendered client-side with the Protomaps dark style (BSD-3).
  // Crisp at every zoom from one local file; zero external/tile-server requests.
  // ponytail: label (symbol) layers dropped — they need local glyph PBFs to stay
  // offline; geometry (land/water/roads/buildings) renders crisp without glyphs.
  // Add bundled glyphs later to restore labels.
  const styleDef = useMemo(() => {
    const all = pmLayers('protomaps', namedFlavor('dark'), { lang: 'en' });
    return {
      version: 8,
      // Local glyph PBFs (Noto Sans, OFL) → labels render fully offline.
      glyphs: '/fonts/{fontstack}/{range}.pbf',
      sources: {
        protomaps: {
          type: 'vector',
          url: 'pmtiles:///basemap/region.pmtiles',
          attribution: '© OpenStreetMap',
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0a0e14' } },
        ...all,
      ],
    } as unknown as maplibregl.StyleSpecification;
  }, []);

  // Boot once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleDef,
      center: [-0.118, 51.509],
      zoom: 10.5,
      attributionControl: false,
      hash: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    // Globe projection (MapLibre v5+).
    map.on('style.load', () => {
      try {
        (map as unknown as { setProjection: (p: { type: string }) => void }).setProjection({
          type: 'globe',
        });
      } catch {
        /* projection not available, stays mercator */
      }
      setReady(true);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [styleDef]);

  // Fly to active AOI
  useEffect(() => {
    if (!ready || !mapRef.current || !activeAoi) return;
    const [w, s, e, n] = activeAoi.bbox;
    mapRef.current.fitBounds([
      [w, s],
      [e, n],
    ] as LngLatBoundsLike, { padding: 40, duration: 1200 });
  }, [activeAoi, ready]);

  // Mirror registry → MapLibre layers
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const timers = new Map<string, number>();
    const aborters = new Map<string, AbortController>();

    const detach = (id: string) => {
      const t = timers.get(id);
      if (t) window.clearInterval(t);
      timers.delete(id);
      aborters.get(id)?.abort();
      aborters.delete(id);
      // Aircraft layers add cluster + cluster_count siblings; remove all three
      // before dropping the source, otherwise removeSource throws and the
      // source leaks.
      for (const layerId of [`${id}__pts`, `${id}__clusters`, `${id}__cluster_count`]) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      }
      if (map.getSource(id)) map.removeSource(id);
      useFeeds.getState().setFeed({ id, label: id, status: 'unknown' });
    };

    const colorFor = (d: LayerDescriptor): string => {
      if (d.emits?.includes('aircraft')) return '#2dd4bf';
      if (d.emits?.includes('vessel')) return '#34d399';
      if (d.emits?.includes('quake')) return '#f59e0b';
      if (d.emits?.includes('fire')) return '#ef4444';
      return '#e6edf3';
    };

    const sizeFor = (d: LayerDescriptor): number => (d.emits?.includes('aircraft') ? 3 : 2.5);

    const attach = (d: LayerDescriptor) => {
      if (d.kind !== 'geojson') return; // skip ws/cog/3dtiles in /2d
      if (map.getSource(d.id)) return;
      const empty = { type: 'FeatureCollection', features: [] } as unknown as GeoJSON.FeatureCollection;
      // Cluster vessel and aircraft sources: at world / continent scale a raw
      // dump of ~18k AIS contacts overdraws the Baltic into one green blob.
      // Below clusterMaxZoom MapLibre auto-aggregates them into bubbles; past
      // that, individual icons reappear.
      const clusterable = !!(d.emits?.includes('aircraft') || d.emits?.includes('vessel'));
      map.addSource(d.id, {
        type: 'geojson',
        data: empty,
        // MapLibre only auto-populates feature.id for numeric ids; our
        // backend ships string top-level ids (e.g. "aircraft:hex"). promoteId
        // expects a *properties* key, which we don't have, so we copy the
        // top-level id into properties.__eid on every setData below and read
        // it back in the click handler.
        cluster: clusterable,
        clusterMaxZoom: 5,
        clusterRadius: 40,
      });
      const radius = ['interpolate', ['linear'], ['zoom'], 1, sizeFor(d) - 1, 6, sizeFor(d) + 1, 10, sizeFor(d) + 3];
      map.addLayer({
        id: `${d.id}__pts`,
        type: 'circle',
        source: d.id,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': colorFor(d),
          'circle-radius': radius as unknown as number,
          'circle-stroke-width': 0.8,
          'circle-stroke-color': '#000',
          'circle-opacity': d.opacity,
        },
      });
      // Clustered sources (aircraft + vessel) get their own paint layers — a
      // teal/emerald bubble with the count rendered as a symbol on top. We
      // colour-key the bubble to the layer accent so vessels (green) and
      // aircraft (teal) remain visually distinguishable when both are dense.
      if (clusterable) {
        const clusterColor = d.emits?.includes('vessel') ? '#34d399' : '#2dd4bf';
        map.addLayer({
          id: `${d.id}__clusters`,
          type: 'circle',
          source: d.id,
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': clusterColor,
            'circle-opacity': 0.5,
            'circle-radius': ['step', ['get', 'point_count'], 8, 50, 12, 200, 18],
            'circle-stroke-color': '#0d1117',
            'circle-stroke-width': 1.5,
          },
        });
        map.addLayer({
          id: `${d.id}__cluster_count`,
          type: 'symbol',
          source: d.id,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-size': 10,
            'text-font': ['Open Sans Bold'] as unknown as string[],
          },
          paint: { 'text-color': '#0b0e14' },
        });
      }
      const pull = async () => {
        const aoi = useAoi.getState().active;
        const url =
          aoi && d.id === 'aviation.opensky.states'
            ? `${d.endpoint}${d.endpoint.includes('?') ? '&' : '?'}lamin=${aoi.bbox[1]}&lomin=${aoi.bbox[0]}&lamax=${aoi.bbox[3]}&lomax=${aoi.bbox[2]}`
            : d.endpoint;
        aborters.get(d.id)?.abort();
        const aborter = new AbortController();
        aborters.set(d.id, aborter);
        try {
          const r = await apiFetch(url, { signal: aborter.signal });
          if (!r.ok) {
            useFeeds.getState().setFeed({ id: d.id, label: d.title, status: 'red', note: `upstream ${r.status}` });
            return;
          }
          const data = (await r.json()) as GeoJSON.FeatureCollection & { note?: string };
          // Copy top-level feature.id into properties.__eid so the click
          // handler can recover it via queryRenderedFeatures (feature.id is
          // undefined there for non-numeric string ids).
          if (Array.isArray(data.features)) {
            for (const f of data.features) {
              if (f && f.id != null) {
                const props = (f.properties ?? {}) as Record<string, unknown>;
                props.__eid = f.id;
                f.properties = props as GeoJSON.GeoJsonProperties;
              }
            }
          }
          const src = map.getSource(d.id) as maplibregl.GeoJSONSource | undefined;
          if (src) src.setData(data);
          const dataNote = (data as { note?: string }).note;
          if (dataNote) {
            useFeeds.getState().setFeed({
              id: d.id,
              label: d.title,
              status: 'amber',
              note: dataNote,
            });
          } else {
            useFeeds.getState().setFeed({ id: d.id, label: d.title, status: 'green', lastSeen: Date.now() });
          }
        } catch (e) {
          if ((e as DOMException)?.name === 'AbortError') return;
          useFeeds.getState().setFeed({ id: d.id, label: d.title, status: 'red', note: 'transport error' });
        }
      };
      void pull();
      const id = window.setInterval(pull, (d.refresh.ttlSec ?? 30) * 1000);
      timers.set(d.id, id);
    };

    // initial
    for (const d of registry.list()) {
      if (registry.isEnabled(d.id)) attach(d);
    }

    // subscribe to changes
    const unsub = registry.subscribe((e) => {
      if (e.type === 'register' && registry.isEnabled(e.layer.id)) attach(e.layer);
      else if (e.type === 'enable') {
        const d = registry.get(e.id);
        if (d) attach(d);
      } else if (e.type === 'disable' || e.type === 'unregister') {
        detach(e.id);
      }
    });

    // click → select
    const onClick = (ev: maplibregl.MapMouseEvent) => {
      const feats = map.queryRenderedFeatures(ev.point);
      const f = feats[0];
      // Prefer __eid (set on every setData) since feature.id is undefined for
      // non-numeric string ids; fall back to f.id for any future numeric feeds.
      const eid = (f?.properties as { __eid?: unknown } | undefined)?.__eid ?? f?.id;
      useSelection.getState().select(eid != null ? String(eid) : null);
    };
    map.on('click', onClick);

    return () => {
      unsub();
      for (const id of [...timers.keys()]) detach(id);
      map.off('click', onClick);
    };
  }, [registry, ready]);

  // Selection track polyline — magenta/violet line through the selected
  // entity's last ~60 positions, mirroring the Cesium `__selectionTrack`
  // overlay. Owns its own source + layer so it never collides with the
  // registry-driven feed layers above.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const SRC = '__selectionTrack';
    const LYR = '__selectionTrack__line';
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: empty });
      // Wider dark casing under the magenta line — same trick as a road
      // casing — so the trail stays visible against bright basemap tiles.
      map.addLayer({
        id: `${LYR}__outline`,
        type: 'line',
        source: SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#000',
          'line-opacity': 0.5,
          'line-width': 8,
        },
      });
      map.addLayer({
        id: LYR,
        type: 'line',
        source: SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#d946ef',
          'line-width': 5,
          'line-opacity': 0.95,
          'line-blur': 1,
        },
      });
    }

    const render = (id: string | null) => {
      const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      if (!id) {
        src.setData(empty);
        return;
      }
      const pts = tracks.get(id);
      if (pts.length < 2) {
        src.setData(empty);
        return;
      }
      const coords: [number, number][] = new Array(pts.length);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        coords[i] = [p.lon, p.lat];
      }
      src.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: {},
          },
        ],
      });
    };

    let currentId = useSelection.getState().selectedEntityId;
    let lastLen = 0;
    const tick = () => {
      if (!currentId) return;
      const len = tracks.get(currentId).length;
      if (len !== lastLen) {
        lastLen = len;
        render(currentId);
      }
    };
    render(currentId);
    lastLen = currentId ? tracks.get(currentId).length : 0;

    const unsub = useSelection.subscribe((s) => {
      if (s.selectedEntityId === currentId) return;
      currentId = s.selectedEntityId;
      lastLen = currentId ? tracks.get(currentId).length : 0;
      render(currentId);
    });
    const timer = window.setInterval(tick, 1000);

    return () => {
      unsub();
      window.clearInterval(timer);
      if (map.getLayer(LYR)) map.removeLayer(LYR);
      if (map.getLayer(`${LYR}__outline`)) map.removeLayer(`${LYR}__outline`);
      if (map.getSource(SRC)) map.removeSource(SRC);
    };
  }, [ready]);

  return <div ref={containerRef} className="h-full w-full" data-testid="maplibre-container" />;
}
