// Imagery card (Track B3) — "what satellite imagery overlaps WHERE and WHEN this
// entity was?". Calls GET /api/entity/{id}/imagery (the imagery_index geotemporal
// crawl: the entity's recent history.db track ∩ the on-demand catalog) and lists
// the overlapping passes, each with an honest provider · gsd · date label and a
// "Drape" action that reuses the existing chip pipeline (useChip.setFocus →
// ChipLayer's SingleTileImageryProvider drape).
//
// Distinct from the panel's "⊞ Load imagery here" button: that one drapes a chip
// over the entity's LIVE position blindly; this card first asks the backend which
// archived passes actually cover the track, then drapes the chosen scene's bbox.
//
// Honesty (CLAUDE.md guardrail — never imply live / VHR-when-coarse):
//   - The backend is read-only over history.db (~24-48 h retention). For an entity
//     last seen OLDER than the window it returns an empty match list WITH a note
//     ("no track in the ~Nh window"), which we surface verbatim — we never render
//     "no imagery exists".
//   - Maxar Open Data is an event-gated ARCHIVE (~0.5 m where an activation covers
//     the AOI); Sentinel-2 is 10 m and only listed as availability (CDSE creds).
//     We label each match's provider + gsd + date and stamp "archived pass · not
//     live" — never "real-time" / "VHR" unless the backend reports it.
//   - Degrades gracefully: available=false → the backend's reason; empty matches →
//     the backend's note; fetch failure → a quiet inline error (no crash).
//
// Reuses: apiFetch (Supabase Bearer / X-API-Key), useChip (the chip focus store),
// and the shared instrument primitives (Widget / KV / Caveat / Btn / Badge).

import { useEffect, useState } from 'react';

import { apiFetch } from '../transport/http.js';
import { useChip } from '../imagery/chipStore.js';
import {
  Widget,
  KV,
  KVRow,
  Btn,
  Caveat,
  Badge,
  MicroLabel,
} from '../shell/instruments.js';

// One imagery match from /api/entity/{id}/imagery (imagery_index._scenes_from_manifest).
// bbox is the scene footprint [west, south, east, north] in degrees (or null for the
// availability-only Sentinel entry, which carries the track AOI as {min_lon,...}).
interface ImageryMatch {
  provider: string; // 'maxar' | 'sentinel'
  id?: string | null;
  datetime?: string | null;
  epoch?: number | null;
  bbox?: number[] | { min_lon: number; min_lat: number; max_lon: number; max_lat: number } | null;
  gsd_m?: number | null;
  note?: string | null;
  collection?: string | null;
  layers?: string[];
  overlap_t?: number | null;
}

interface ImageryResponse {
  id: string;
  kind?: string | null;
  retention_hours?: number;
  window?: { t_from: number; t_to: number };
  track?: {
    points: number;
    bbox: { min_lon: number; min_lat: number; max_lon: number; max_lat: number };
    t_first: number;
    t_last: number;
  } | null;
  matches?: ImageryMatch[];
  best_source?: string;
  note?: string | null;
  available?: boolean;
  catalog?: { maxar_timed_out?: boolean; maxar_index_truncated?: boolean; before?: string; after?: string };
}

// ── bbox helpers ────────────────────────────────────────────────────────────
// A match bbox arrives either as a [w,s,e,n] array (Maxar scene footprint) or as
// the {min_lon,...} AOI object (the Sentinel availability entry). Normalise both
// into a centre + a radius (km) so the chip drape (which takes lat/lon/radiusKm)
// frames the scene. The chip endpoint clamps radius to [0.1, 100] km itself.
interface CenterRadius {
  lat: number;
  lon: number;
  radiusKm: number;
}

function normalizeBbox(
  bbox: ImageryMatch['bbox'],
): { west: number; south: number; east: number; north: number } | null {
  if (!bbox) return null;
  if (Array.isArray(bbox)) {
    if (bbox.length < 4) return null;
    const [w, s, e, n] = bbox as [number, number, number, number];
    if (![w, s, e, n].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    return { west: w, south: s, east: e, north: n };
  }
  const { min_lon, min_lat, max_lon, max_lat } = bbox;
  if (![min_lon, min_lat, max_lon, max_lat].every((v) => typeof v === 'number' && Number.isFinite(v)))
    return null;
  return { west: min_lon, south: min_lat, east: max_lon, north: max_lat };
}

// Centre + half-diagonal radius (km) of a scene footprint. The half-diagonal is a
// touch generous (it covers the corners), which is what we want so the draped chip
// frames the whole footprint rather than clipping it.
function bboxToCenterRadius(bbox: ImageryMatch['bbox']): CenterRadius | null {
  const b = normalizeBbox(bbox);
  if (!b) return null;
  const lat = (b.south + b.north) / 2;
  const lon = (b.west + b.east) / 2;
  // Approximate km half-extents (lat: 111 km/°, lon shrinks by cos(lat)).
  const halfLatKm = (Math.abs(b.north - b.south) / 2) * 111.32;
  const lonKmPerDeg = 111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const halfLonKm = (Math.abs(b.east - b.west) / 2) * lonKmPerDeg;
  const radiusKm = Math.max(0.5, Math.min(100, Math.hypot(halfLatKm, halfLonKm)));
  return { lat, lon, radiusKm };
}

function providerLabel(p: string): string {
  if (p === 'maxar') return 'MAXAR';
  if (p === 'sentinel') return 'SENTINEL-2';
  if (p === 'gibs') return 'GIBS VIIRS';
  return p.toUpperCase();
}

function gsdLabel(gsd: number | null | undefined): string {
  if (gsd == null) return '— m';
  return gsd >= 1 ? `${Math.round(gsd)} m` : `${gsd.toFixed(1)} m`;
}

// Acquisition stamp: real datetime → its date; the availability-only Sentinel
// entry has no datetime → label it as on-demand-available, not a dated pass.
function dateLabel(m: ImageryMatch): string {
  if (m.datetime) return m.datetime.slice(0, 10);
  return 'on-demand';
}

function fmtClock(epoch: number | null | undefined): string | null {
  if (epoch == null || !Number.isFinite(epoch)) return null;
  return `${new Date(epoch * 1000).toISOString().slice(11, 16)}Z`;
}

export function ImageryCard({ id, kind }: { id: string; kind: string }): JSX.Element | null {
  const [data, setData] = useState<ImageryResponse | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'error'>('idle');

  // Only aircraft/vessels carry a geolocatable track; for anything else the
  // backend would just answer available=false, so we skip the fetch entirely
  // and render nothing (keeps the panel tight for cameras / quakes / sim agents).
  const trackable = kind === 'aircraft' || kind === 'vessel';

  useEffect(() => {
    setData(null);
    setPhase('idle');
    if (!id || !trackable) return;
    const ab = new AbortController();
    setPhase('loading');
    apiFetch(`/api/entity/${encodeURIComponent(id)}/imagery`, { signal: ab.signal })
      .then((r) => (r.ok ? (r.json() as Promise<ImageryResponse>) : null))
      .then((j) => {
        if (!j) {
          setPhase('error');
          return;
        }
        setData(j);
        setPhase('idle');
      })
      .catch((e: unknown) => {
        if ((e as { name?: string }).name === 'AbortError') return;
        setPhase('error');
      });
    return () => ab.abort();
  }, [id, trackable]);

  if (!trackable) return null;

  // Loading shell — keep the section present so it doesn't pop in/out.
  if (phase === 'loading' && !data) {
    return (
      <Widget title="Imagery">
        <MicroLabel className="block">crawling track ∩ catalog…</MicroLabel>
      </Widget>
    );
  }

  if (phase === 'error' && !data) {
    return (
      <Widget title="Imagery">
        <MicroLabel className="block text-warn">imagery index unavailable</MicroLabel>
      </Widget>
    );
  }

  if (!data) return null;

  const matches = data.matches ?? [];
  const note = data.note ?? null;
  const retention = data.retention_hours;

  // available=false → the backend told us WHY it can't look (history disabled,
  // not a trackable id, store unreachable). Surface that reason honestly.
  if (data.available === false) {
    return (
      <Widget title="Imagery">
        <MicroLabel className="block text-txt-3">{note ?? 'imagery index unavailable for this entity'}</MicroLabel>
      </Widget>
    );
  }

  // Track found (or not) but no overlapping imagery — render the honest note so
  // the operator sees "no track in the ~Nh window" vs "track found, no coverage"
  // (the backend distinguishes them; we never imply "no imagery exists").
  if (matches.length === 0) {
    return (
      <Widget title="Imagery">
        <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
          {retention != null && <Caveat level={`HISTORY ~${retention}H`} />}
          {data.track?.points != null && <Caveat level={`${data.track.points} FIX TRACK`} />}
        </div>
        <MicroLabel className="block text-txt-3">{note ?? 'no overlapping imagery for this track'}</MicroLabel>
      </Widget>
    );
  }

  const maxarTimedOut = data.catalog?.maxar_timed_out === true;

  return (
    <Widget title="Imagery" count={`${matches.length}`}>
      {/* Scope caveats — what window this is over + which catalog answered. */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {retention != null && <Caveat level={`HISTORY ~${retention}H`} />}
        {data.track?.points != null && <Caveat level={`${data.track.points} FIX TRACK`} />}
        {data.best_source && data.best_source !== 'none' && (
          <Caveat level={`BEST ${providerLabel(data.best_source)}`} tone={data.best_source === 'maxar' ? 'neutral' : 'warn'} />
        )}
      </div>

      <ul className="space-y-1.5">
        {matches.map((m, i) => (
          <ImageryRow key={m.id ?? `${m.provider}-${i}`} entityId={id} match={m} />
        ))}
      </ul>

      {/* Honest, persistent footnote: archive vs live; partial-crawl warning. */}
      <MicroLabel className="block mt-2 text-txt-3">
        archived passes · not live · dates as labeled
      </MicroLabel>
      {maxarTimedOut && (
        <MicroLabel className="block text-warn">Maxar crawl timed out — list may be partial</MicroLabel>
      )}
      {note && <p className="mono text-[10px] text-txt-3 leading-snug mt-1">{note}</p>}
    </Widget>
  );
}

// One imagery match: provider/gsd/date label, footprint clock, and a Drape button
// that frames the chip on the scene footprint via the shared useChip focus.
function ImageryRow({ entityId, match }: { entityId: string; match: ImageryMatch }): JSX.Element {
  const cr = bboxToCenterRadius(match.bbox);
  const overlapClock = fmtClock(match.overlap_t);
  // The availability-only Sentinel entry (no datetime, no real footprint epoch)
  // still drapes — it just frames the track AOI and the chip endpoint fetches a
  // current Sentinel truecolor for that box (labeled by the chip's own Caveat).
  const isAvailabilityOnly = !match.datetime && match.provider === 'sentinel';

  const drape = (): void => {
    if (!cr) return;
    useChip.getState().setFocus({
      entityId,
      lat: cr.lat,
      lon: cr.lon,
      radiusKm: cr.radiusKm,
    });
  };

  return (
    <li className="border border-line rounded-sm p-2 bg-bg-2/60">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <Caveat
            level={providerLabel(match.provider)}
            note={gsdLabel(match.gsd_m)}
            tone={match.provider === 'maxar' ? 'neutral' : 'warn'}
          />
          <span className="mono text-[10px] text-txt-2 tabular-nums">{dateLabel(match)}</span>
          {isAvailabilityOnly && <Badge tone="neutral">available</Badge>}
        </div>
        <Btn
          tone="accent"
          size="sm"
          disabled={!cr}
          title={
            cr
              ? 'Drape this scene’s footprint as a chip on the globe'
              : 'scene footprint unknown — cannot frame a chip'
          }
          onClick={drape}
        >
          ⊞ Drape
        </Btn>
      </div>
      {(overlapClock || match.collection) && (
        <KV className="mt-1.5">
          {overlapClock && <KVRow k="Entity here" v={overlapClock} />}
          {match.collection && <KVRow k="Collection" v={match.collection} />}
        </KV>
      )}
    </li>
  );
}
