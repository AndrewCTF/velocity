import { useEffect, useState } from 'react';
import * as Cesium from 'cesium';
import { useSelection, useAlerts } from '../state/stores.js';
import { tracks } from '../intel/tracks.js';
import { fetchEnrichment, type Enrichment, type Airport } from '../transport/entity.js';
import { flyToPosition, followEntity, stopFollow } from '../globe/camera.js';
import { Sparkline } from './Sparkline.js';
import { CameraCard } from './CameraCard.js';
import type { Alert } from '@osint/shared';
import { apiFetch } from '../transport/http.js';
import {
  SectionLabel,
  Badge,
  KV,
  KVRow,
  Btn,
  Hero,
  IconTile,
  Widget,
  type BadgeTone,
} from '../shell/instruments.js';
import { ConnectionsCard } from './ConnectionsCard.js';
import { resolveAircraftFamily, aircraftSilhouette, vesselSilhouette } from './silhouettes.js';

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
      // A destroyed viewer (HMR / globe ErrorBoundary) throws on .dataSources.
      if (viewer.isDestroyed()) return;
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
        <SectionLabel title="Selection" />
        <p className="mt-2 text-txt-3 text-[11px]">No entity selected. Click an object on the globe.</p>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3">
      <SectionLabel title="Selection" />

      <Header snap={snap} id={id} enrichment={enrichment} />

      <ProfileCard enrichment={enrichment} snap={snap} />

      {snap && <StatsCard snap={snap} />}

      {snap && <FlightCard enrichment={enrichment} snap={snap} />}

      {snap?.position && viewer && (
        <div className="flex flex-wrap gap-2">
          <Btn
            tone="accent"
            size="sm"
            onClick={() => flyToPosition(viewer, snap.position!.lon, snap.position!.lat, 350_000, 1.0)}
          >
            → Slew
          </Btn>
          <Btn
            size="sm"
            onClick={() => {
              if (following) {
                stopFollow(viewer);
                setFollowing(false);
              } else {
                setFollowing(followEntity(viewer, id));
              }
            }}
            className={following ? 'border-accent-line text-accent' : ''}
          >
            {following ? '◼ Following' : '⌖ Follow'}
          </Btn>
          <Btn
            size="sm"
            onClick={() => navigator.clipboard?.writeText(`${snap.position!.lat.toFixed(5)},${snap.position!.lon.toFixed(5)}`)}
          >
            Copy lat,lon
          </Btn>
        </div>
      )}

      {snap?.kind === 'camera' && typeof snap.properties['cam_id'] === 'string' && (
        <CameraCard
          camId={snap.properties['cam_id']}
          hlsUrl={(snap.properties['hls_url'] as string | null) ?? null}
        />
      )}

      <PatternOfLifeCard id={id} kind={snap?.kind ?? ''} snap={snap} />

      <TrackCard kind={snap?.kind ?? ''} points={track} />

      <ConnectionsCard
        entityId={id}
        enrichment={enrichment}
        viewer={viewer ?? null}
        {...(snap?.position ? { position: snap.position } : {})}
      />

      <EnrichmentCard kind={snap?.kind ?? ''} enrichment={enrichment} loading={enrichLoading} />

      {snap?.properties && Object.keys(snap.properties).length > 0 && (
        <PropertiesCard properties={snap.properties} />
      )}

      <CorrelationCard
        entityId={id}
        viewer={viewer ?? null}
        {...(snap?.position ? { entityPos: snap.position } : {})}
        {...(viewer
          ? {
              onFollow: () => {
                if (following) {
                  stopFollow(viewer);
                  setFollowing(false);
                } else {
                  setFollowing(followEntity(viewer, id));
                }
              },
              following,
            }
          : {})}
      />
    </div>
  );
}

// ── entity kind → category glyph + threat colour ────────────────────────────
// ◆ for dark/unknown, ✈ aircraft, ⛴ vessel. A dark-vessel candidate (the live
// `darkCandidate` flag the SAR layer sets) flips the tile to alert red.
function isDark(snap: PanelSnapshot | null): boolean {
  return snap?.properties?.['darkCandidate'] === true;
}
function glyphFor(snap: PanelSnapshot | null): string {
  if (isDark(snap)) return '◆';
  switch (snap?.kind) {
    case 'aircraft':
      return '✈';
    case 'vessel':
      return '⛴';
    default:
      return '◆';
  }
}
function kindBadgeTone(kind: string | undefined): BadgeTone {
  switch (kind) {
    case 'aircraft':
      return 'accent';
    case 'vessel':
      return 'ok';
    case 'quake':
      return 'warn';
    case 'camera':
      return 'mag';
    default:
      return 'neutral';
  }
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
  // ID line built from the REAL properties we already read: prefer a
  // domain identifier (MMSI / ICAO24), then flag, then last-seen.
  const p = snap?.properties ?? {};
  const idParts: string[] = [];
  if (typeof p['mmsi'] === 'string' || typeof p['mmsi'] === 'number') idParts.push(`MMSI ${p['mmsi']}`);
  if (typeof p['icao24'] === 'string') idParts.push((p['icao24'] as string).toUpperCase());
  const flag =
    (enrichment?.kind === 'vessel' && (enrichment as { flag?: string; flag_country?: string }).flag) ||
    (enrichment?.kind === 'vessel' && (enrichment as { flag_country?: string }).flag_country) ||
    (typeof p['flag'] === 'string' ? (p['flag'] as string) : null);
  if (flag) idParts.push(String(flag));
  if (typeof p['last_seen'] === 'string') idParts.push(`seen ${shortTime(p['last_seen'] as string)}`);
  if (idParts.length === 0) idParts.push(id);

  const dark = isDark(snap);
  const operator =
    (enrichment?.kind === 'aircraft' &&
      [
        (enrichment as { operator?: string }).operator,
        (enrichment as { type?: string }).type,
      ]
        .filter(Boolean)
        .join(' · ')) ||
    null;
  const tileColor = dark ? 'var(--alert)' : 'var(--txt-1)';

  return (
    <header className="flex items-start gap-2.5">
      <IconTile color={tileColor}>{glyphFor(snap)}</IconTile>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-txt-0 truncate" title={String(display)}>
          {display}
        </div>
        <div className="mono text-[9.5px] text-txt-2 mt-0.5 truncate" title={idParts.join(' · ')}>
          {idParts.join(' · ')}
        </div>
        {operator && <div className="mono text-[9.5px] text-txt-3 mt-0.5 truncate">{operator}</div>}
      </div>
      {dark ? (
        <Badge tone="alert">dark candidate</Badge>
      ) : snap?.kind ? (
        <Badge tone={kindBadgeTone(snap.kind)}>{snap.kind}</Badge>
      ) : null}
    </header>
  );
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(11, 19)}Z`;
}

// ── KV stats (mockup .kv) — only the real fields the snapshot surfaces ───────
function StatsCard({ snap }: { snap: PanelSnapshot }): JSX.Element | null {
  const p = snap.properties;
  const num = (k: string): number | null => {
    const v = p[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const isVessel = snap.kind === 'vessel';
  const speed = isVessel ? num('sog') : num('sog') ?? num('velocity') ?? num('speed');
  const course = isVessel ? num('cog') ?? num('heading') : num('track_deg') ?? num('heading');
  const speedUnit = isVessel ? 'kn' : 'm/s';
  const courseLabel = isVessel ? 'COG' : 'Course';
  const speedLabel = isVessel ? 'SOG' : 'Speed';

  const rows: JSX.Element[] = [];
  if (snap.kind) rows.push(<KVRow key="type" k="Type" v={snap.kind} />);
  if (speed !== null) rows.push(<KVRow key="spd" k={speedLabel} v={`${speed.toFixed(1)} ${speedUnit}`} />);
  if (course !== null) rows.push(<KVRow key="crs" k={courseLabel} v={`${course.toFixed(0)}°`} />);
  if (snap.position) {
    rows.push(<KVRow key="lat" k="Lat" v={`${snap.position.lat.toFixed(5)}°`} />);
    rows.push(<KVRow key="lon" k="Lon" v={`${snap.position.lon.toFixed(5)}°`} />);
    if (snap.kind === 'aircraft' && Number.isFinite(snap.position.alt)) {
      rows.push(<KVRow key="alt" k="Alt (m)" v={Math.round(snap.position.alt).toLocaleString()} />);
    }
  }
  if (rows.length === 0) return null;
  return <KV>{rows}</KV>;
}

// Great-circle distance in km (haversine) — for distance-to-go to destination.
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function airportLabel(a: Airport | null): string {
  if (!a) return '—';
  const code = a.iata || a.icao || '';
  const place = a.municipality || a.name || '';
  const label = [code, place].filter(Boolean).join(' · ');
  return label || a.name || '—';
}

// Live flight summary for the selected aircraft: route (departure → destination
// airport from the adsbdb callsign lookup), plus a distance-to-go + ETA computed
// from the aircraft's LIVE position and groundspeed toward the destination, and
// the current UTC time. Renders nothing for aircraft with no known route
// (private / GA / unknown callsign) so it never shows an empty shell.
function FlightCard({
  enrichment,
  snap,
}: {
  enrichment: Enrichment | null;
  snap: PanelSnapshot;
}): JSX.Element | null {
  if (!enrichment || enrichment.kind !== 'aircraft') return null;
  const e = enrichment as {
    origin?: Airport | null;
    destination?: Airport | null;
    route_airline?: string | null;
  };
  const origin = e.origin ?? null;
  const dest = e.destination ?? null;
  if (!origin && !dest) return null;

  const pos = snap.position;
  const gs =
    typeof snap.properties['velocity_ms'] === 'number'
      ? (snap.properties['velocity_ms'] as number)
      : null;

  let distKm: number | null = null;
  let goMin: number | null = null;
  if (pos && dest?.lat != null && dest?.lon != null) {
    distKm = haversineKm(pos.lat, pos.lon, dest.lat, dest.lon);
    // Only ETA when airborne at a real groundspeed (skip taxiing / 0 m/s).
    if (gs != null && gs > 30) goMin = (distKm * 1000) / gs / 60;
  }
  const nowZ = `${new Date().toISOString().slice(11, 16)}Z`;
  const etaZ =
    goMin != null ? `${new Date(Date.now() + goMin * 60_000).toISOString().slice(11, 16)}Z` : null;
  const goLabel =
    goMin != null
      ? goMin >= 60
        ? `${Math.floor(goMin / 60)}h ${Math.round(goMin % 60)}m`
        : `${Math.round(goMin)}m`
      : null;

  const rows: JSX.Element[] = [];
  rows.push(<KVRow key="from" k="Departed" v={airportLabel(origin)} />);
  rows.push(<KVRow key="to" k="Arriving" v={airportLabel(dest)} />);
  if (e.route_airline) rows.push(<KVRow key="al" k="Airline" v={e.route_airline} />);
  if (distKm != null)
    rows.push(<KVRow key="dist" k="Dist to go" v={`${Math.round(distKm).toLocaleString()} km`} />);
  if (etaZ) rows.push(<KVRow key="eta" k="ETA" v={etaZ} />);
  if (goLabel) rows.push(<KVRow key="go" k="Time to run" v={goLabel} />);
  rows.push(<KVRow key="now" k="Time now" v={nowZ} />);

  const head =
    origin?.iata || dest?.iata ? `${origin?.iata ?? '???'} → ${dest?.iata ?? '???'}` : undefined;
  return (
    <section>
      <SectionLabel title="Flight" {...(head ? { count: head } : {})} />
      <KV className="mt-1.5">{rows}</KV>
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
      <SectionLabel title="Track" count={`${points.length} fixes`} />
      <div className="mt-1.5 space-y-1.5">
        {kind === 'aircraft' && <Sparkline points={points} field="alt" label="alt" unit="m" />}
        {(kind === 'aircraft' || kind === 'vessel') && (
          <Sparkline points={points} field="sog" label={kind === 'aircraft' ? 'velocity m/s' : 'sog kn'} />
        )}
      </div>
    </section>
  );
}

// Profile widget — the airframe/hull side-view silhouette (always, when the
// family is known) plus the live reference photo (Planespotters / Wikipedia)
// when one exists. The silhouette is the "SVG image for every plane": GA,
// military and drones rarely have a photo but still get a recognition glyph.
function ProfileCard({
  enrichment,
  snap,
}: {
  enrichment: Enrichment | null;
  snap: PanelSnapshot | null;
}): JSX.Element | null {
  const kind = snap?.kind;
  let silhouette: string | null = null;
  let famLabel = '';

  if (kind === 'aircraft') {
    const e = enrichment?.kind === 'aircraft' ? (enrichment as { icao_type?: string | null; type?: string | null }) : null;
    const typeCode =
      e?.icao_type ??
      e?.type ??
      (typeof snap?.properties?.['type'] === 'string' ? (snap.properties['type'] as string) : null);
    const catCode = typeof snap?.properties?.['category'] === 'string' ? (snap.properties['category'] as string) : null;
    const fam = resolveAircraftFamily(typeCode, catCode);
    if (fam) {
      silhouette = aircraftSilhouette(fam);
      famLabel = (typeCode ?? fam).toUpperCase();
    }
  } else if (kind === 'vessel') {
    silhouette = vesselSilhouette();
    const e = enrichment?.kind === 'vessel' ? (enrichment as { vessel_type?: string | null }) : null;
    famLabel = (e?.vessel_type ?? 'vessel').toUpperCase();
  }

  const e2 =
    enrichment as {
      photo_thumb_url?: string | null;
      photo_full_url?: string | null;
      photo_photographer?: string | null;
      photo_link?: string | null;
      photo_license?: string | null;
      photo_credit?: string | null;
      description?: string | null;
    } | null;
  const photo = e2?.photo_full_url ?? e2?.photo_thumb_url ?? null;
  const desc = e2?.description ?? null;
  const credit = e2?.photo_photographer ?? e2?.photo_credit ?? null;

  if (!silhouette && !photo && !desc) return null;
  return (
    <Widget title="Profile">
      {silhouette && (
        <div className="flex items-center gap-2.5 mb-2">
          <img src={silhouette} alt="" className="h-9 w-auto opacity-90" />
          {famLabel && (
            <span className="mono text-[10px] text-txt-2 uppercase tracking-[0.5px] truncate">{famLabel}</span>
          )}
        </div>
      )}
      {photo && (
        <a href={e2?.photo_link ?? photo} target="_blank" rel="noreferrer" className="block">
          <img
            src={photo}
            alt="entity reference"
            loading="lazy"
            className="block w-full rounded-sm border border-line"
          />
        </a>
      )}
      {(credit || e2?.photo_license) && (
        <div className="mono text-[8.5px] text-txt-3 mt-1 truncate">
          {credit ? `© ${credit}` : ''}
          {e2?.photo_license ? `${credit ? ' · ' : ''}${e2.photo_license}` : ''}
        </div>
      )}
      {desc && <p className="text-[11px] text-txt-1 leading-snug mt-2 line-clamp-3">{desc}</p>}
    </Widget>
  );
}

// Pattern-of-life widget — the backend dossier (track profile, duration,
// distance, ADS-B gaps, assessment) that the live snapshot doesn't carry.
interface DossierTrack {
  fixes?: number;
  track_minutes?: number;
  distance_km?: number;
  profile?: string;
  gap_count?: number;
}
interface Dossier {
  found?: boolean;
  assessment?: string;
  gnss_degraded?: boolean;
  track?: DossierTrack;
}

function PatternOfLifeCard({
  id,
  kind,
  snap,
}: {
  id: string;
  kind: string;
  snap: PanelSnapshot | null;
}): JSX.Element | null {
  const [dossier, setDossier] = useState<Dossier | null>(null);
  useEffect(() => {
    setDossier(null);
    if (!id || (kind !== 'aircraft' && kind !== 'vessel')) return;
    const ab = new AbortController();
    const p = snap?.properties ?? {};
    const ident =
      kind === 'aircraft'
        ? typeof p['icao24'] === 'string'
          ? (p['icao24'] as string)
          : id
        : p['mmsi'] != null
          ? String(p['mmsi'])
          : id;
    const path =
      kind === 'aircraft'
        ? `/api/intel/dossier/aircraft/${encodeURIComponent(ident)}`
        : `/api/intel/dossier/vessel/${encodeURIComponent(ident)}`;
    apiFetch(path, { signal: ab.signal })
      .then((r) => (r.ok ? (r.json() as Promise<Dossier>) : null))
      .then((j) => {
        if (j && j.found !== false) setDossier(j);
      })
      .catch(() => undefined);
    return () => ab.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind]);

  if (!dossier) return null;
  const t = dossier.track ?? {};
  const rows: JSX.Element[] = [];
  if (t.profile) rows.push(<KVRow key="prof" k="Profile" v={t.profile} />);
  if (t.track_minutes != null) rows.push(<KVRow key="dur" k="Track" v={`${Math.round(t.track_minutes)} min`} />);
  if (t.distance_km != null)
    rows.push(<KVRow key="dist" k="Distance" v={`${Math.round(t.distance_km).toLocaleString()} km`} />);
  if (t.fixes != null) rows.push(<KVRow key="fix" k="Fixes" v={t.fixes} />);
  if (t.gap_count != null && t.gap_count > 0)
    rows.push(<KVRow key="gap" k="ADS-B gaps" v={t.gap_count} warn />);
  if (!dossier.assessment && rows.length === 0) return null;
  return (
    <Widget title="Pattern of life">
      {dossier.assessment && <p className="text-[11px] text-txt-1 leading-snug mb-2">{dossier.assessment}</p>}
      {rows.length > 0 && <KV>{rows}</KV>}
      {dossier.gnss_degraded && (
        <div className="mt-1.5">
          <Badge tone="warn">GNSS degraded</Badge>
        </div>
      )}
    </Widget>
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
        <SectionLabel title="Enrichment" />
        <p className="mono text-[9px] tracking-[0.7px] uppercase text-txt-3 mt-1.5">resolving…</p>
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
    // Owned by FlightCard — these are objects; the generic grid would render
    // them as "[object Object]".
    'origin',
    'destination',
    'route_airline',
  ]);
  const note = (enrichment as { note?: string }).note;
  const wikidata = (enrichment as { wikidata_url?: string }).wikidata_url;
  return (
    <section>
      <SectionLabel
        title="Enrichment"
        {...(typeof enrichment.source === 'string' && enrichment.source
          ? { count: enrichment.source }
          : {})}
      />
      <KV className="mt-1.5">
        {Object.entries(enrichment)
          .filter(([k]) => !specialKeys.has(k))
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .slice(0, 20)
          .map(([k, v]) => (
            <PropRow key={k} k={k} v={v} />
          ))}
      </KV>
      {note && <p className="mono text-[9px] tracking-[0.7px] uppercase text-txt-3 mt-1.5">{note}</p>}
      <div className="flex flex-wrap gap-2 mt-1.5">
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
      <SectionLabel title="Live properties" />
      <KV className="mt-1.5">
        {Object.entries(properties)
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .slice(0, 16)
          .map(([k, v]) => (
            <PropRow key={k} k={k} v={v} />
          ))}
      </KV>
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
  entityPos,
  onFollow,
  following = false,
}: {
  entityId: string | null;
  viewer?: Cesium.Viewer | null;
  entityPos?: { lon: number; lat: number; alt: number };
  onFollow?: () => void;
  following?: boolean;
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
        <SectionLabel title="Correlations" />
        <p className="text-[11px] text-txt-3 mt-1.5">no entity selected</p>
      </section>
    );
  }
  if (matches.length === 0) {
    return (
      <section>
        <SectionLabel title="Correlations" />
        <p className="text-[11px] text-txt-3 mt-1.5">no correlations in window</p>
      </section>
    );
  }

  // Top (newest) match drives the threat hero. Severity sets the tone; only
  // real Alert fields (message / severity / confidence / ruleId) are shown —
  // no fabricated AIS-gap / SAR-offset numbers.
  const top = matches[0]!;
  const heroTone: 'alert' | 'warn' =
    top.severity === 'critical' || top.severity === 'high' ? 'alert' : 'warn';

  return (
    <section className="space-y-2">
      <Hero tone={heroTone} title="⚠ Correlation">
        <p className="text-[11px] text-txt-1 leading-snug mb-2">{top.message}</p>
        <div className="flex items-center gap-2 mb-2">
          <span className={`mono text-[9px] tracking-[0.5px] uppercase ${sevClass(top.severity)}`}>
            {top.severity}
          </span>
          <span className="mono text-[9px] text-txt-3 tabular-nums">{top.ruleId}</span>
          <span className="mono text-[9px] text-txt-3 tabular-nums">
            conf {(top.confidence * 100).toFixed(0)}%
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {viewer && entityPos && (
            <Btn
              tone="accent"
              size="sm"
              onClick={() => flyToPosition(viewer, entityPos.lon, entityPos.lat, 200_000, 1.0)}
            >
              → Slew
            </Btn>
          )}
          {onFollow && (
            <Btn size="sm" onClick={onFollow} className={following ? 'border-accent-line text-accent' : ''}>
              {following ? '◼ Following' : '⌖ Follow'}
            </Btn>
          )}
        </div>
      </Hero>

      <div>
        <SectionLabel title="Correlations" count={matches.length} />
        <ul className="mt-1.5 space-y-1.5">
          {matches.map((a) => (
            <li key={a.id} className="border border-line rounded-sm p-2 bg-bg-2/60">
              <div className="flex items-baseline justify-between gap-2">
                <span className={`mono text-[9px] tracking-[0.5px] uppercase ${sevClass(a.severity)}`}>
                  {a.severity}
                </span>
                <span className="mono text-[9px] text-txt-3 tabular-nums">{a.ruleId}</span>
              </div>
              <p className="text-[11px] text-txt-1 leading-tight mt-1">{a.message}</p>
              <div className="flex items-center gap-2 mt-1.5">
                <Btn
                  size="sm"
                  onClick={() => {
                    if (viewer && a.geom?.type === 'Point') {
                      const [lon, lat] = a.geom.coordinates as [number, number];
                      flyToPosition(viewer, lon, lat, 200_000, 1.0);
                    }
                  }}
                >
                  → Slew
                </Btn>
                <span className="mono text-[9px] tabular-nums text-txt-3">
                  {new Date(a.t).toISOString().slice(11, 19)}Z
                </span>
                <span className="mono text-[9px] tabular-nums text-txt-3">
                  conf {(a.confidence * 100).toFixed(0)}%
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
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
  return <KVRow k={k} v={<span className="truncate inline-block max-w-full align-bottom">{format(v)}</span>} />;
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
