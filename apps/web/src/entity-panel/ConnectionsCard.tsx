import { useEffect, useMemo, useState } from 'react';
import * as Cesium from 'cesium';
import type { Alert } from '@osint/shared';
import { useSelection } from '../state/stores.js';
import { flyToPosition } from '../globe/camera.js';
import { apiFetch } from '../transport/http.js';
import type { Enrichment, Airport } from '../transport/entity.js';
import { Widget } from '../shell/instruments.js';

// Gotham Object-Explorer-style link analysis: the selected entity at the centre
// with its first-order connections radiating out — operator, route airports,
// correlated incidents, and the nearest live contacts on the globe. A node with
// an entity id reselects on click; a node with a position slews the camera.

type Tone = 'self' | 'operator' | 'airport' | 'incident' | 'contact';

interface GraphNode {
  key: string;
  label: string;
  sub?: string;
  tone: Tone;
  entityId?: string;
  lon?: number;
  lat?: number;
}

const TONE_COLOR: Record<Tone, string> = {
  self: 'var(--accent)',
  operator: 'var(--txt-1)',
  airport: 'var(--ok)',
  incident: 'var(--alert)',
  contact: 'var(--mag)',
};

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// One pass over the live datasources to find the nearest labelled contacts.
// Runs once per selection (not per frame), so an O(n) scan of ~13k entities is
// acceptable. Skips the selected entity itself.
function nearestContacts(
  viewer: Cesium.Viewer,
  selfId: string,
  lon: number,
  lat: number,
  limit: number,
): GraphNode[] {
  const t = viewer.clock.currentTime;
  const found: { id: string; label: string; dist: number; lon: number; lat: number }[] = [];
  const consider = (e: Cesium.Entity) => {
    if (!e.position || e.id === selfId || !e.billboard) return;
    // Only real contacts — skip helper entities (reticle, track, sim units).
    if (!/^(aircraft|vessel):/.test(e.id)) return;
    let cart: Cesium.Cartesian3 | undefined;
    try {
      cart = e.position.getValue(t);
    } catch {
      return;
    }
    if (!cart) return;
    const c = Cesium.Cartographic.fromCartesian(cart);
    const elon = Cesium.Math.toDegrees(c.longitude);
    const elat = Cesium.Math.toDegrees(c.latitude);
    const dist = haversineKm(lat, lon, elat, elon);
    if (dist > 250) return; // first-order = same neighbourhood
    found.push({ id: e.id, label: e.name || e.id, dist, lon: elon, lat: elat });
  };
  for (let i = 0; i < viewer.dataSources.length; i++) {
    const ds = viewer.dataSources.get(i);
    const vals = ds.entities.values;
    for (const e of vals) consider(e);
  }
  found.sort((a, b) => a.dist - b.dist);
  return found.slice(0, limit).map((f) => ({
    key: `c:${f.id}`,
    label: f.label,
    sub: `${Math.round(f.dist)} km`,
    tone: 'contact' as Tone,
    entityId: f.id,
    lon: f.lon,
    lat: f.lat,
  }));
}

function airportNode(a: Airport | null | undefined, role: string): GraphNode | null {
  if (!a) return null;
  const code = a.iata || a.icao;
  if (!code) return null;
  const node: GraphNode = {
    key: `ap:${role}:${code}`,
    label: code,
    sub: role,
    tone: 'airport',
  };
  if (a.lat != null && a.lon != null) {
    node.lon = a.lon;
    node.lat = a.lat;
  }
  return node;
}

export function ConnectionsCard({
  entityId,
  enrichment,
  viewer,
  position,
}: {
  entityId: string;
  enrichment: Enrichment | null;
  viewer?: Cesium.Viewer | null;
  position?: { lon: number; lat: number; alt: number };
}): JSX.Element | null {
  const [incidents, setIncidents] = useState<Alert[]>([]);
  const [contacts, setContacts] = useState<GraphNode[]>([]);

  useEffect(() => {
    setIncidents([]);
    const aborter = new AbortController();
    apiFetch(`/api/correlations/${encodeURIComponent(entityId)}`, { signal: aborter.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ correlations: Alert[] }>) : null))
      .then((j) => {
        if (j) setIncidents(j.correlations.slice(0, 3));
      })
      .catch(() => undefined);
    return () => aborter.abort();
  }, [entityId]);

  useEffect(() => {
    if (!viewer || !position || viewer.isDestroyed()) {
      setContacts([]);
      return;
    }
    setContacts(nearestContacts(viewer, entityId, position.lon, position.lat, 4));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- track primitive lon/lat, not the recreated object ref
  }, [viewer, entityId, position?.lon, position?.lat]);

  const nodes = useMemo<GraphNode[]>(() => {
    const out: GraphNode[] = [];
    if (enrichment?.kind === 'aircraft') {
      const e = enrichment as { operator?: string | null; origin?: Airport | null; destination?: Airport | null };
      if (e.operator) out.push({ key: 'op', label: e.operator, sub: 'operator', tone: 'operator' });
      const o = airportNode(e.origin, 'from');
      const d = airportNode(e.destination, 'to');
      if (o) out.push(o);
      if (d) out.push(d);
    } else if (enrichment?.kind === 'vessel') {
      const e = enrichment as { flag?: string | null; nearest_port?: string | null };
      if (e.flag) out.push({ key: 'flag', label: e.flag, sub: 'flag', tone: 'operator' });
      if (e.nearest_port) out.push({ key: 'port', label: e.nearest_port, sub: 'nearest port', tone: 'airport' });
    }
    for (const inc of incidents) {
      out.push({ key: `i:${inc.id}`, label: inc.ruleId || inc.severity, sub: 'incident', tone: 'incident' });
    }
    out.push(...contacts);
    return out.slice(0, 8);
  }, [enrichment, incidents, contacts]);

  if (nodes.length === 0) return null;

  const W = 280;
  const H = 188;
  const cx = W / 2;
  const cy = H / 2;
  const R = 70;
  const selfLabel =
    (enrichment?.kind === 'aircraft' && (enrichment as { registration?: string }).registration) ||
    (enrichment?.kind === 'vessel' && (enrichment as { name?: string }).name) ||
    entityId;

  const onClick = (n: GraphNode) => {
    if (n.entityId) {
      useSelection.getState().select(n.entityId);
    } else if (viewer && n.lon != null && n.lat != null) {
      flyToPosition(viewer, n.lon, n.lat, 400_000, 1.0);
    }
  };

  return (
    <Widget title="Connections" count={nodes.length}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 200 }}>
        {nodes.map((n, i) => {
          const a = -Math.PI / 2 + (i / nodes.length) * 2 * Math.PI;
          const x = cx + R * Math.cos(a);
          const y = cy + R * Math.sin(a);
          return (
            <line key={`e${n.key}`} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--line-2)" strokeWidth={1} />
          );
        })}
        {/* centre node */}
        <circle cx={cx} cy={cy} r={6} fill="var(--accent)" />
        <text
          x={cx}
          y={cy + 18}
          textAnchor="middle"
          fontFamily="IBM Plex Mono, monospace"
          fontSize={9}
          fill="var(--txt-0)"
        >
          {String(selfLabel).slice(0, 16)}
        </text>
        {nodes.map((n, i) => {
          const a = -Math.PI / 2 + (i / nodes.length) * 2 * Math.PI;
          const x = cx + R * Math.cos(a);
          const y = cy + R * Math.sin(a);
          const anchor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
          const dx = anchor === 'start' ? 7 : anchor === 'end' ? -7 : 0;
          return (
            <g key={n.key} style={{ cursor: 'pointer' }} onClick={() => onClick(n)}>
              <circle cx={x} cy={y} r={4.5} fill={TONE_COLOR[n.tone]} />
              <text
                x={x + dx}
                y={y + 3}
                textAnchor={anchor}
                fontFamily="IBM Plex Mono, monospace"
                fontSize={8.5}
                fill="var(--txt-1)"
              >
                {n.label.slice(0, 14)}
              </text>
            </g>
          );
        })}
      </svg>
    </Widget>
  );
}
