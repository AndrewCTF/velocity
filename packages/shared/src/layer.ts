// Source of truth: research_updated.md §1.1
// A LayerDescriptor describes any data source the platform can render or ingest.
// Both Cesium and MapLibre adapters consume the same descriptor.

export type LayerGroup =
  | 'conflict'
  | 'maritime'
  | 'aviation'
  | 'space'
  | 'rf'
  | 'env'
  | 'cyber'
  | 'seismic'
  | 'infra'
  | 'news'
  | 'imagery'
  | 'reference'
  | 'hazards'
  | 'signals';

export type LayerKind =
  | 'tile-raster'
  | 'tile-vector'
  | 'wms'
  | 'wmts'
  | 'geojson'
  | 'czml'
  | 'websocket'
  | 'stac'
  | 'cog'
  | '3dtiles';

export type LayerAuth =
  | 'none'
  | 'apikey'
  | 'bearer'
  | 'oauth2-cc'
  | 'netrc'
  | 'earthdata';

export type LayerCrs =
  | 'EPSG:4326'
  | 'EPSG:3857'
  | 'CRS:84'
  | 'ECI'
  | 'ECEF';

export type EmitsKind =
  | 'vessel'
  | 'aircraft'
  | 'satellite'
  | 'emitter'
  | 'event'
  | 'outage'
  | 'detection'
  | 'quake'
  | 'fire'
  | 'camera';

export interface LayerRefresh {
  mode: 'pull' | 'push' | 'static';
  ttlSec?: number;
}

export interface LayerTime {
  temporal: boolean;
  from?: string; // ISO 8601
  to?: string;
  step?: string; // ISO 8601 duration, e.g. 'PT15S'
}

export interface LayerDescriptor {
  id: string;
  group: LayerGroup;
  title: string;
  kind: LayerKind;
  auth: LayerAuth;
  endpoint: string;
  refresh: LayerRefresh;
  time: LayerTime;
  crs: LayerCrs;
  license: string;
  opacity: number;
  visibleByDefault: boolean;
  emits?: readonly EmitsKind[];
  /**
   * Hard client-side entity cap for this layer, applied as the existing stable
   * subset (hash-keyed, so the SAME features persist across polls — a random
   * per-poll subset churns the upsert and freezes motion).
   *
   * There was no per-layer cap at all: `MAX_PER_LAYER` was
   * `Number.MAX_SAFE_INTEGER`. Measured 2026-07-27 with every toggle on, that
   * left 59942 Cesium entities across 78 data sources at 5 fps, and the single
   * largest layer was not aircraft but NASA FIRMS at 14818 fire detections.
   * Cesium walks every entity of every data source every frame, so an uncapped
   * long-tail layer costs exactly as much as the feed everyone actually watches.
   *
   * Omit to inherit the kind's default (globe/adapters/PollGeoJsonAdapter
   * `effectiveLayerCap`). Aircraft stay exempt on desktop: the operator
   * invariant requires >= 8000 in the world view.
   */
  maxEntities?: number;
}

export function isLayerDescriptor(v: unknown): v is LayerDescriptor {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d['id'] === 'string' &&
    typeof d['group'] === 'string' &&
    typeof d['title'] === 'string' &&
    typeof d['kind'] === 'string' &&
    typeof d['auth'] === 'string' &&
    typeof d['endpoint'] === 'string' &&
    typeof d['license'] === 'string' &&
    typeof d['opacity'] === 'number' &&
    typeof d['visibleByDefault'] === 'boolean' &&
    typeof d['refresh'] === 'object' &&
    d['refresh'] !== null &&
    typeof d['time'] === 'object' &&
    d['time'] !== null
  );
}
