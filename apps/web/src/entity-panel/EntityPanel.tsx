import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { useSelection, useAlerts } from '../state/stores.js';
import { aircraftStyle, vesselStyle } from '../globe/adapters/styles.js';
import { tracks } from '../intel/tracks.js';
import { fetchEnrichment, type Enrichment, type Airport } from '../transport/entity.js';
import { flyToPosition, followEntity, stopFollow } from '../globe/camera.js';
import { Sparkline } from './Sparkline.js';
import { CameraCard } from './CameraCard.js';
import { CaptureCard } from './CaptureCard.js';
import type { Alert } from '@osint/shared';
import { apiFetch } from '../transport/http.js';
import {
  SectionLabel,
  Badge,
  Caveat,
  KV,
  KVRow,
  Btn,
  Hero,
  IconTile,
  Widget,
  MicroLabel,
  StatusDot,
  type BadgeTone,
} from '../shell/instruments.js';
import { ConnectionsCard } from './ConnectionsCard.js';
import { AcarsCard } from './AcarsCard.js';
import { ImageryCard } from './ImageryCard.js';
import { PatternOfLifeCard } from './PatternOfLifeCard.js';
import { DossierNarrativeCard } from './DossierNarrativeCard.js';
import { VesselClassCard } from './VesselClassCard.js';
import { SituationPanel } from '../situations/SituationPanel.js';
import { OsintEntityPanel } from '../osint/OsintEntityPanel.js';
import { useProjection } from '../globe/ProjectionLayer.js';
import { useFov } from '../globe/FovLayer.js';
import { resolveAircraftFamily, aircraftSilhouette, vesselSilhouette } from './silhouettes.js';
import { useChip } from '../imagery/chipStore.js';
import { useInvestigation } from '../graph/investigationStore.js';
import { usePolReplay } from '../state/polReplayStore.js';

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

// 1 Hz wall-clock used ONLY by the freshness labels. Lives in a leaf (Header /
// DetailsCard call it directly) so the per-second age tick re-renders just those
// small cards — not the whole EntityPanel and its heavy children. Hoisting this
// out of the panel is what kills the prior 1 Hz full-subtree cascade.
function useNowTick(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function EntityPanel({ viewer }: Props = {}): JSX.Element {
  const id = useSelection((s) => s.selectedEntityId);
  const [snap, setSnap] = useState<PanelSnapshot | null>(null);
  const [enrichment, setEnrichment] = useState<Enrichment | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [track, setTrack] = useState(tracks.get(id ?? ''));
  // Receipt-side freshness: wall-clock ms of the last time this entity's fix
  // (position or observation time) actually CHANGED on our side — that is the
  // honest "Last refresh", distinct from the AIS/ADS-B observation time.
  const lastRefreshRef = useRef<number>(Date.now());
  const freshKeyRef = useRef<string>('');
  // Re-render gate that INCLUDES the live freshness counters (not just position),
  // so "Last seen"/age stays live for a cached contact whose lat/lon is steady.
  const snapKeyRef = useRef<string>('');

  // Snapshot the selected entity continuously so values update in place.
  useEffect(() => {
    setSnap(null);
    setTrack(tracks.get(id ?? ''));
    freshKeyRef.current = '';
    snapKeyRef.current = '';
    lastRefreshRef.current = Date.now();
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
      // Stamp "Last refresh" ONLY when the position/fix genuinely changed — a
      // re-sent same position must not reset it. (fk = obs time + rounded pos.)
      const fk = `${String(props['t'] ?? props['seen_at'] ?? '')}|${pos ? `${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}` : ''}`;
      if (fk !== freshKeyRef.current) {
        freshKeyRef.current = fk;
        lastRefreshRef.current = Date.now();
      }
      // Re-render when ANYTHING the panel shows changed — position OR the live
      // freshness counters (seen_pos_s/last_contact age every poll even when the
      // lat/lon is steady). Skip only a TRUE no-op resend (identical bag), so a
      // genuinely static contact with no backend update doesn't churn. Excluding
      // the freshness fields here is what froze "Last seen" — keep them in.
      const snapKey = `${fk}|${String(props['seen_pos_s'] ?? '')}|${String(props['last_contact'] ?? '')}`;
      if (snapKey === snapKeyRef.current) return;
      snapKeyRef.current = snapKey;
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
    // Advance the "Track (N fixes)" counter + sparkline as PollGeoJsonAdapter
    // pushes fixes — but ONLY re-render when the ring actually GREW. The ring is
    // mutated in place (stable ref), so we gate on length and hand TrackCard a
    // fresh slice on change. No more unconditional 1 Hz re-render here.
    let lastLen = -1;
    const t = window.setInterval(() => {
      const len = tracks.points(id);
      if (len !== lastLen) {
        lastLen = len;
        setTrack(tracks.get(id).slice());
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [id]);

  // Fire-and-forget enrichment fetch on selection. We also pass the live
  // callsign (when known) so the backend can map it to an airline operator
  // via the built-in ICAO airline prefix table.
  const callsignHint =
    typeof snap?.properties?.['callsign'] === 'string'
      ? (snap.properties['callsign'] as string)
      : null;
  // Sim entities are notional — there is no backend /api/entity row, so the
  // enrichment fetch would just 404. Detect via the live property bag.
  const isSim = snap?.properties?.['sim'] === true || (snap?.kind?.startsWith('sim-') ?? false);
  useEffect(() => {
    setEnrichment(null);
    if (!id || isSim) return;
    setEnrichLoading(true);
    const aborter = new AbortController();
    fetchEnrichment(id, aborter.signal, { callsign: callsignHint })
      .then((e) => setEnrichment(e))
      .catch(() => undefined)
      .finally(() => setEnrichLoading(false));
    return () => aborter.abort();
  }, [id, callsignHint, isSim]);

  // Continuous-follow toggle. Reset when the selection changes; stop following
  // on unmount so the camera doesn't stay locked to a stale entity.
  const [following, setFollowing] = useState(false);
  const fovOn = useFov((s) => s.enabled);
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

  // A Situation is an aggregate case file, not a map entity — delegate to its
  // dedicated tabbed panel (Summary/Intel/Reporting/Properties/Link/Media).
  if (id.startsWith('situation:')) {
    return <SituationPanel id={id} viewer={viewer ?? null} />;
  }

  // Positionless digital-OSINT entities (domain / ip / cert / asn / service /
  // threat / org / email) have no Cesium entity to snapshot — their own panel
  // (keyless enrichment cards + search-around), mirroring the situation branch.
  if (/^(domain|ip|cert|asn|service|threat|org|email|person|username):/.test(id)) {
    return <OsintEntityPanel id={id} />;
  }

  return (
    <div className="p-4 space-y-5">
      {isSim && (
        <Caveat level="SIMULATED" note="notional war-game entity — not a real contact" tone="warn" />
      )}
      <Header
        snap={snap}
        id={id}
        enrichment={enrichment}
        lastRefreshMs={lastRefreshRef.current}
      />

      <ProfileCard enrichment={enrichment} snap={snap} />

      {snap && <DetailsCard snap={snap} lastRefreshMs={lastRefreshRef.current} />}

      {snap && <FlightCard enrichment={enrichment} snap={snap} />}

      {snap?.kind === 'aircraft' && (
        <AcarsCard
          kind="aircraft"
          icao24={typeof snap.properties['icao24'] === 'string' ? (snap.properties['icao24'] as string) : null}
          callsign={typeof snap.properties['callsign'] === 'string' ? (snap.properties['callsign'] as string) : null}
          registration={
            enrichment?.kind === 'aircraft'
              ? ((enrichment as { registration?: string | null }).registration ?? null)
              : null
          }
        />
      )}

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
          <Btn
            tone="accent"
            size="sm"
            title="Drape a dated satellite chip around this entity (4 km AOI)"
            onClick={() =>
              useChip.getState().setFocus({
                entityId: id,
                lat: snap.position!.lat,
                lon: snap.position!.lon,
                radiusKm: 4,
              })
            }
          >
            ⊞ Load imagery here
          </Btn>
          {(snap.kind === 'aircraft' || snap.kind === 'satellite') && (
            <Btn
              size="sm"
              title="Toggle field-of-view footprint + boresight lines (satellite = real geometry, aircraft = notional camera cone)"
              onClick={() => useFov.getState().setEnabled(!useFov.getState().enabled)}
              className={fovOn ? 'border-accent-line text-accent' : ''}
            >
              ⨀ FOV
            </Btn>
          )}
          {(snap.kind === 'vessel' || snap.kind === 'aircraft') && (
            <Btn
              size="sm"
              title="Draw a +1h/+3h/+6h reachable-area projection from the last fix (decision support, not observed motion)"
              onClick={() => {
                const proj = useProjection.getState();
                if (proj.show && proj.entityId === id) {
                  proj.clear();
                  return;
                }
                const p = snap.properties;
                const num = (...keys: string[]): number => {
                  for (const k of keys) {
                    const v = p[k];
                    if (typeof v === 'number' && Number.isFinite(v)) return v;
                  }
                  return 0;
                };
                // Vessels report knots (sog); aircraft report velocity_ms (m/s) →
                // convert (1 m/s = 1.94384 kn).
                let speedKn = num('sog', 'speed_kn', 'gs', 'speed');
                const vms = num('velocity_ms');
                if (!speedKn && vms) speedKn = vms * 1.94384;
                const cogRaw = num('cog', 'track_deg', 'track', 'heading');
                proj.project({
                  entityId: id,
                  lat: snap.position!.lat,
                  lon: snap.position!.lon,
                  speedKn,
                  cog: cogRaw || null,
                });
              }}
            >
              ⤳ Project reach
            </Btn>
          )}
        </div>
      )}

      {/* Investigation graph (Track C4) — open the multi-hop link graph centred
          on this entity. Works off the id alone (the ontology is id-keyed), so
          unlike the position buttons above it renders for any selection. */}
      <div className="flex flex-wrap gap-2">
        <Btn
          size="sm"
          title="Open a multi-hop link-analysis graph centred on this entity (saved ontology)"
          onClick={() => useInvestigation.getState().searchAround(id)}
        >
          ⊹ Search around
        </Btn>
        <Btn
          size="sm"
          title="Replay this entity's recorded track on the timeline (pattern of life + dwell clusters)"
          onClick={() => usePolReplay.getState().play(id)}
        >
          ⟲ Pattern of life
        </Btn>
      </div>

      <ActionsCard id={id} snap={snap} />

      {snap?.kind === 'camera' && typeof snap.properties['cam_id'] === 'string' && (
        <CameraCard
          camId={snap.properties['cam_id']}
          hlsUrl={(snap.properties['hls_url'] as string | null) ?? null}
          lat={snap.position?.lat}
          lon={snap.position?.lon}
          camName={snap.name ?? undefined}
        />
      )}

      {snap?.kind === 'capture' && <CaptureCard snap={snap} />}

      <PatternOfLifeCard id={id} kind={snap?.kind ?? ''} viewer={viewer ?? null} />

      <DossierNarrativeCard id={id} kind={snap?.kind ?? ''} />

      {snap?.kind === 'vessel' && (
        <VesselClassCard
          lengthM={
            ((enrichment?.kind === 'vessel' ? (enrichment as { length_m?: number | null }).length_m : null) ??
              (snap?.properties?.['length_m'] as number | undefined)) ?? null
          }
          shipType={
            ((enrichment?.kind === 'vessel' ? (enrichment as { vessel_type?: string | null }).vessel_type : null) ??
              (snap?.properties?.['shipType'] as string | undefined)) ?? null
          }
          sogKn={
            (typeof snap?.properties?.['sog'] === 'number'
              ? (snap.properties['sog'] as number)
              : typeof snap?.properties?.['speed'] === 'number'
                ? (snap.properties['speed'] as number)
                : undefined) ?? null
          }
        />
      )}

      <ImageryCard id={id} kind={snap?.kind ?? ''} />

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

// ── governed write-back actions (Track C1) ───────────────────────────────────
// Three operator verbs over the selected entity, each POSTing to /api/actions/{name}
// via the shared apiFetch wrapper (Supabase Bearer / X-API-Key). The backend
// validates the params (Pydantic), mutates the ontology + side effect, and writes
// an audit row; we surface the receipt or the error inline (no global toast system
// exists, so feedback is local per-button — mirrors KeysPanel's busy/err idiom).
//
//   flag_entity     — {target_id, note, severity}        (ontology only)
//   nominate_target — {target_id, priority, note}        (→ target_board)
//   add_watch       — {target_id, label, lat, lon, …}    (→ alert_rules; needs lat/lon)
//
// add_watch's param model REQUIRES lat/lon/label, so that button only renders when
// the live snapshot has a position; the other two work off the entity id alone.
type ActionPhase = 'idle' | 'running' | 'ok' | 'error';

function ActionsCard({
  id,
  snap,
}: {
  id: string;
  snap: PanelSnapshot | null;
}): JSX.Element {
  // The display label the watch rule is filed under: entity name → kind+id → id.
  const watchLabel = (snap?.name as string | undefined) || (snap?.kind ? `${snap.kind} ${id}` : id);
  const pos = snap?.position;

  return (
    <section>
      <SectionLabel title="Actions" />
      <p className="mono text-[10px] text-txt-3 mt-1 leading-snug">
        governed write-back · audited to your account
      </p>
      <div className="flex flex-wrap gap-2 mt-1.5">
        <ActionButton
          label="⚑ Flag"
          action="flag_entity"
          params={{ target_id: id, note: '', severity: 3 }}
          doneLabel="Flagged"
        />
        <ActionButton
          label="◎ Nominate target"
          action="nominate_target"
          params={{ target_id: id, priority: 3, note: '' }}
          doneLabel="Nominated"
        />
        {pos && (
          <ActionButton
            label="⌂ Add watch"
            action="add_watch"
            params={{
              target_id: id,
              label: String(watchLabel).slice(0, 120),
              lat: pos.lat,
              lon: pos.lon,
              radius_nm: 50,
            }}
            doneLabel="Watching"
          />
        )}
      </div>
    </section>
  );
}

// One write-back verb. Owns its own busy/result state so each action reports
// independently. On 4xx/5xx we read the backend `detail` for a useful message
// (400 = Pydantic errors array; 502/503 = store unavailable text).
function ActionButton({
  label,
  action,
  params,
  doneLabel,
}: {
  label: string;
  action: 'flag_entity' | 'nominate_target' | 'add_watch';
  params: Record<string, unknown>;
  doneLabel: string;
}): JSX.Element {
  const [phase, setPhase] = useState<ActionPhase>('idle');
  const [msg, setMsg] = useState<string | null>(null);

  // Reset the per-button result whenever the target changes (a new entity → a
  // fresh action), keyed on the action's target_id.
  const targetKey = String(params['target_id'] ?? '');
  useEffect(() => {
    setPhase('idle');
    setMsg(null);
  }, [targetKey]);

  const run = async (): Promise<void> => {
    setPhase('running');
    setMsg(null);
    try {
      const r = await apiFetch(`/api/actions/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!r.ok) {
        setPhase('error');
        setMsg(await actionErrorText(r));
        return;
      }
      setPhase('ok');
    } catch {
      setPhase('error');
      setMsg('network error');
    }
  };

  return (
    <div className="flex flex-col gap-0.5">
      <Btn
        size="sm"
        disabled={phase === 'running'}
        onClick={() => void run()}
        className={
          phase === 'ok'
            ? 'border-[rgba(54,211,153,0.5)] text-ok'
            : phase === 'error'
              ? 'border-[rgba(255,90,82,0.5)] text-alert'
              : ''
        }
        {...(msg ? { title: msg } : {})}
      >
        {phase === 'running' ? '…' : phase === 'ok' ? `✓ ${doneLabel}` : label}
      </Btn>
      {phase === 'error' && msg && (
        <span className="mono text-[10px] text-alert leading-tight max-w-[140px] truncate" title={msg}>
          {msg}
        </span>
      )}
    </div>
  );
}

// Pull a human message out of a failed /api/actions response. The backend uses
// FastAPI's {detail: …}: a 400 carries a Pydantic errors array, 502/503 a string.
async function actionErrorText(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { detail?: unknown };
    const d = j.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d) && d.length > 0) {
      const first = d[0] as { msg?: string };
      if (first?.msg) return first.msg;
    }
  } catch {
    /* non-JSON body */
  }
  if (r.status === 401 || r.status === 403) return 'sign-in required';
  if (r.status === 503) return 'backend store not configured';
  return `failed (${r.status})`;
}

// ── entity kind → category glyph + threat colour ────────────────────────────
// The tile glyph + colour are resolved from the SAME aircraftStyle/vesselStyle
// classification the map icon uses, so the panel always matches what's drawn on
// the globe (no forked category logic). Each vessel/aircraft subtype gets its own
// glyph; a dark-vessel candidate flips to an alert-red diamond.
function isDark(snap: PanelSnapshot | null): boolean {
  return snap?.properties?.['darkCandidate'] === true;
}

const AIRCRAFT_GLYPH: Record<string, string> = {
  airliner: '✈',
  private: '➤',
  helicopter: '⊹',
  glider: '◇',
  military: '✦',
  emergency: '⚠',
};
const VESSEL_GLYPH: Record<string, string> = {
  cargo: '▤',
  tanker: '⬢',
  fishing: '⚓',
  passenger: '⛴',
  military: '✦',
  sailing: '⛵',
  pleasure: '⛵',
  tug: '⊕',
  sar: '✚',
  generic: '⛴',
};
const OTHER_GLYPH: Record<string, string> = {
  quake: '◉',
  camera: '▣',
  fire: '✦',
};

interface Category {
  glyph: string;
  color: string;
  label: string;
  tone: BadgeTone;
}
function categoryOf(snap: PanelSnapshot | null): Category {
  const p = snap?.properties ?? {};
  if (isDark(snap)) return { glyph: '◆', color: 'var(--alert)', label: 'dark candidate', tone: 'alert' };
  if (snap?.kind === 'aircraft') {
    const s = aircraftStyle(p);
    return {
      glyph: AIRCRAFT_GLYPH[s.kind] ?? '✈',
      color: s.color.toCssHexString(),
      label: s.kind,
      tone: s.emergency ? 'alert' : 'accent',
    };
  }
  if (snap?.kind === 'vessel') {
    const s = vesselStyle(p);
    return {
      glyph: VESSEL_GLYPH[s.kind] ?? '⛴',
      color: s.color.toCssHexString(),
      label: s.kind,
      tone: s.dark ? 'alert' : 'ok',
    };
  }
  return {
    glyph: OTHER_GLYPH[snap?.kind ?? ''] ?? '◆',
    color: 'var(--txt-1)',
    label: snap?.kind ?? 'object',
    tone: kindBadgeTone(snap?.kind),
  };
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
  lastRefreshMs,
}: {
  snap: PanelSnapshot | null;
  id: string;
  enrichment: Enrichment | null;
  lastRefreshMs: number;
}): JSX.Element {
  const now = useNowTick();
  const display =
    (enrichment?.kind === 'aircraft' && (enrichment as { registration?: string }).registration) ||
    (enrichment?.kind === 'vessel' && (enrichment as { name?: string }).name) ||
    snap?.name ||
    id;
  // ID line built from the REAL properties we already read: prefer a
  // domain identifier (MMSI / ICAO24), then flag.
  const p = snap?.properties ?? {};
  const idParts: string[] = [];
  if (typeof p['mmsi'] === 'string' || typeof p['mmsi'] === 'number') idParts.push(`MMSI ${p['mmsi']}`);
  if (typeof p['icao24'] === 'string') idParts.push((p['icao24'] as string).toUpperCase());
  const flag =
    (enrichment?.kind === 'vessel' && (enrichment as { flag?: string; flag_country?: string }).flag) ||
    (enrichment?.kind === 'vessel' && (enrichment as { flag_country?: string }).flag_country) ||
    (typeof p['flag'] === 'string' ? (p['flag'] as string) : null);
  if (flag) idParts.push(String(flag));
  if (idParts.length === 0) idParts.push(id);

  const cat = categoryOf(snap);
  const moving = snap?.kind === 'vessel' || snap?.kind === 'aircraft';
  const seenMs = lastSeenMs(p);
  const seenAge = seenMs != null ? now - seenMs : null;
  const refreshAge = Math.max(0, now - lastRefreshMs);
  const operator =
    (enrichment?.kind === 'aircraft' &&
      [
        (enrichment as { operator?: string }).operator,
        (enrichment as { type?: string }).type,
      ]
        .filter(Boolean)
        .join(' · ')) ||
    null;

  return (
    <header className="flex items-start gap-3">
      <IconTile color={cat.color}>{cat.glyph}</IconTile>
      <div className="min-w-0 flex-1">
        <div className="mono text-[10px] tracking-[0.03em] text-txt-2 truncate" title={idParts.join(' · ')}>
          {idParts.join(' · ')}
        </div>
        <h2
          className="text-[18px] font-semibold text-txt-0 leading-tight tracking-[-0.01em] truncate mt-1"
          title={String(display)}
        >
          {display}
        </h2>
        <div className="flex flex-wrap items-center gap-2 mt-2.5">
          {snap?.kind && <Badge tone={kindBadgeTone(snap.kind)}>{snap.kind}</Badge>}
          {cat.label && cat.label !== snap?.kind && <Badge tone={cat.tone}>{cat.label}</Badge>}
          {operator && <span className="mono text-[10.5px] text-txt-2 truncate">{operator}</span>}
        </div>
        {moving && (
          <div className="flex items-center gap-2 mt-2 mono text-[10px] text-txt-2 tabular-nums">
            <StatusDot tone={freshnessTone(refreshAge)} />
            <span>updated {relAge(refreshAge)}</span>
            {seenAge != null && Math.abs(seenAge - refreshAge) > 4000 && (
              <span>· fix {relAge(seenAge)}</span>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

// ── grouped detail card (Gotham COV idiom) ──────────────────────────────────
// Identity / Kinematics / Freshness, each its own labelled KV group. Only REAL
// snapshot fields are shown — the keyless AIS/ADS-B feeds don't broadcast
// length/draught/destination, so those are never fabricated here.
function DetailsCard({
  snap,
  lastRefreshMs,
}: {
  snap: PanelSnapshot;
  lastRefreshMs: number;
}): JSX.Element | null {
  const now = useNowTick();
  const p = snap.properties;
  const num = (k: string): number | null => {
    const v = p[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const str = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === 'string' && v.trim() !== '') return v;
      if (typeof v === 'number') return String(v);
    }
    return null;
  };
  const isVessel = snap.kind === 'vessel';
  const isAircraft = snap.kind === 'aircraft';

  // ── Identity ──
  const idRows: JSX.Element[] = [];
  if (isVessel) {
    const code = parseShipType(p);
    const typeLabel = shipTypeLabel(code);
    if (typeLabel) idRows.push(<KVRow key="vt" k="Ship type" v={code != null ? `${typeLabel} · ${code}` : typeLabel} />);
    const mmsi = str('mmsi');
    if (mmsi) idRows.push(<KVRow key="mmsi" k="MMSI" v={mmsi} />);
    const imo = str('imo');
    if (imo) idRows.push(<KVRow key="imo" k="IMO" v={imo} />);
    const cs = str('callSign', 'callsign');
    if (cs) idRows.push(<KVRow key="cs" k="Call sign" v={cs} />);
  } else if (isAircraft) {
    const icao = str('icao24');
    if (icao) idRows.push(<KVRow key="ic" k="ICAO24" v={icao.toUpperCase()} />);
    const cs = str('callsign');
    if (cs) idRows.push(<KVRow key="cs" k="Callsign" v={cs} />);
    const sq = str('squawk');
    if (sq) idRows.push(<KVRow key="sq" k="Squawk" v={sq} warn={['7500', '7600', '7700'].includes(sq)} />);
    const cat = str('category');
    if (cat) idRows.push(<KVRow key="cat" k="ADS-B cat" v={cat} />);
  }
  const src = str('source');
  if (src) idRows.push(<KVRow key="src" k="Source" v={src} />);

  // ── Kinematics ──
  const kRows: JSX.Element[] = [];
  if (isVessel) {
    const sog = num('sog');
    if (sog != null) kRows.push(<KVRow key="sog" k="SOG" v={`${sog.toFixed(1)} kn`} />);
    const cog = num('cog');
    if (cog != null) kRows.push(<KVRow key="cog" k="COG" v={`${cog.toFixed(0)}°`} />);
    const hdg = num('heading');
    if (hdg != null && hdg !== cog) kRows.push(<KVRow key="hdg" k="Heading" v={`${hdg.toFixed(0)}°`} />);
    if (p['parked'] === true) kRows.push(<KVRow key="nav" k="Status" v="moored / anchored" />);
    else if (sog != null && sog >= 0.5) kRows.push(<KVRow key="nav" k="Status" v="underway" />);
  } else if (isAircraft) {
    const ms = num('velocity_ms') ?? num('velocity') ?? num('gs');
    if (ms != null) kRows.push(<KVRow key="spd" k="Speed" v={`${ms.toFixed(0)} m/s · ${(ms * 1.94384).toFixed(0)} kn`} />);
    const trk = num('track_deg') ?? num('heading');
    if (trk != null) kRows.push(<KVRow key="trk" k="Track" v={`${trk.toFixed(0)}°`} />);
    const vs = num('baro_rate') ?? num('geom_rate') ?? num('vert_rate');
    if (vs != null && vs !== 0) kRows.push(<KVRow key="vs" k="V/S" v={`${vs > 0 ? '↑' : '↓'} ${Math.abs(vs).toFixed(0)} ft/min`} />);
  }
  if (snap.position) {
    kRows.push(<KVRow key="lat" k="Lat" v={`${snap.position.lat.toFixed(5)}°`} />);
    kRows.push(<KVRow key="lon" k="Lon" v={`${snap.position.lon.toFixed(5)}°`} />);
    if (isAircraft && Number.isFinite(snap.position.alt)) {
      const m = snap.position.alt;
      kRows.push(<KVRow key="alt" k="Alt" v={`${Math.round(m).toLocaleString()} m · ${Math.round(m * 3.28084).toLocaleString()} ft`} />);
    }
  }

  // ── Freshness ── (last AIS/ADS-B fix vs our last receipt)
  const fRows: JSX.Element[] = [];
  if (isVessel || isAircraft) {
    const seenMs = lastSeenMs(p);
    const refreshAge = Math.max(0, now - lastRefreshMs);
    fRows.push(<KVRow key="rf" k="Last refresh" v={relAge(refreshAge)} warn={refreshAge >= 120_000} />);
    if (seenMs != null) {
      const seenAge = now - seenMs;
      fRows.push(<KVRow key="ls" k="Last seen" v={`${relAge(seenAge)} ago`} warn={seenAge >= 120_000} />);
    }
  }

  if (idRows.length + kRows.length + fRows.length === 0) {
    if (!snap.kind) return null;
    return (
      <Widget title="Details">
        <KV>
          <KVRow k="Type" v={snap.kind} />
        </KV>
      </Widget>
    );
  }
  return (
    <Widget title="Details">
      <div className="space-y-2.5">
        <Group icon="⬡" title="Identity" rows={idRows} />
        <Group icon="➤" title="Kinematics" rows={kRows} />
        <Group icon="◷" title="Freshness" rows={fRows} />
      </div>
    </Widget>
  );
}

// Labelled KV sub-group inside a Widget — the Gotham "stacked facts" grouping.
function Group({ icon, title, rows }: { icon: string; title: string; rows: JSX.Element[] }): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div>
      <MicroLabel className="flex items-center gap-1.5">
        <span aria-hidden className="text-txt-2">{icon}</span>
        {title}
      </MicroLabel>
      <KV className="mt-1">{rows}</KV>
    </div>
  );
}

// ── freshness helpers ───────────────────────────────────────────────────────
// AIS vessels carry the fix time in `t` (epoch seconds); ADS-B aircraft carry
// `seen_at` with a `seen_pos_s` position-age offset. Normalise both to epoch ms.
function lastSeenMs(p: Record<string, unknown>): number | null {
  const norm = (v: number): number => (v > 1e12 ? v : v * 1000); // sec → ms
  const t = p['t'];
  if (typeof t === 'number' && Number.isFinite(t)) return norm(t);
  const seenAt = p['seen_at'];
  if (typeof seenAt === 'number' && Number.isFinite(seenAt)) {
    const seenPos = p['seen_pos_s'];
    return norm(seenAt - (typeof seenPos === 'number' ? seenPos : 0));
  }
  const ls = p['last_seen'];
  if (typeof ls === 'string') {
    const d = Date.parse(ls);
    return Number.isNaN(d) ? null : d;
  }
  return null;
}

function relAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

// Status-dot tone by receipt age: <15s live, <2m amber, else stale red.
function freshnessTone(ageMs: number): string {
  if (ageMs < 15_000) return 'green';
  if (ageMs < 120_000) return 'amber';
  return 'red';
}

// ITU-R M.1371 ship-type code (0-99) → human label. Same buckets as the map's
// classifyShipType, expanded for the panel.
function parseShipType(p: Record<string, unknown>): number | null {
  const raw = p['shipType'] ?? p['ship_type'] ?? p['shiptype'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function shipTypeLabel(code: number | null): string | null {
  if (code == null || code <= 0) return null;
  if (code === 30) return 'Fishing';
  if (code === 31 || code === 32) return 'Towing';
  if (code === 33) return 'Dredging';
  if (code === 34) return 'Diving ops';
  if (code === 35) return 'Military ops';
  if (code === 36) return 'Sailing';
  if (code === 37) return 'Pleasure craft';
  if (code >= 40 && code <= 49) return 'High-speed craft';
  if (code === 50) return 'Pilot vessel';
  if (code === 51) return 'SAR';
  if (code === 52) return 'Tug';
  if (code === 53) return 'Port tender';
  if (code === 55) return 'Law enforcement';
  if (code >= 60 && code <= 69) return 'Passenger';
  if (code >= 70 && code <= 79) return 'Cargo';
  if (code >= 80 && code <= 89) return 'Tanker';
  if (code >= 90 && code <= 99) return 'Other';
  return `Type ${code}`;
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
            // Broken photo URL → hide the whole link so no broken-image box shows.
            onError={(e) => {
              const a = (e.currentTarget as HTMLImageElement).closest('a');
              if (a) (a as HTMLElement).style.display = 'none';
            }}
          />
        </a>
      )}
      {(credit || e2?.photo_license) && (
        <div className="mono text-[10px] text-txt-3 mt-1 truncate">
          {credit ? `© ${credit}` : ''}
          {e2?.photo_license ? `${credit ? ' · ' : ''}${e2.photo_license}` : ''}
        </div>
      )}
      {desc && <p className="text-[11px] text-txt-1 leading-snug mt-2 line-clamp-3">{desc}</p>}
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
        <p className="mono text-[10px] tracking-[0.7px] uppercase text-txt-3 mt-1.5">resolving…</p>
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
      {note && <p className="mono text-[10px] tracking-[0.7px] uppercase text-txt-3 mt-1.5">{note}</p>}
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
          <span className={`mono text-[10px] tracking-[0.5px] uppercase ${sevClass(top.severity)}`}>
            {top.severity}
          </span>
          <span className="mono text-[10px] text-txt-3 tabular-nums">{top.ruleId}</span>
          <span className="mono text-[10px] text-txt-3 tabular-nums">
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
                <span className={`mono text-[10px] tracking-[0.5px] uppercase ${sevClass(a.severity)}`}>
                  {a.severity}
                </span>
                <span className="mono text-[10px] text-txt-3 tabular-nums">{a.ruleId}</span>
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
                <span className="mono text-[10px] tabular-nums text-txt-3">
                  {new Date(a.t).toISOString().slice(11, 19)}Z
                </span>
                <span className="mono text-[10px] tabular-nums text-txt-3">
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
