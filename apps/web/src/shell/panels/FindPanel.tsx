import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { Icon, type IconName } from '../../normal/Icon.js';
import { searchObjects, type ObjectResult } from '../../transport/search.js';
import { parseLatLon } from '../../globe/CoordEntry.js';
import { viewerCenter } from '../../globe/center.js';
import { haversineKm } from '../../globe/draw.js';
import { flyToPosition } from '../../globe/camera.js';
import { useSelection } from '../../state/stores.js';
import { useSavedSearches } from '../../state/savedSearches.js';
import { toast } from '../toast.js';
import { OrgCard } from '../../entity-panel/OrgCard.js';

// Find, built from docs/mockups/console-2026-08 (`14-map-find.html`) and fed by
// the same `searchObjects` call the old Search Objects sidebar made.
//
// The measured reason it needed rebuilding: the old panel rendered its results
// as a flat table of rows carrying `kind` and an age string, with **zero**
// marks and no thumbnail. It also front-loaded the operator with four region
// slots, a type select, a date mode, two date fields and a rolling-window
// picker before a single result could appear.
//
// The question this panel answers is "what is near here". So the anchor is the
// thing you set, everything is ranked by distance from it, and every row shows
// that distance twice: as a number and as a bar against the search radius, so
// the near ones are visible without reading a single figure.

const RADII = [10, 50, 200, 1000] as const;

/** Object type and time window, the two facets the old Search Objects sidebar
 *  carried that this panel first shipped without. Both were hard-coded here
 *  ("all types, last 15 minutes"), which quietly hid every contact older than
 *  the window and gave no way to ask a type question at all. `searchObjects`
 *  has taken both since it was written; only the controls were missing. */
const TYPES = [
  { id: 'all', label: 'All' },
  { id: 'aircraft', label: 'Air' },
  { id: 'vessel', label: 'Sea' },
  { id: 'quake', label: 'Quake' },
  { id: 'fire', label: 'Fire' },
  { id: 'place', label: 'Place' },
] as const;
const WINDOWS = [
  { s: 900, label: '15 m' },
  { s: 3600, label: '1 h' },
  { s: 21_600, label: '6 h' },
  { s: 86_400, label: '24 h' },
] as const;

/** Result kind to icon. The old list printed the kind as a lowercase word in a
 *  column; an icon reads at a glance and matches the map symbol for the same
 *  contact. */
const KIND_ICON: Record<string, IconName> = {
  aircraft: 'plane',
  vessel: 'ship',
  airport: 'plane',
  port: 'anchor',
  chokepoint: 'route',
  facility: 'building',
  quake: 'quake',
  fire: 'fire',
  satellite: 'satellite',
  place: 'pin',
};

/** Contacts move, places do not. Two sections because they answer different
 *  questions: one is traffic, the other is geography. */
const MOVING = new Set(['aircraft', 'vessel', 'satellite']);

interface Hit extends ObjectResult {
  km: number;
}

export function FindPanel({ viewer }: { viewer?: Cesium.Viewer | null }): JSX.Element {
  const [q, setQ] = useState('');
  const [anchor, setAnchor] = useState<{ lat: number; lon: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(50);
  const [type, setType] = useState<string>('all');
  const [sinceS, setSinceS] = useState<number>(900);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const select = useSelection((s) => s.select);

  useEffect(() => () => abort.current?.abort(), []);

  // The anchor defaults to what the camera is looking at, so the panel has an
  // answer the moment it opens rather than an empty box demanding input.
  const here = useCallback(
    (): { lat: number; lon: number } | null => anchor ?? viewerCenter(viewer ?? null),
    [anchor, viewer],
  );

  const run = useCallback(
    (
      center: { lat: number; lon: number } | null,
      km: number,
      text: string,
      facets: { type: string; sinceS: number },
    ): void => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setBusy(true);
      setErr(null);

      // One degree of latitude is ~111 km; longitude shrinks by cos(lat). The
      // envelope is deliberately generous because the haversine pass below is
      // what actually defines the circle.
      const bbox = center
        ? ((): [number, number, number, number] => {
            const dLat = km / 111;
            const dLon = km / (111 * Math.max(0.05, Math.cos((center.lat * Math.PI) / 180)));
            return [center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat];
          })()
        : undefined;

      searchObjects(
        { q: text, limit: 300, sinceS: facets.sinceS, type: facets.type, ...(bbox ? { bbox } : {}) },
        ac.signal,
      )
        .then((d) => {
          const scored = d.results
            .map((r) => ({
              ...r,
              km: center ? haversineKm({ lat: r.lat, lon: r.lon }, center) : 0,
            }))
            .filter((r) => !center || r.km <= km)
            .sort((a, b) => a.km - b.km);
          setHits(scored);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          setErr('Search failed. The objects service did not answer.');
        })
        .finally(() => setBusy(false));
    },
    [],
  );

  const facets = { type, sinceS };
  const submit = (): void => {
    const coord = parseLatLon(q);
    if (coord) {
      setAnchor(coord);
      if (viewer) flyToPosition(viewer, coord.lon, coord.lat, 200_000, 0.8);
      run(coord, radiusKm, '', facets);
    } else {
      run(here(), radiusKm, q, facets);
    }
  };

  const { contacts, places } = useMemo(() => {
    const list = hits ?? [];
    return {
      contacts: list.filter((h) => MOVING.has(h.kind)),
      places: list.filter((h) => !MOVING.has(h.kind)),
    };
  }, [hits]);

  const center = here();

  return (
    <div className="pb-2">
      <div className="px-[14px] pt-[8px]">
        <div className="flex h-[30px] items-center gap-[6px] rounded-sm border border-line-2 bg-bg-0 px-[8px] focus-within:border-accent-line">
          <Icon name="search" className="h-3 w-3 shrink-0 text-txt-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="Name, callsign, MMSI or 54.31, 18.71"
            aria-label="Find objects"
            className="mono min-w-0 flex-1 bg-transparent text-[12px] text-txt-0 outline-none placeholder:text-txt-3"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ('')}
              aria-label="Clear the search box"
              className="shrink-0 text-txt-3 hover:text-txt-0"
            >
              <Icon name="x" className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className="mt-[8px] flex flex-wrap gap-[6px]">
          <button
            type="button"
            onClick={submit}
            className="flex h-[24px] items-center gap-[5px] rounded-sm border border-accent-line bg-accent-dim px-[8px] text-[12px] text-accent-fg hover:bg-[var(--hover)]"
          >
            <Icon name="around" className="h-3 w-3" />
            Search {radiusKm} km
          </button>
          <button
            type="button"
            disabled={!center || !viewer}
            onClick={() => {
              if (center && viewer) flyToPosition(viewer, center.lon, center.lat, 200_000, 0.8);
            }}
            className="flex h-[24px] items-center gap-[5px] rounded-sm border border-line-2 px-[8px] text-[12px] text-txt-1 hover:bg-[var(--hover)] disabled:opacity-40"
          >
            <Icon name="pin" className="h-3 w-3" />
            Fly here
          </button>
          {/* The old sidebar could name a search; Explorer can save one as an
              Inbox subscription. Find is the console's primary search surface
              and could do neither, so a standing question had to be re-typed in
              another app to become a subscription. */}
          <button
            type="button"
            onClick={() => {
              const label =
                [q.trim() || 'all objects', type === 'all' ? null : type, `${radiusKm} km`]
                  .filter(Boolean)
                  .join(' · ');
              useSavedSearches.getState().add(label, {
                q: parseLatLon(q) ? '' : q,
                type,
                sinceS,
                limit: 300,
              });
              toast.ok('Search saved. New matches land in the Inbox.');
            }}
            title="Save this search as an Inbox subscription. You are notified when new objects match."
            className="flex h-[24px] items-center gap-[5px] rounded-sm border border-line-2 px-[8px] text-[12px] text-txt-1 hover:bg-[var(--hover)]"
          >
            <Icon name="bookmark" className="h-3 w-3" />
            Save search
          </button>
          {anchor && (
            <button
              type="button"
              onClick={() => {
                setAnchor(null);
                setHits(null);
              }}
              className="flex h-[24px] items-center gap-[5px] rounded-sm px-[8px] text-[12px] text-txt-3 hover:bg-[var(--hover)] hover:text-txt-0"
            >
              <Icon name="x" className="h-3 w-3" />
              Use the map centre
            </button>
          )}
        </div>

        {/* The radius is the scale every bar below is drawn against, so it is a
            control rather than a buried setting. */}
        <div className="mt-[8px] flex items-center gap-[4px]" role="group" aria-label="Search radius">
          {RADII.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                setRadiusKm(r);
                run(here(), r, parseLatLon(q) ? '' : q, facets);
              }}
              aria-pressed={radiusKm === r}
              className={`mono h-[20px] rounded-sm px-[7px] text-[12px] ${
                radiusKm === r
                  ? 'bg-accent-dim text-accent-fg shadow-[inset_0_0_0_1px_var(--accent-line)]'
                  : 'text-txt-2 hover:bg-[var(--hover)]'
              }`}
            >
              {r} km
            </button>
          ))}
        </div>

        {/* Object type. `all` first, so the panel still answers the broad
            question by default and narrowing is one click. */}
        <div className="mt-[6px] flex flex-wrap items-center gap-[4px]" role="group" aria-label="Object type">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setType(t.id);
                run(here(), radiusKm, parseLatLon(q) ? '' : q, { type: t.id, sinceS });
              }}
              aria-pressed={type === t.id}
              className={`mono h-[20px] rounded-sm px-[7px] text-[12px] ${
                type === t.id
                  ? 'bg-accent-dim text-accent-fg shadow-[inset_0_0_0_1px_var(--accent-line)]'
                  : 'text-txt-2 hover:bg-[var(--hover)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* How far back a fix still counts. */}
        <div className="mt-[4px] flex flex-wrap items-center gap-[4px]" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button
              key={w.s}
              type="button"
              onClick={() => {
                setSinceS(w.s);
                run(here(), radiusKm, parseLatLon(q) ? '' : q, { type, sinceS: w.s });
              }}
              aria-pressed={sinceS === w.s}
              className={`mono h-[20px] rounded-sm px-[7px] text-[12px] ${
                sinceS === w.s
                  ? 'bg-accent-dim text-accent-fg shadow-[inset_0_0_0_1px_var(--accent-line)]'
                  : 'text-txt-2 hover:bg-[var(--hover)]'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        <p className="mt-[8px] text-[12px] leading-relaxed text-txt-3">
          {center
            ? `Centred on ${center.lat.toFixed(4)} ${center.lat >= 0 ? 'N' : 'S'} · ${center.lon.toFixed(4)} ${center.lon >= 0 ? 'E' : 'W'}${anchor ? ' · pinned' : ' · map centre'}`
            : 'Point the camera at an area, or type a coordinate, to set the search centre.'}
        </p>
      </div>

      {err && (
        <p className="mx-[14px] mt-[8px] rounded-sm border border-alert-line bg-alert-bg px-[8px] py-[6px] text-[12px] text-alert-fg">
          {err}
        </p>
      )}

      {/* Find searches contacts near a point. An organisation is not near a
          point, and the question "who is this company, and is it designated"
          has no other address in the console. OFAC carries an owner on almost
          no vessel row, so hanging the resolver off a selected contact would
          have made it unreachable in practice: it is reachable from the search
          box instead, which is where somebody types a company name anyway. */}
      {q.trim().length >= 3 && !parseLatLon(q) && (
        <div className="mt-[8px] border-t border-line pt-[8px]">
          <OrgCard name={q.trim()} />
        </div>
      )}

      {hits === null && !busy && !err && (
        <div className="flex flex-col items-center gap-2 p-8 text-center">
          <Icon name="search" className="h-6 w-6 text-txt-3" />
          <div className="text-[13px] text-txt-1">Nothing searched yet</div>
          <p className="max-w-[220px] text-[12px] leading-relaxed text-txt-3">
            Search the radius around the map centre, or type a name, callsign, MMSI or coordinate.
          </p>
        </div>
      )}

      {busy && hits === null && (
        <p className="px-[14px] py-[8px] text-[12px] text-txt-3">searching…</p>
      )}

      {hits !== null && hits.length === 0 && !busy && (
        <div className="flex flex-col items-center gap-2 p-8 text-center">
          <Icon name="search" className="h-6 w-6 text-txt-3" />
          <div className="text-[13px] text-txt-1">No objects within {radiusKm} km</div>
          <p className="max-w-[220px] text-[12px] leading-relaxed text-txt-3">
            Widen the radius or the time window, drop the type filter, or move the centre to an area
            with traffic.
          </p>
        </div>
      )}

      <Section label="Contacts" rows={contacts} viewer={viewer} select={select} />
      <Section label="Places" rows={places} viewer={viewer} select={select} />
    </div>
  );
}

function Section({
  label,
  rows,
  viewer,
  select,
}: {
  label: string;
  rows: Hit[];
  viewer?: Cesium.Viewer | null | undefined;
  select: (id: string | null) => void;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  // Scaled to the farthest hit SHOWN, not to the search radius. Against the
  // radius, a berth full of vessels 1.6 to 1.8 km out inside a 50 km circle
  // drew sixty identical 2px slivers: a mark that cannot vary is decoration.
  // Against the spread, the same rows separate and the bar earns its column.
  const shown = rows.slice(0, 60);
  const far = Math.max(...shown.map((h) => h.km), 0.001);
  return (
    <section aria-label={label}>
      <div className="mt-3 flex h-[26px] items-center gap-[6px] border-t border-line px-[14px] pt-[6px]">
        <span className="text-[12px] font-semibold uppercase tracking-[0.6px] text-txt-2">
          {label}
        </span>
        <span className="flex-1" />
        <span className="mono text-[12px] tabular-nums text-txt-3">{rows.length}</span>
      </div>
      {shown.map((h) => (
        <button
          key={`${h.kind}:${h.id}`}
          type="button"
          onClick={() => {
            select(h.id);
            if (viewer) flyToPosition(viewer, h.lon, h.lat, 120_000, 0.8);
          }}
          className="flex w-full min-h-[38px] items-center gap-2 px-[14px] py-1 text-left hover:bg-[var(--hover)]"
        >
          {/* The thumbnail the old row never carried. */}
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm bg-bg-0 text-txt-2">
            <Icon name={KIND_ICON[h.kind] ?? 'circle'} className="h-3 w-3" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] text-txt-1">{h.label || h.id}</span>
            <span className="block truncate text-[12px] text-txt-3">
              {h.kind} · {h.source}
            </span>
          </span>
          <span className="mono w-[52px] shrink-0 text-right text-[12px] tabular-nums text-txt-2">
            {h.km < 10 ? h.km.toFixed(1) : Math.round(h.km)} km
          </span>
          {/* Distance as a mark: short bar is close. Scaled to the radius, so
              the bar means the same thing on every row in the list. */}
          <span
            className="relative h-[10px] w-[66px] shrink-0 overflow-hidden rounded-[1px] bg-bg-0"
            aria-hidden="true"
          >
            <i
              className="absolute inset-y-0 left-0 block bg-accent"
              style={{ width: `${Math.max(3, Math.min(100, (h.km / far) * 100))}%` }}
            />
          </span>
        </button>
      ))}
      {rows.length > 60 && (
        <p className="px-[14px] py-[4px] text-[12px] text-txt-3">
          Showing the 60 nearest of {rows.length}.
        </p>
      )}
    </section>
  );
}
