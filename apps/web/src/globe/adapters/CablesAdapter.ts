import * as Cesium from 'cesium';
import type { LayerAdapter, AdapterCtx } from './types.js';
import { colors } from './styles.js';
import { apiFetch } from '../../transport/http.js';

interface Props {
  ctx: AdapterCtx;
  endpoint: string;
  kind: 'lines' | 'landings';
}

interface CableLine {
  type: 'Feature';
  properties: { id?: string; name?: string; rfs?: string | number; length?: number };
  geometry: { type: 'MultiLineString'; coordinates: Array<Array<[number, number]>> } |
            { type: 'LineString'; coordinates: Array<[number, number]> };
}

interface Landing {
  type: 'Feature';
  properties: { id?: string; name?: string; city?: string };
  geometry: { type: 'Point'; coordinates: [number, number] };
}

interface FC {
  features: Array<CableLine | Landing>;
}

// Submarine cables: drawn as accent-coloured polylines hugging the surface.
// Landings: small accent points at port shore-ends.
export class CablesAdapter implements LayerAdapter {
  private ds: Cesium.CustomDataSource;
  private aborter: AbortController | null = null;

  constructor(private readonly props: Props) {
    this.ds = new Cesium.CustomDataSource(props.ctx.descriptor.id);
  }

  async attach(viewer: Cesium.Viewer): Promise<void> {
    await viewer.dataSources.add(this.ds);
    await this.fetchOnce();
  }

  detach(): void {
    this.aborter?.abort();
    try {
      this.props.ctx.viewer.dataSources.remove(this.ds, true);
    } catch {
      /* gone */
    }
  }

  private async fetchOnce(): Promise<void> {
    this.aborter = new AbortController();
    try {
      const r = await apiFetch(this.props.endpoint, { signal: this.aborter.signal });
      if (!r.ok) {
        this.props.ctx.reportStatus({ status: 'red', note: `upstream ${r.status}` });
        return;
      }
      const fc = (await r.json()) as FC;
      this.render(fc);
      this.props.ctx.reportStatus({ status: 'green', lastSeen: Date.now() });
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
      this.props.ctx.reportStatus({ status: 'red', note: 'transport error' });
    }
  }

  private render(fc: FC): void {
    const entities = this.ds.entities;
    entities.suspendEvents();
    entities.removeAll();
    const accentMat = new Cesium.ColorMaterialProperty(colors.accent().withAlpha(0.55));
    for (const f of fc.features ?? []) {
      if (this.props.kind === 'lines') {
        const lines: Array<Array<[number, number]>> = [];
        const g = f.geometry;
        if (g.type === 'LineString') lines.push(g.coordinates as Array<[number, number]>);
        else if (g.type === 'MultiLineString') lines.push(...(g.coordinates as Array<Array<[number, number]>>));
        else continue;
        for (let i = 0; i < lines.length; i++) {
          const pts = lines[i];
          if (!pts || pts.length < 2) continue;
          const lineOpts: Cesium.Entity.ConstructorOptions = {
            id: `cable:${f.properties?.id ?? f.properties?.name ?? 'x'}:${i}`,
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(pts.flatMap((p) => [p[0], p[1]])),
              width: 1.2,
              material: accentMat,
              clampToGround: false,
            },
            properties: { kind: 'cable', name: f.properties?.name },
          };
          if (f.properties?.name) lineOpts.name = f.properties.name;
          entities.add(lineOpts);
        }
      } else {
        const g = f.geometry;
        if (g.type !== 'Point') continue;
        const [lon, lat] = g.coordinates;
        const landOpts: Cesium.Entity.ConstructorOptions = {
          id: `landing:${f.properties?.id ?? f.properties?.name ?? `${lon},${lat}`}`,
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          point: {
            color: colors.accent(),
            pixelSize: 4,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
          },
          properties: {
            kind: 'cable_landing',
            name: f.properties?.name,
            city: (f.properties as { city?: string }).city,
          },
        };
        if (f.properties?.name) landOpts.name = f.properties.name;
        entities.add(landOpts);
      }
    }
    entities.resumeEvents();
    this.props.ctx.viewer.scene.requestRender();
  }
}
