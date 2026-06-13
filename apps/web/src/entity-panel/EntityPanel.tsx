import { useEffect, useState } from 'react';
import * as Cesium from 'cesium';
import { useSelection, useAlerts } from '../state/stores.js';
import { tracks } from '../intel/tracks.js';
import { fetchEnrichment, type Enrichment } from '../transport/entity.js';
import { flyToPosition, followEntity, stopFollow } from '../globe/camera.js';
import { Sparkline } from './Sparkline.js';
import { CameraCard } from './CameraCard.js';
import type { Alert } from '@osint/shared';
import { apiFetch } from '../transport/http.js';

interface Props {
  viewer?: Cesium.Viewer | null;
}

interface PanelSnapshot {
  id: string;
  name?: string;
  kind?: string;
  position?: { lon: number; lat: number; alt: number };
  properties: Record<string, unknown>;
}

export function EntityPanel({ viewer }: Props = {}): JSX.Element {
  const id = useSelection((s) => s.selectedEntityId);
  const [snap, setSnap] = useState<PanelSnapshot | null>(null);
  const [enrichment, setEnrichment] = useState<Enrichment | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [track, setTrack] = useState(tracks.get(id ?? ''));

  // Snapshot the selected entity continuously so values update in place.
  useEffect(() => {
    setSnap(null);
    setTrack(tracks.get(id ?? ''));
    if (!viewer || !id) return;
    const tick = () => {
      const e = findEntity(viewer, id);
      if (!e) return;
      const props = readProperties(e);
      const pos = readPosition(e, viewer);
      const next: PanelSnapshot = { id, properties: props };
      if (e.name) next.name = e.name;
      if (props['kind']) next.kind = String(props['kind']);
      if (pos) next.position = pos;
      setSnap(next);
      setTrack(tracks.get(id));
    };
    tick();
    const remove = viewer.scene.preRender.addEventListener(throttle(tick, 500));
    return () => remove();
  }, [id, viewer]);

  // Re-read the tracks ring at 1Hz, independent of scene.preRender. The
  // snapshot tick above only fires when Cesium renders (paused clock or
  // off-screen tab can throttle it to nothing), and the throttle window
  // can also drop the initial read. A bare interval guarantees that the
  // "Track (N fixes)" counter advances as soon as PollGeoJsonAdapter
  // pushes a new fix into the ring — even if the user is staring at a
  // stationary aircraft and nothing else in the snapshot has changed.
  useEffect(() => {
    if (!id) return;
    const t = window.setInterval(() => setTrack(tracks.get(id)), 1000);
    return () => window.clearInterval(t);
  }, [id]);

  // Fire-and-forget enrichment fetch on selection. We also pass the live
  // callsign (when known) so the backend can map it to an airline operator
  // via the built-in ICAO airline prefix table.
  const callsignHint =
    typeof snap?.properties?.['callsign'] === 'string'
      ? (snap.properties['callsign'] as string)
      : null;
  useEffect(() => {
    setEnrichment(null);
    if (!id) return;
    setEnrichLoading(true);
    const aborter = new AbortController();
    fetchEnrichment(id, aborter.signal, { callsign: callsignHint })
      .then((e) => setEnrichment(e))
      .catch(() => undefined)
      .finally(() => setEnrichLoading(false));
    return () => aborter.abort();
  }, [id, callsignHint]);

  // Continuous-follow toggle. Reset when the selection changes; stop following
  // on unmount so the camera doesn't stay locked to a stale entity.
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    setFollowing(false);
    return () => {
      if (viewer) stopFollow(viewer);
    };
  }, [id, viewer]);

  if (!id) {
    return (
      <div className="p-4">
        <h2 className="micro">Selection</h2>
        <p className="mt-2 text-txt-3 text-[11px]">No entity selected. Click an object on the globe.</p>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3">
      <h2 className="micro">Selection</h2>

      <Header snap={snap} id={id} enrichment={enrichment} />

      {snap?.position && viewer && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => flyToPosition(viewer, snap.position!.lon, snap.position!.lat, 350_000, 1.0)}
            className="mono text-[10px] px-2 py-1 border border-line rounded-sm hover:border-accent-line text-txt-1"
          >
            slew to
          </button>
          <button
            type="button"
            onClick={() => {
              if (following) {
                stopFollow(viewer);
                setFollowing(false);
              } else {
                setFollowing(followEntity(viewer, id));
              }
            }}
            className={`mono text-[10px] px-2 py-1 border rounded-sm ${
              following
                ? 'border-accent-line text-accent'
                : 'border-line hover:border-accent-line text-txt-1'
            }`}
          >
            {following ? '◼ following' : '▶ follow'}
          </button>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(`${snap.position!.lat.toFixed(5)},${snap.position!.lon.toFixed(5)}`)}
            className="mono text-[10px] px-2 py-1 border border-line rounded-sm hover:border-accent-line text-txt-1"
          >
            copy lat,lon
          </button>
        </div>
      )}

      {snap?.position && <PositionCard pos={snap.position} />}

      {snap?.kind === 'camera' && typeof snap.properties['cam_id'] === 'string' && (
        <CameraCard
          camId={snap.properties['cam_id']}
          hlsUrl={(snap.properties['hls_url'] as string | null) ?? null}
          attribution={String(snap.properties['attribution'] ?? '')}
        />
      )}

      <TrackCard kind={snap?.kind ?? ''} points={track} />

      <EntityPhotoCard enrichment={enrichment} />

      <EnrichmentCard kind={snap?.kind ?? ''} enrichment={enrichment} loading={enrichLoading} />

      {snap?.properties && Object.keys(snap.properties).length > 0 && (
        <PropertiesCard properties={snap.properties} />
      )}

      <CorrelationCard entityId={id} viewer={viewer ?? null} />
    </div>
  );
}

// ── subcomponents ───────────────────────────────────────────────────────

function Header({
  snap,
  id,
  enrichment,
}: {
  snap: PanelSnapshot | null;
  id: string;
  enrichment: Enrichment | null;
}): JSX.Element {
  const display =
    (enrichment?.kind === 'aircraft' && (enrichment as { registration?: string }).registration) ||
    (enrichment?.kind === 'vessel' && (enrichment as { name?: string }).name) ||
    snap?.name ||
    id;
  const subtitle =
    (enrichment?.kind === 'aircraft' && [
      (enrichment as { operator?: string }).operator,
      (enrichment as { type?: string }).type,
    ]
      .filter(Boolean)
      .join(' · ')) ||
    (enrichment?.kind === 'vessel' && (enrichment as { flag?: string }).flag) ||
    snap?.kind;
  return (
    <header>
      <div className="mono text-[14px] text-txt-0 truncate" title={String(display)}>{display}</div>
      {subtitle && <div className="micro mt-0.5">{subtitle}</div>}
      <div className="micro mt-0.5 text-txt-3">id: <span className="mono">{id}</span></div>
    </header>
  );
}

function PositionCard({ pos }: { pos: { lon: number; lat: number; alt: number } }): JSX.Element {
  return (
    <section>
      <h3 className="micro">Position</h3>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        <dt className="text-txt-3">lat</dt>
        <dd className="mono text-right">{pos.lat.toFixed(5)}°</dd>
        <dt className="text-txt-3">lon</dt>
        <dd className="mono text-right">{pos.lon.toFixed(5)}°</dd>
        <dt className="text-txt-3">alt (m)</dt>
        <dd className="mono text-right">{Math.round(pos.alt).toLocaleString()}</dd>
      </dl>
    </section>
  );
}

function TrackCard({
  kind,
  points,
}: {
  kind: string;
  points: readonly { t: number; lon: number; lat: number; alt: number; sog?: number; track?: number }[];
}): JSX.Element {
  return (
    <section>
      <h3 className="micro">Track ({points.length} fixes)</h3>
      <div className="mt-1 space-y-1">
        {kind === 'aircraft' && <Sparkline points={points} field="alt" label="alt" unit="m" />}
        {(kind === 'aircraft' || kind === 'vessel') && (
          <Sparkline points={points} field="sog" label={kind === 'aircraft' ? 'velocity m/s' : 'sog kn'} />
        )}
      </div>
    </section>
  );
}

function EntityPhotoCard({
  enrichment,
}: {
  enrichment: Enrichment | null;
}): JSX.Element | null {
  if (!enrichment) return null;
  const e = enrichment as {
    photo_thumb_url?: string | null;
    photo_full_url?: string | null;
    photo_photographer?: string | null;
    photo_link?: string | null;
    photo_license?: string | null;
    photo_credit?: string | null;
    description?: string | null;
  };
  const thumb = e.photo_thumb_url ?? null;
  const desc = e.description ?? null;
  if (!thumb && !desc) return null;
  // Prefer photographer (Planespotters) → photo_credit (Wikipedia) → 'source'.
  const creditName = e.photo_photographer || e.photo_credit || null;
  const license = e.photo_license || null;
  const link = e.photo_link || null;
  return (
    <section>
      <h3 className="micro">Photo</h3>
      {thumb && (
        <div className="mt-1">
          <img
            src={thumb}
            alt="entity reference"
            loading="lazy"
            className="block w-full max-w-[280px] rounded-sm border border-line"
          />
          {(creditName || license || link) && (
            <p className="mono text-[10px] text-txt-3 mt-1 truncate">
              {link ? (
                <a href={link} target="_blank" rel="noreferrer" className="hover:underline">
                  {creditName ?? 'photo'}
                </a>
              ) : (
                <span>{creditName ?? 'photo'}</span>
              )}
              {license ? ` · ${license}` : ''}
            </p>
          )}
        </div>
      )}
      {desc && (
        <p className="text-[11px] text-txt-1 leading-snug mt-2 line-clamp-3">
          {desc}
        </p>
      )}
    </section>
  );
}

function EnrichmentCard({
  kind,
  enrichment,
  loading,
}: {
  kind: string;
  enrichment: Enrichment | null;
  loading: boolean;
}): JSX.Element | null {
  if (loading) {
    return (
      <section>
        <h3 className="micro">Enrichment</h3>
        <p className="micro">resolving…</p>
      </section>
    );
  }
  if (!enrichment) return null;
  // Keys we render specially (links / formatted) — skip them in the generic
  // property grid so we don't show them twice. Photo + description fields
  // are owned by EntityPhotoCard above us; suppress them here so we don't
  // dump raw URLs into the property grid.
  const specialKeys = new Set([
    'kind',
    'source',
    'wikidata_url',
    'note',
    'url',
    'photo_thumb_url',
    'photo_full_url',
    'photo_photographer',
    'photo_link',
    'photo_license',
    'photo_credit',
    'description',
  ]);
  const note = (enrichment as { note?: string }).note;
  const wikidata = (enrichment as { wikidata_url?: string }).wikidata_url;
  return (
    <section>
      <h3 className="micro">Enrichment{enrichment.source ? ` · ${enrichment.source}` : ''}</h3>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        {Object.entries(enrichment)
          .filter(([k]) => !specialKeys.has(k))
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .slice(0, 20)
          .map(([k, v]) => (
            <PropRow key={k} k={k} v={v} />
          ))}
      </dl>
      {note && <p className="micro mt-1 text-txt-3">{note}</p>}
      <div className="flex flex-wrap gap-2 mt-1">
        {wikidata && (
          <a
            href={wikidata}
            target="_blank"
            rel="noreferrer"
            className="mono text-[10px] text-accent hover:underline"
          >
            wikidata →
          </a>
        )}
        {kind === 'quake' && (enrichment as { url?: string }).url && (
          <a
            href={(enrichment as { url: string }).url}
            target="_blank"
            rel="noreferrer"
            className="mono text-[10px] text-accent hover:underline"
          >
            usgs detail →
          </a>
        )}
      </div>
    </section>
  );
}

function PropertiesCard({ properties }: { properties: Record<string, unknown> }): JSX.Element {
  return (
    <section>
      <h3 className="micro">Live properties</h3>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        {Object.entries(properties)
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .slice(0, 16)
          .map(([k, v]) => (
            <PropRow key={k} k={k} v={v} />
          ))}
      </dl>
    </section>
  );
}

interface CorrelationsResponse {
  entityId: string;
  correlations: Alert[];
}

function CorrelationCard({
  entityId,
  viewer,
}: {
  entityId: string | null;
  viewer?: Cesium.Viewer | null;
}): JSX.Element {
  const liveAlerts = useAlerts((s) => s.alerts);
  const [history, setHistory] = useState<Alert[]>([]);

  // Backfill historical correlations on selection change.
  useEffect(() => {
    setHistory([]);
    if (!entityId) return;
    const aborter = new AbortController();
    apiFetch(`/api/correlations/${encodeURIComponent(entityId)}`, { signal: aborter.signal })
      .then((r) => (r.ok ? (r.json() as Promise<CorrelationsResponse>) : null))
      .then((j) => {
        if (j) setHistory(j.correlations);
      })
      .catch(() => undefined);
    return () => aborter.abort();
  }, [entityId]);

  // Merge live + backfilled, dedup by id, filter to this entity, newest first.
  const matches: Alert[] = entityId
    ? [...liveAlerts, ...history]
        .filter((a) => a.contributingObservations?.includes(entityId))
        .reduce<Alert[]>((acc, a) => {
          if (!acc.some((x) => x.id === a.id)) acc.push(a);
          return acc;
        }, [])
        .sort((a, b) => b.t - a.t)
        .slice(0, 12)
    : [];

  if (!entityId) {
    return (
      <section>
        <h3 className="micro">Correlations</h3>
        <p className="text-[11px] text-txt-3">no entity selected</p>
      </section>
    );
  }
  if (matches.length === 0) {
    return (
      <section>
        <h3 className="micro">Correlations</h3>
        <p className="text-[11px] text-txt-3">no correlations in window</p>
      </section>
    );
  }
  return (
    <section>
      <h3 className="micro">Correlations</h3>
      <ul className="mt-1 space-y-1">
        {matches.map((a) => (
          <li key={a.id} className="border border-line rounded-sm p-2 bg-bg-2/60">
            <div className="flex items-baseline justify-between gap-2">
              <span className={`micro ${sevClass(a.severity)}`}>{a.severity}</span>
              <span className="mono micro tabular-nums">{a.ruleId}</span>
            </div>
            <p className="text-[11px] text-txt-1 leading-tight mt-1">{a.message}</p>
            <div className="flex gap-2 mt-1">
              <button
                type="button"
                onClick={() => {
                  if (viewer && a.geom?.type === 'Point') {
                    const [lon, lat] = a.geom.coordinates as [number, number];
                    flyToPosition(viewer, lon, lat, 200_000, 1.0);
                  }
                }}
                className="mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm hover:border-accent-line text-txt-1"
              >
                slew to
              </button>
              <span className="mono micro tabular-nums text-txt-3">
                {new Date(a.t).toISOString().slice(11, 19)}Z
              </span>
              <span className="mono micro tabular-nums text-txt-3">
                conf {(a.confidence * 100).toFixed(0)}%
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function sevClass(s: string): string {
  switch (s) {
    case 'critical':
    case 'high':
      return 'text-alert';
    case 'medium':
      return 'text-warn';
    case 'low':
      // --sev-low ≡ txt-1, kept distinct from the teal selection accent.
      return 'text-[var(--sev-low)]';
    default:
      return 'text-txt-2';
  }
}

function PropRow({ k, v }: { k: string; v: unknown }): JSX.Element {
  return (
    <>
      <dt className="text-txt-3">{k}</dt>
      <dd className="mono text-right truncate">{format(v)}</dd>
    </>
  );
}

function format(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '✓' : '—';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function findEntity(viewer: Cesium.Viewer, id: string): Cesium.Entity | undefined {
  for (let i = 0; i < viewer.dataSources.length; i++) {
    const ds = viewer.dataSources.get(i);
    const e = ds.entities.getById(id);
    if (e) return e;
  }
  return viewer.entities.getById(id);
}

function readProperties(e: Cesium.Entity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = e.properties;
  if (!props) return out;
  const names = props.propertyNames as readonly string[] | undefined;
  if (!names) return out;
  const now = Cesium.JulianDate.now();
  for (const n of names) {
    const p = (props as unknown as Record<string, Cesium.Property | undefined>)[n];
    if (!p) continue;
    try {
      out[n] = p.getValue(now);
    } catch {
      /* skip */
    }
  }
  return out;
}

function readPosition(
  e: Cesium.Entity,
  viewer: Cesium.Viewer,
): { lon: number; lat: number; alt: number } | undefined {
  if (!e.position) return undefined;
  const t = viewer.clock.currentTime;
  const cart = e.position.getValue(t);
  if (!cart) return undefined;
  const c = Cesium.Cartographic.fromCartesian(cart);
  return {
    lon: Cesium.Math.toDegrees(c.longitude),
    lat: Cesium.Math.toDegrees(c.latitude),
    alt: c.height,
  };
}

function throttle<T extends () => void>(fn: T, ms: number): T {
  let last = 0;
  return ((): void => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn();
  }) as T;
}
