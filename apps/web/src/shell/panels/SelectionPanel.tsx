import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { Icon, type IconName } from '../../normal/Icon.js';
import { useSelection } from '../../state/stores.js';
import { findEntity, readProperties, readPosition } from '../../entity-panel/read.js';
import {
  ActionsCard,
  CorrelationCard,
  EnrichmentCard,
  FlightCard,
  ProfileCard,
  PropertiesCard,
  TrackCard,
  lastSeenMs,
  parseShipType,
  shipTypeLabel,
  type PanelSnapshot,
} from '../../entity-panel/EntityPanel.js';
import { AcarsCard } from '../../entity-panel/AcarsCard.js';
import { AiAssessmentCard } from '../../entity-panel/AiAssessmentCard.js';
import { AirportCard } from '../../entity-panel/AirportCard.js';
import { AisGapCard } from '../../entity-panel/AisGapCard.js';
import { SanctionsCard } from '../../entity-panel/SanctionsCard.js';
import { OrgCard } from '../../entity-panel/OrgCard.js';
import { ArchiveSeriesCard } from '../../entity-panel/ArchiveSeriesCard.js';
import { BaseCard } from '../../entity-panel/BaseCard.js';
import { CameraCard } from '../../entity-panel/CameraCard.js';
import { CaptureCard } from '../../entity-panel/CaptureCard.js';
import { ConnectionsCard } from '../../entity-panel/ConnectionsCard.js';
import { DossierNarrativeCard } from '../../entity-panel/DossierNarrativeCard.js';
import { ImageryCard } from '../../entity-panel/ImageryCard.js';
import { PatternOfLifeCard } from '../../entity-panel/PatternOfLifeCard.js';
import { PortCard } from '../../entity-panel/PortCard.js';
import { VesselClassCard } from '../../entity-panel/VesselClassCard.js';
import { SituationPanel } from '../../situations/SituationPanel.js';
import { OsintEntityPanel } from '../../osint/OsintEntityPanel.js';
import { Caveat } from '../instruments.js';
import {
  fetchEnrichment,
  type AirportEnrichment,
  type Enrichment,
  type PortEnrichment,
} from '../../transport/entity.js';
import { flyToPosition, followEntity, stopFollow } from '../../globe/camera.js';
import { tracks } from '../../intel/tracks.js';
import { useChip } from '../../imagery/chipStore.js';
import { useFov } from '../../globe/FovLayer.js';
import { useProjection } from '../../globe/ProjectionLayer.js';
import { useInvestigation } from '../../graph/investigationStore.js';
import { usePolReplay } from '../../state/polReplayStore.js';
import { useSettings } from '../../state/settings.js';
import type { LayerRegistry } from '../../registry/LayerRegistry.js';
import { TIER_META, tierOf, type Tier } from '../../registry/provenance.js';
import { WorldPanel } from './WorldPanel.js';

// Selection, built from docs/mockups/console-2026-08 (`11-map-selected.html`)
// and reading the same live Cesium entity the old inspector read.
//
// The measured reason it needed rebuilding: the old panel rendered nineteen
// rows and **six** marks, most of them plain label/value text, with no section
// grammar the rest of the console uses. The mockup groups the dossier into
// named sections (Identity, Kinematics, Freshness, Flight) and puts a mark on
// the values where magnitude matters, so altitude and speed are read at a
// glance rather than parsed.
//
// The section grammar above the fold is this file's own. Everything BELOW the
// fold is the old panel's card stack, imported rather than reimplemented: the
// first version of this rebuild shipped only the grammar, which meant the
// operator lost the assessment, the actions, the dossier, the connections
// graph, the imagery, the pattern of life, the raw property bag and every
// place-specific card. A prettier panel that shows less is a regression.
//
// The lone em dash is the never-guess rule: a property the feed did not send
// shows `—`, never a zero and never a blank.

/** Map a contact's reported `source` strings back to a provenance tier.
 *
 *  Contacts carry the SOURCE that saw them (`digitraffic`, `adsb`, `kystdatahuset`),
 *  not the layer id, so the tier cannot be looked up directly. Matching the
 *  source against the registry endpoints is the join; where a contact names
 *  several sources the weakest tier wins, and an unrecognised source yields no
 *  tier rather than an assumed one. */
export function tierOfSources(
  registry: LayerRegistry,
  props: Record<string, unknown>,
): Tier | undefined {
  const raw = props['sources'] ?? props['source'];
  const names = (Array.isArray(raw) ? raw : [raw])
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map((x) => x.toLowerCase());
  if (names.length === 0) return undefined;
  const rank: Record<Tier, number> = { sensor: 0, registry: 1, filing: 2, claim: 3 };
  let worst: Tier | undefined;
  for (const layer of registry.list()) {
    const t = tierOf(layer.id);
    if (!t) continue;
    const hay = `${layer.id} ${layer.endpoint}`.toLowerCase();
    if (!names.some((n) => hay.includes(n))) continue;
    if (worst === undefined || rank[t] > rank[worst]) worst = t;
  }
  return worst;
}

interface Snap {
  id: string;
  name?: string;
  kind?: string;
  position?: { lon: number; lat: number; alt: number };
  properties: Record<string, unknown>;
}

const AIRCRAFT_ICON: Record<string, IconName> = {
  airliner: 'plane',
  private: 'jet',
  helicopter: 'heli',
  glider: 'plane',
  military: 'shield',
  emergency: 'warning',
};
// Non-aircraft kinds get the same registry icon the map draws them with, so the
// panel head and the symbol under the cursor agree.
const KIND_ICON: Record<string, IconName> = {
  vessel: 'ship',
  quake: 'quake',
  camera: 'image',
  capture: 'image',
  fire: 'fire',
  airport: 'plane',
  port: 'anchor',
  base: 'shield',
  satellite: 'satellite',
};

/** Keys the generic (non-aircraft, non-vessel) identity block already renders
 *  elsewhere in the panel, so it does not print them twice. */
const GENERIC_SKIP = new Set([
  'kind', 'name', 'source', 'sources', 'confidence', 'seen_at', 'seen_pos_s',
  'sim', 'hls_url', 't',
]);

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}
/** Epoch seconds or ms, or an ISO string, rendered as a UTC stamp. The feed
 *  sends `seen_at` as a float epoch; printing it raw put `1785632231.59` on
 *  screen where a time belongs. */
export function timeOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  const ms = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(String(v));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const p2 = (x: number): string => String(x).padStart(2, '0');
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} Z`;
}

/** Heading as three zero-padded digits. 360 is 000, and a bare "5" is "005";
 *  every aviation and maritime readout writes it that way. */
export function fmtHeading(v: number | null): string | null {
  if (v === null) return null;
  return `${String(Math.round(v) % 360).padStart(3, '0')}°`;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function Row({
  k,
  v,
  frac,
  tone,
  title,
}: {
  k: string;
  v: string | null;
  frac?: number | undefined;
  tone?: string | undefined;
  title?: string | undefined;
}): JSX.Element {
  return (
    <div
      className="flex min-h-[20px] items-baseline gap-2 px-[14px] py-[1px] text-[12px]"
      {...(title ? { title } : {})}
    >
      <span className="min-w-0 flex-1 truncate text-txt-3">{k}</span>
      <span className={`mono shrink-0 tabular-nums ${v ? 'text-txt-1' : 'text-txt-3'}`}>
        {v ?? '—'}
      </span>
      {frac !== undefined && (
        <span
          className="relative h-[10px] w-[54px] shrink-0 overflow-hidden rounded-[1px] bg-bg-0"
          aria-hidden="true"
        >
          <i
            className={`absolute inset-y-0 left-0 block ${tone ?? 'bg-accent'}`}
            style={{ width: `${Math.max(2, Math.min(100, frac * 100))}%` }}
          />
        </span>
      )}
    </div>
  );
}

function Sect({ label }: { label: string }): JSX.Element {
  return (
    <div className="mt-3 flex h-[26px] items-center border-t border-line px-[14px] pt-[6px] first:mt-0 first:border-t-0 first:pt-0">
      <span className="text-[12px] font-semibold uppercase tracking-[0.6px] text-txt-2">
        {label}
      </span>
    </div>
  );
}

/** A verb over the selection. Same 12px chrome as the rest of the console, so
 *  the action strip reads as part of the panel rather than as a toolbar. */
function Act({
  label,
  icon,
  on = false,
  title,
  onClick,
}: {
  label: string;
  icon: IconName;
  on?: boolean;
  title?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      {...(title ? { title } : {})}
      className={`flex h-[22px] items-center gap-[5px] rounded-sm border px-[7px] text-[12px] hover:bg-[var(--hover)] ${
        on ? 'border-accent-line text-accent-fg' : 'border-line-2 text-txt-1'
      }`}
    >
      <Icon name={icon} className="h-3 w-3" />
      {label}
    </button>
  );
}

/** Seconds as the largest unit that still reads exactly. "7057 s" is a number
 *  an operator has to divide; "1 h 58 m" is one they can act on. */
export function fmtAge(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  return `${h} h ${Math.round((s - h * 3600) / 60)} min`;
}

/** Log-scaled freshness, full at 0 s and empty at 2 h. A linear 120 s ramp put
 *  everything older than two minutes at zero, so a fix two minutes stale and
 *  one two hours stale drew the same empty bar. */
export function freshFrac(s: number): number {
  if (s <= 1) return 1;
  const span = Math.log10(7200);
  return Math.max(0, Math.min(1, 1 - Math.log10(s) / span));
}

export function SelectionPanel({
  registry,
  viewer,
}: {
  registry: LayerRegistry;
  viewer?: Cesium.Viewer | null;
}): JSX.Element {
  const id = useSelection((s) => s.selectedEntityId);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [enrichment, setEnrichment] = useState<Enrichment | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [track, setTrack] = useState(tracks.get(id ?? ''));
  const [following, setFollowing] = useState(false);
  const aiPosition = useSettings((s) => s.selectionAiPosition);
  const fovOn = useFov((s) => s.enabled);
  const projecting = useProjection((s) => s.show && s.entityId === id);
  // Receipt-side freshness: when OUR side last saw the fix change, which is a
  // different question from the feed's own observation time.
  const lastRefreshRef = useRef<number>(Date.now());
  const freshKeyRef = useRef<string>('');

  useEffect(() => {
    setSnap(null);
    setTrack(tracks.get(id ?? ''));
    setFollowing(false);
    freshKeyRef.current = '';
    lastRefreshRef.current = Date.now();
    if (!viewer || !id) return;
    const tick = (): void => {
      if (viewer.isDestroyed()) return;
      const e = findEntity(viewer, id);
      if (!e) return;
      const props = readProperties(e);
      const pos = readPosition(e, viewer);
      const next: Snap = { id, properties: props };
      if (e.name) next.name = e.name;
      if (props['kind']) next.kind = String(props['kind']);
      if (pos) next.position = pos;
      const fk = `${String(props['t'] ?? props['seen_at'] ?? '')}|${pos ? `${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}` : ''}`;
      if (fk !== freshKeyRef.current) {
        freshKeyRef.current = fk;
        lastRefreshRef.current = Date.now();
      }
      setSnap(next);
      setTrack(tracks.get(id));
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [viewer, id]);

  // Sim entities are notional; there is no /api/entity row to resolve, so the
  // fetch would only 404.
  const isSim = snap?.properties?.['sim'] === true || (snap?.kind?.startsWith('sim-') ?? false);
  const callsignHint = typeof snap?.properties?.['callsign'] === 'string' ? snap.properties['callsign'] : null;
  const enrichRef = useRef<{ id: string | null; hadHint: boolean }>({ id: null, hadHint: false });
  useEffect(() => {
    if (!id || isSim) {
      setEnrichment(null);
      enrichRef.current = { id: null, hadHint: false };
      return;
    }
    // Fetch once per id, and refetch only the FIRST time a callsign hint shows
    // up (it arrives about a second after selection). Refetching on every hint
    // change blanks the card and doubles the request.
    const hadHint = Boolean(callsignHint);
    const prev = enrichRef.current;
    if (prev.id === id && (prev.hadHint || !hadHint)) return;
    enrichRef.current = { id, hadHint };
    const ac = new AbortController();
    let cancelled = false;
    setEnrichLoading(true);
    fetchEnrichment(id, ac.signal, callsignHint ? { callsign: callsignHint } : undefined)
      .then((e) => {
        if (!cancelled) setEnrichment(e);
      })
      .catch(() => {
        if (!cancelled) setEnrichment(null);
      })
      .finally(() => {
        if (!cancelled) setEnrichLoading(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [id, isSim, callsignHint]);

  // With no selection this column used to be an apology in an otherwise empty
  // 384px track. WorldPanel answers the question the operator opens with
  // instead, from the same live sources. docs/plan-99-2026-08.md §2 W1.
  if (!id) return <WorldPanel registry={registry} viewer={viewer ?? null} />;

  // Two selections have no Cesium entity behind them and own their whole
  // surface, exactly as the old panel routed them: a saved situation, and the
  // positionless digital-OSINT objects (domain / ip / cert / asn / …).
  if (id.startsWith('situation:')) return <SituationPanel id={id} viewer={viewer ?? null} />;
  if (/^(domain|ip|cert|asn|service|threat|org|email|person|username|url|wallet|tx|file):/.test(id)) {
    return <OsintEntityPanel id={id} />;
  }

  const p = snap?.properties ?? {};
  const kind = snap?.kind ?? '';
  // The weakest tier among the layers this contact's sources belong to. A fused
  // contact is only as believable as its softest input, which is the same rule
  // the Layers rows use.
  const contactTier = tierOfSources(registry, p);
  const isAircraft = kind === 'aircraft';
  const isVessel = kind === 'vessel';
  const cat = str(p['category']) ?? str(p['kind']) ?? '';
  const icon = (isAircraft ? AIRCRAFT_ICON[cat] : undefined) ?? KIND_ICON[kind] ?? 'hexagon';
  // The feed's real key names, read off a live entity's property bag. The first
  // version guessed `reg` and `alt_ft`; the feed sends `registration` and
  // `baro_alt_m` in METRES, so Registration rendered a dash and altitude was
  // silently absent. Guessing key names is how a panel reports "no data" for
  // data that is right there.
  const baroM = num(p['baro_alt_m']);
  const geoM = num(p['geo_alt_m']);
  const alt = baroM !== null ? baroM * 3.28084 : snap?.position ? snap.position.alt * 3.28084 : null;
  const ms = num(p['velocity_ms']);
  const spd = ms !== null ? ms * 1.943844 : (num(p['sog']) ?? num(p['speed']));
  // ADS-B sends the fix age directly as `seen_pos_s`. AIS does not: it sends an
  // observation TIME (`t` / `last_seen`), so a vessel showed "Last fix —" and
  // "Seen at —" while the same bag carried the timestamp. Derive the age from
  // whichever of the two the feed actually sent.
  const seenMs = lastSeenMs(p);
  const age = num(p['seen_pos_s']) ?? (seenMs !== null ? Math.max(0, (Date.now() - seenMs) / 1000) : null);
  const srcs = Array.isArray(p['sources']) ? (p['sources'] as string[]) : [];
  const conf = str(p['confidence']);
  const onGround = p['on_ground'] === true;
  const emerg = str(p['emergency']);
  const shipCode = parseShipType(p);
  const shipLabel = shipTypeLabel(shipCode);
  const sog = num(p['sog']);
  const cog = num(p['cog']);
  const heading = num(p['heading']);
  // The three names the feed uses for the same quantity, in the order the old
  // panel preferred them.
  const vertRate = num(p['baro_rate']) ?? num(p['geom_rate']) ?? num(p['vert_rate']);

  // Identity rows read the property bag FIRST and the resolved enrichment
  // second. Measured on a live contact: the bag carries icao24 / callsign /
  // registration but no type, while the hexdb.io enrichment carries type,
  // icao_type, operator and manufacturer. Reading only the bag printed
  // "Type —" beside an Enrichment card that said A21N four sections lower.
  const enr = (enrichment ?? {}) as Record<string, unknown>;
  const enrOf = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = str(enr[k]);
      if (v) return v;
    }
    return null;
  };
  const acType = str(p['type']) ?? str(p['icao_type']) ?? enrOf('icao_type', 'type');
  const operator = str(p['operator']) ?? enrOf('operator', 'route_airline', 'owner');
  const registration = str(p['registration']) ?? str(p['reg']) ?? enrOf('registration');
  // The kind is already on the badge to the right, so repeating it here just
  // printed "vessel / vessel". When nothing better is known the line is empty.
  const subtitle =
    [operator, acType].filter(Boolean).join(' · ') ||
    enrOf('object_type', 'vessel_type', 'place', 'harborType', 'branch') ||
    (shipLabel ?? null);

  // The card stack shares the old panel's snapshot shape, so pass it through
  // rather than keeping two parallel types.
  const cardSnap: PanelSnapshot | null = snap ? (snap as PanelSnapshot) : null;
  const aiCard = (
    <AiAssessmentCard
      id={id}
      kind={kind}
      properties={p}
      {...(snap?.position ? { altM: snap.position.alt } : {})}
    />
  );

  return (
    <div className="pb-2">
      {isSim && (
        <div className="px-[14px] pt-[8px]">
          <Caveat level="SIMULATED" note="notional war-game entity, not a real contact" tone="warn" />
        </div>
      )}
      {/* The object, with its silhouette. Every list in the reference puts a
          picture on the thing being discussed. */}
      <div className="flex items-center gap-[9px] border-b border-line px-[14px] py-[6px]">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-line-2 bg-bg-0">
          <Icon name={icon} className="h-5 w-5 text-accent-fg" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-txt-0">
            {snap?.name ?? str(p['callsign']) ?? str(p['reg']) ?? id}
          </span>
          {subtitle && <span className="block truncate text-[12px] text-txt-3">{subtitle}</span>}
        </span>
        <span className="shrink-0 rounded-sm bg-accent-dim px-[7px] py-[1px] text-[12px] text-accent-fg">
          {kind || 'contact'}
        </span>
      </div>

      {/* Camera verbs and analysis verbs. These were the eight buttons the old
          panel carried and this one dropped; without them the selection is
          something you read, not something you work. */}
      <div className="flex flex-wrap gap-[5px] border-b border-line px-[14px] py-[6px]">
        {snap?.position && viewer && (
          <>
            <Act
              label="Slew"
              icon="crosshair"
              title="Fly the camera to this contact"
              onClick={() => flyToPosition(viewer, snap.position!.lon, snap.position!.lat, 350_000, 1.0)}
            />
            <Act
              label={following ? 'Following' : 'Follow'}
              icon="target"
              on={following}
              title="Lock the camera onto this contact"
              onClick={() => {
                if (following) {
                  stopFollow(viewer);
                  setFollowing(false);
                } else {
                  setFollowing(followEntity(viewer, id));
                }
              }}
            />
            <Act
              label="Copy lat,lon"
              icon="copy"
              onClick={() =>
                void navigator.clipboard?.writeText(
                  `${snap.position!.lat.toFixed(5)},${snap.position!.lon.toFixed(5)}`,
                )
              }
            />
            <Act
              label="Imagery here"
              icon="image"
              title="Drape a dated satellite chip around this entity (4 km AOI)"
              onClick={() =>
                useChip.getState().setFocus({
                  entityId: id,
                  lat: snap.position!.lat,
                  lon: snap.position!.lon,
                  radiusKm: 4,
                })
              }
            />
            {(isAircraft || kind === 'satellite') && (
              <Act
                label="FOV"
                icon="eye"
                on={fovOn}
                title="Field-of-view footprint and boresight lines (satellite = real geometry, aircraft = notional cone)"
                onClick={() => useFov.getState().setEnabled(!useFov.getState().enabled)}
              />
            )}
            {(isAircraft || isVessel) && (
              <Act
                label="Project reach"
                icon="route"
                on={projecting}
                title="Draw the +1h/+3h/+6h reachable area from the last fix (decision support, not observed motion)"
                onClick={() => {
                  const proj = useProjection.getState();
                  if (proj.show && proj.entityId === id) {
                    proj.clear();
                    return;
                  }
                  // Vessels report knots (sog); aircraft report velocity_ms.
                  let speedKn = num(p['sog']) ?? num(p['speed_kn']) ?? num(p['gs']) ?? num(p['speed']) ?? 0;
                  const vms = num(p['velocity_ms']);
                  if (!speedKn && vms) speedKn = vms * 1.94384;
                  const cogRaw =
                    num(p['cog']) ?? num(p['track_deg']) ?? num(p['track']) ?? num(p['heading']);
                  proj.project({
                    entityId: id,
                    lat: snap.position!.lat,
                    lon: snap.position!.lon,
                    speedKn,
                    cog: cogRaw ?? null,
                  });
                }}
              />
            )}
          </>
        )}
        {/* Both of these work off the id alone (the ontology is id-keyed), so
            unlike the camera verbs they render for a positionless selection. */}
        <Act
          label="Search around"
          icon="share"
          title="Open a multi-hop link-analysis graph centred on this entity"
          onClick={() => useInvestigation.getState().searchAround(id)}
        />
        <Act
          label="Pattern of life"
          icon="rewind"
          title="Replay this entity's recorded track on the timeline"
          onClick={() => usePolReplay.getState().play(id)}
        />
      </div>

      {aiPosition === 'top' && <div className="px-[14px] pt-[8px]">{aiCard}</div>}

      {/* Identity is per kind. One shared aircraft block used to render for
          everything, so selecting a quake or a satellite produced six rows of
          ICAO24 / Callsign / Squawk dashes: a panel confidently reporting the
          absence of fields the object never had. */}
      <Sect label="Identity" />
      {isVessel && (
        <>
          <Row k="MMSI" v={str(p['mmsi'])} />
          <Row k="IMO" v={str(p['imo']) ?? enrOf('imo')} />
          <Row k="Call sign" v={str(p['callSign']) ?? str(p['callsign']) ?? enrOf('callsign')} />
          <Row k="Ship type" v={shipLabel ? (shipCode !== null ? `${shipLabel} · ${shipCode}` : shipLabel) : enrOf('vessel_type')} />
          <Row k="Flag" v={str(p['flag']) ?? str(p['country']) ?? enrOf('flag', 'flag_country')} />
          <Row k="Destination" v={str(p['destination'])} />
          <Row k="Length" v={num(p['length_m']) !== null ? `${Math.round(num(p['length_m'])!)} m` : null} />
          <Row k="Nearest port" v={enrOf('nearest_port')} />
        </>
      )}
      {isAircraft && (
        <>
          <Row k="ICAO24" v={str(p['icao24'])?.toUpperCase() ?? null} />
          <Row k="Callsign" v={str(p['callsign'])} />
          <Row k="Registration" v={registration} />
          <Row k="Type" v={acType} />
          <Row k="Operator" v={operator} />
          <Row k="Manufacturer" v={enrOf('manufacturer')} />
          <Row k="ADS-B category" v={str(p['category'])} />
          <Row k="Squawk" v={str(p['squawk'])} />
        </>
      )}
      {kind === 'quake' && (
        <>
          <Row k="Magnitude" v={num(p['mag']) !== null ? `M ${num(p['mag'])!.toFixed(1)}` : enrOf('mag')}
               frac={num(p['mag']) !== null ? num(p['mag'])! / 9 : undefined}
               tone={num(p['mag']) !== null && num(p['mag'])! >= 6 ? 'bg-alert' : 'bg-warn'} />
          <Row k="Depth" v={num(p['depth_km']) !== null ? `${num(p['depth_km'])!.toFixed(1)} km` : enrOf('depth_km')} />
          <Row k="Place" v={str(p['place']) ?? enrOf('place')} />
          <Row k="Felt reports" v={enrOf('felt')} />
          <Row k="Alert level" v={str(p['alert']) ?? enrOf('alert')} />
          <Row k="Tsunami" v={p['tsunami'] === undefined ? enrOf('tsunami') : p['tsunami'] ? 'yes' : 'no'} />
        </>
      )}
      {kind === 'satellite' && (
        <>
          <Row k="NORAD" v={str(p['norad']) ?? str(p['norad_cat_id']) ?? enrOf('norad_cat_id')} />
          <Row k="Object" v={str(p['name']) ?? enrOf('object_name')} />
          <Row k="Object type" v={enrOf('object_type')} />
          <Row k="Owner" v={enrOf('owner')} />
          <Row k="Launched" v={enrOf('launch_date')} />
          <Row k="Launch site" v={enrOf('launch_site')} />
          <Row k="Inclination" v={num(enr['inclination']) !== null ? `${num(enr['inclination'])!.toFixed(2)}°` : null} />
          <Row k="Period" v={num(enr['period']) !== null ? `${num(enr['period'])!.toFixed(1)} min` : null} />
          <Row k="Apogee" v={num(enr['apogee']) !== null ? `${Math.round(num(enr['apogee'])!)} km` : null} />
          <Row k="Perigee" v={num(enr['perigee']) !== null ? `${Math.round(num(enr['perigee'])!)} km` : null} />
        </>
      )}
      {!isVessel && !isAircraft && kind !== 'quake' && kind !== 'satellite' && (
        <>
          <Row k="Name" v={snap?.name ?? str(p['name'])} />
          <Row k="Kind" v={kind || null} />
          {/* Whatever else the feed sent for this kind, rather than a fixed list
              that fits one of them. The raw bag is still below in full. */}
          {Object.entries(p)
            .filter(([k, v]) => !GENERIC_SKIP.has(k) && v !== null && v !== undefined && v !== '')
            .slice(0, 10)
            .map(([k, v]) => (
              <Row key={k} k={k.replace(/_/g, ' ')} v={str(v)} />
            ))}
        </>
      )}
      {emerg && emerg !== 'none' && (
        <div className="mx-[14px] my-1 flex items-start gap-2 rounded-sm border border-alert-line bg-alert-bg px-2 py-1 text-[12px] text-alert-fg">
          <Icon name="warning" className="mt-[1px] h-3 w-3 shrink-0" />
          <span>Emergency squawk reported: {emerg}</span>
        </div>
      )}

      <Sect label={isVessel || isAircraft || kind === 'satellite' ? 'Kinematics' : 'Position'} />
      {isVessel && (
        <>
          {/* 25 kn is fast for a merchant hull, so the bar is scaled to that
              rather than to an airliner's 550. */}
          <Row k="SOG" v={sog !== null ? `${sog.toFixed(1)} kn` : null} frac={sog !== null ? sog / 25 : undefined} />
          <Row k="COG" v={fmtHeading(cog)} />
          <Row k="Heading" v={heading !== null && heading !== cog ? fmtHeading(heading) : null} />
          <Row
            k="Status"
            v={p['parked'] === true ? 'moored or anchored' : sog !== null && sog >= 0.5 ? 'underway' : null}
          />
          <Row k="Draught" v={num(p['draught']) !== null ? `${num(p['draught'])!.toFixed(1)} m` : null} />
        </>
      )}
      {(isAircraft || kind === 'satellite') && (
        <>
          {/* Altitude against the top of the usable band, speed against a fast
              airliner: the bar answers "is this high / fast" without arithmetic. */}
          <Row k="Altitude" v={alt !== null ? `${Math.round(alt).toLocaleString()} ft` : null}
               frac={alt !== null ? alt / 45000 : undefined} />
          <Row k="Speed" v={spd !== null ? `${Math.round(spd)} kn` : null}
               frac={spd !== null ? spd / 550 : undefined} />
          <Row k="Track" v={fmtHeading(num(p['track_deg']) ?? num(p['cog']))} />
          <Row k="Vertical rate" v={vertRate === null ? null : `${vertRate > 0 ? '↑' : '↓'} ${Math.abs(Math.round(vertRate))} ft/min`} />
          {/* A zero here is the transponder not sending a geometric altitude,
              not an aircraft at sea level, so it reads as "not reported". */}
          <Row k="Geometric alt" v={geoM ? `${Math.round(geoM * 3.28084).toLocaleString()} ft` : null} />
          <Row k="On ground" v={p['on_ground'] === undefined ? null : onGround ? 'yes' : 'no'} />
        </>
      )}
      <Row k="Latitude" v={snap?.position ? snap.position.lat.toFixed(5) : null} />
      <Row k="Longitude" v={snap?.position ? snap.position.lon.toFixed(5) : null} />

      {/* ADS-B integrity. These four decide whether the position above is worth
          acting on, and the old panel never showed them: NACp is positional
          accuracy, NIC integrity containment, SIL the level of assurance, NACv
          velocity accuracy. Each is a 0-to-max scale, so each gets a bar. */}
      {isAircraft && (
        <>
          <Sect label="Integrity" />
          {num(p['nac_p']) === null && num(p['nic']) === null && num(p['sil']) === null && (
            <p className="px-[14px] py-[2px] text-[12px] leading-relaxed text-txt-3">
              {srcs.includes('firehose')
                ? 'This contact reported no integrity fields on its last message.'
                : 'Not carried by this source. ADS-B integrity comes from raw message decode; state-vector feeds like OpenSky do not include it.'}
            </p>
          )}
          <Row k="NACp" v={num(p['nac_p']) !== null ? String(num(p['nac_p'])) : null}
               frac={num(p['nac_p']) !== null ? num(p['nac_p'])! / 11 : undefined}
               tone={num(p['nac_p']) !== null && num(p['nac_p'])! >= 8 ? 'bg-ok' : 'bg-warn'} />
          <Row k="NIC" v={num(p['nic']) !== null ? String(num(p['nic'])) : null}
               frac={num(p['nic']) !== null ? num(p['nic'])! / 11 : undefined}
               tone={num(p['nic']) !== null && num(p['nic'])! >= 7 ? 'bg-ok' : 'bg-warn'} />
          <Row k="SIL" v={num(p['sil']) !== null ? String(num(p['sil'])) : null}
               frac={num(p['sil']) !== null ? num(p['sil'])! / 3 : undefined}
               tone={num(p['sil']) !== null && num(p['sil'])! >= 2 ? 'bg-ok' : 'bg-warn'} />
          <Row k="NACv" v={num(p['nac_v']) !== null ? String(num(p['nac_v'])) : null}
               frac={num(p['nac_v']) !== null ? num(p['nac_v'])! / 4 : undefined} />
        </>
      )}

      <Sect label="Freshness" />
      {/* Age inverted: a full green bar means a fresh fix, so decay is visible
          as the bar draining rather than as a number growing. */}
      <Row
        k="Last fix"
        v={age !== null ? fmtAge(age) : null}
        frac={age !== null ? freshFrac(age) : undefined}
        tone={age === null ? undefined : age > 600 ? 'bg-alert' : age > 60 ? 'bg-warn' : 'bg-ok'}
      />
      <Row k="Seen at" v={timeOf(p['seen_at']) ?? (seenMs !== null ? timeOf(seenMs) : null)} />
      <Row k="Last refresh" v={fmtAge(Math.max(0, Date.now() - lastRefreshRef.current) / 1000)}
           title="When our side last saw this contact's fix change, as distinct from the feed's own observation time" />

      {/* Provenance. A fix corroborated by two independent feeds is a different
          claim from one seen by a single source, and the panel said neither. */}
      <Sect label="Provenance" />
      {/* Who is vouching for this contact, not just how many sources saw it.
          The tier is stated on every layer row and in the right dock; a dossier
          that omitted it would be the one place in the console where an
          observation and an assertion look the same. */}
      <Row
        k="Tier"
        v={
          contactTier
            ? `${TIER_META[contactTier].short} · ${TIER_META[contactTier].label}`
            : null
        }
        title={contactTier ? TIER_META[contactTier].blurb : undefined}
      />
      <Row k="Confidence" v={conf} />
      <Row k="Corroborating" v={srcs.length ? String(srcs.length) : str(p['source_count'])}
           frac={srcs.length ? Math.min(1, srcs.length / 3) : undefined}
           tone={srcs.length > 1 ? 'bg-ok' : 'bg-warn'} />
      {srcs.length > 0 && (
        <div className="flex flex-wrap gap-1 px-[14px] py-[4px]">
          {srcs.map((sname) => (
            <span
              key={sname}
              className="rounded-sm border border-line-2 bg-bg-2 px-[6px] py-[1px] text-[12px] text-txt-2"
            >
              {sname}
            </span>
          ))}
        </div>
      )}
      {srcs.length === 0 && <Row k="Source" v={str(p['source'])} />}

      {/* Below the fold: the dossier. Every card here already existed and was
          already tested; the rebuild's job was the grammar above, not a second
          implementation of these. */}
      <div className="ep-stack space-y-3 border-t border-line px-[14px] pt-3">
        {/* First card in the stack, deliberately. A designation is the single
            fact that changes what an analyst does with a contact, and the first
            build put it below the profile, the actions and the pattern of life
            where it was the most important thing on the panel and the last
            thing anyone would see. Screening runs for EVERY hull and airframe,
            not only the ones that arrived on the sanctions layer, because the
            question is asked of the contact under the cursor. */}
        {(isVessel || isAircraft) && (
          <SanctionsCard
            imo={num(p['imo'])}
            mmsi={num(p['mmsi'])}
            callSign={str(p['callSign'])}
            name={isAircraft ? null : (snap?.name ?? str(p['name']))}
            registration={isAircraft ? str(p['registration']) : null}
          />
        )}

        {/* "Who owns it" is the question straight after "is it designated", and
            no single free source answers it. Opt-in because it costs four
            upstream requests, and the operator asks it about one contact, not
            about every contact they click. */}
        {(isVessel || isAircraft) && (
          <OrgCard name={str(p['vessel_owner']) ?? str(p['operator']) ?? null} />
        )}

        <ProfileCard enrichment={enrichment} snap={cardSnap} />

        {cardSnap && <FlightCard enrichment={enrichment} snap={cardSnap} />}

        {isAircraft && (
          <AcarsCard
            kind="aircraft"
            icao24={typeof p['icao24'] === 'string' ? p['icao24'] : null}
            callsign={typeof p['callsign'] === 'string' ? p['callsign'] : null}
            registration={
              enrichment?.kind === 'aircraft'
                ? ((enrichment as { registration?: string | null }).registration ?? null)
                : null
            }
          />
        )}

        <ActionsCard id={id} snap={cardSnap} />

        {kind === 'camera' && typeof p['cam_id'] === 'string' && (
          <CameraCard
            camId={p['cam_id']}
            hlsUrl={(p['hls_url'] as string | null) ?? null}
            lat={snap?.position?.lat}
            lon={snap?.position?.lon}
            camName={snap?.name ?? undefined}
          />
        )}

        {kind === 'capture' && cardSnap && <CaptureCard snap={cardSnap} />}

        <PatternOfLifeCard id={id} kind={kind} viewer={viewer ?? null} />

        <DossierNarrativeCard id={id} kind={kind} />

        {isVessel && (
          <VesselClassCard
            lengthM={
              ((enrichment?.kind === 'vessel'
                ? (enrichment as { length_m?: number | null }).length_m
                : null) ?? num(p['length_m'])) ?? null
            }
            shipType={
              ((enrichment?.kind === 'vessel'
                ? (enrichment as { vessel_type?: string | null }).vessel_type
                : null) ?? (p['shipType'] as string | undefined)) ?? null
            }
            sogKn={sog}
          />
        )}

        {isVessel && <AisGapCard mmsi={str(p['mmsi'])} />}


        {enrichment?.kind === 'airport' && <AirportCard enrichment={enrichment as AirportEnrichment} />}

        {enrichment?.kind === 'port' && <PortCard enrichment={enrichment as PortEnrichment} />}

        {kind === 'base' && (
          <BaseCard
            name={snap?.name ?? str(p['name'])}
            branch={str(p['branch'])}
            lat={snap?.position?.lat ?? null}
            lon={snap?.position?.lon ?? null}
          />
        )}

        <ImageryCard id={id} kind={kind} />

        <TrackCard kind={kind} points={track} />

        <ArchiveSeriesCard id={id} kind={kind} />

        <ConnectionsCard
          entityId={id}
          enrichment={enrichment}
          viewer={viewer ?? null}
          {...(snap?.position ? { position: snap.position } : {})}
        />

        <EnrichmentCard kind={kind} enrichment={enrichment} loading={enrichLoading} />

        {Object.keys(p).length > 0 && <PropertiesCard properties={p} />}

        <CorrelationCard
          entityId={id}
          viewer={viewer ?? null}
          {...(snap?.position ? { entityPos: snap.position } : {})}
        />

        {aiPosition === 'bottom' && aiCard}
      </div>
    </div>
  );
}
