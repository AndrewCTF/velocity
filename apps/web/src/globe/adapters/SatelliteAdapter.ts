import * as Cesium from 'cesium';
import {
  twoline2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  degreesLat,
  degreesLong,
  type SatRec,
} from 'satellite.js';
import type { LayerAdapter, AdapterCtx } from './types.js';
import { satelliteStyle } from './styles.js';
import { apiFetch } from '../../transport/http.js';

interface Props {
  ctx: AdapterCtx;
  endpoint: string;
  group: string;
  refreshSec: number;
}

interface OmmRecord {
  OBJECT_NAME: string;
  NORAD_CAT_ID: number;
  TLE_LINE1?: string;
  TLE_LINE2?: string;
  // Some OMM JSON variants embed elements without TLE_LINE1/2 fields. The
  // adapter falls back to constructing TLEs from MEAN_MOTION / ECCENTRICITY
  // etc. only if you wire it in; for now we require TLE_LINE1/2.
}

const MAX_SATS = 4000; // hard cap to keep frame budget healthy

// Polls CelesTrak (every refreshSec) for the active group's two-line elements
// and propagates positions on a 5s tick. Each tick reassigns a
// ConstantPositionProperty per satellite — orbits are never baked into
// samples, so a TLE refresh is just a map rebuild.
export class SatelliteAdapter implements LayerAdapter {
  private ds: Cesium.CustomDataSource;
  private satrecs = new Map<string, { rec: SatRec; name: string }>();
  private fetchTimer: number | null = null;
  private propTimer: number | null = null;
  private aborter: AbortController | null = null;

  constructor(private readonly props: Props) {
    this.ds = new Cesium.CustomDataSource(props.ctx.descriptor.id);
  }

  async attach(viewer: Cesium.Viewer): Promise<void> {
    await viewer.dataSources.add(this.ds);
    await this.refreshTles();
    this.fetchTimer = window.setInterval(() => void this.refreshTles(), this.props.refreshSec * 1000);
    this.propTimer = window.setInterval(() => this.propagate(), 5_000);
  }

  detach(): void {
    if (this.fetchTimer != null) window.clearInterval(this.fetchTimer);
    if (this.propTimer != null) window.clearInterval(this.propTimer);
    this.aborter?.abort();
    try {
      this.props.ctx.viewer.dataSources.remove(this.ds, true);
    } catch {
      /* gone */
    }
  }

  private async refreshTles(): Promise<void> {
    this.aborter?.abort();
    this.aborter = new AbortController();
    try {
      const r = await apiFetch(this.props.endpoint, { signal: this.aborter.signal });
      if (!r.ok) {
        this.props.ctx.reportStatus({ status: 'red', note: `upstream ${r.status}` });
        return;
      }
      const j = (await r.json()) as { items: OmmRecord[] };
      const items = (j.items ?? []).slice(0, MAX_SATS);
      // Rebuild satrec map from scratch when we re-poll TLEs (rare — 2h)
      const next = new Map<string, { rec: SatRec; name: string }>();
      for (const r of items) {
        const l1 = r.TLE_LINE1;
        const l2 = r.TLE_LINE2;
        if (!l1 || !l2) continue;
        try {
          const rec = twoline2satrec(l1, l2);
          if (rec.error) continue;
          next.set(`sat:${r.NORAD_CAT_ID}`, { rec, name: (r.OBJECT_NAME || '').trim() });
        } catch {
          /* malformed TLE */
        }
      }
      this.satrecs = next;
      this.props.ctx.reportStatus({
        status: items.length > 0 ? 'green' : 'amber',
        lastSeen: Date.now(),
        ...(items.length === 0 && { note: 'no TLEs returned' }),
      });
      this.propagate(); // immediate redraw
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
      this.props.ctx.reportStatus({ status: 'red', note: 'transport error' });
    }
  }

  private propagate(): void {
    const now = new Date();
    const gmst = gstime(now);
    const entities = this.ds.entities;
    entities.suspendEvents();
    const style = satelliteStyle();
    const seen = new Set<string>();
    for (const [id, { rec, name }] of this.satrecs) {
      const r = propagate(rec, now);
      if (!r || !r.position || typeof r.position === 'boolean') continue;
      const g = eciToGeodetic(r.position, gmst);
      const lat = degreesLat(g.latitude);
      const lon = degreesLong(g.longitude);
      const alt = g.height * 1000;
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) continue;
      const pos = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
      seen.add(id);
      const ex = entities.getById(id);
      if (ex) {
        ex.position = new Cesium.ConstantPositionProperty(pos);
      } else {
        entities.add({
          id,
          position: pos,
          billboard: {
            image: style.imageUri,
            scale: style.scale,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60_000_000),
            color: style.color,
          },
          name,
          properties: { kind: 'satellite', name, noradId: id.split(':')[1] },
        });
      }
    }
    // prune satellites that fell out of the catalog
    for (const e of [...entities.values]) {
      if (!seen.has(e.id)) entities.removeById(e.id);
    }
    entities.resumeEvents();
    this.props.ctx.viewer.scene.requestRender();
  }
}
