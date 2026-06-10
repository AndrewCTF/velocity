// Minimal local typings for @macrostrat/cesium-martini@1.6.0 (no bundled
// .d.ts). Surface kept to what GlobeCanvas uses — extend if more is needed.
declare module '@macrostrat/cesium-martini' {
  import type { TerrainProvider, TilingScheme, Ellipsoid } from 'cesium';

  export interface DefaultHeightmapResourceOpts {
    url?: string;
    skipOddLevels?: boolean;
    skipZoomLevels?: [number] | ((z: number) => boolean);
    maxZoom?: number;
    tileSize?: number;
  }

  export class DefaultHeightmapResource {
    constructor(opts?: DefaultHeightmapResourceOpts);
  }

  export interface MartiniTerrainOpts {
    resource: DefaultHeightmapResource;
    ellipsoid?: Ellipsoid;
    tilingScheme?: TilingScheme;
    detailScalar?: number;
    minimumErrorLevel?: number;
    maxWorkers?: number;
    minZoomLevel?: number;
    fillPoles?: boolean;
  }

  export class MartiniTerrainProvider {
    constructor(opts: MartiniTerrainOpts);
  }

  export interface MapboxTerrainOpts extends Omit<MartiniTerrainOpts, 'resource'> {
    urlTemplate?: string;
    accessToken?: string;
    highResolution?: boolean;
    imageFormat?: 'webp' | 'png' | 'pngraw';
    maxZoom?: number;
    tileSize?: number;
    skipOddLevels?: boolean;
  }

  export class MapboxTerrainProvider {
    constructor(opts?: MapboxTerrainOpts);
  }

  const _default: typeof MapboxTerrainProvider;
  export default _default;

  // Re-exported for completeness; not used directly.
  export const MapboxTerrainResource: unknown;
  export const StretchedTilingScheme: unknown;
  export type { TerrainProvider };
}
