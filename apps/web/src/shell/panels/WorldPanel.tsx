import { useEffect, useMemo, useState } from 'react';
import type * as Cesium from 'cesium';
import type { LayerRegistry } from '../../registry/LayerRegistry.js';
import { Icon } from '../../normal/Icon.js';
import { useLayerCounts } from '../../layer-rail/useLayerCounts.js';
import { useFeeds } from '../../state/stores.js';
import { apiFetch } from '../../transport/http.js';
import { tierOf, TIER_ORDER, TIER_META, type Tier } from '../../registry/provenance.js';

// What the right column says when nothing is selected.
//
// It used to say "Nothing selected" and nothing else, in a 384px column, for
// the whole session until the operator happened to click something. That is a
// fifth of the window spent on an apology. The panel that owns the selection
// still owns it; this is what stands in the same place when there is no
// selection to describe, and it answers the question an analyst actually opens
// the console with: what am I looking at, and who is vouching for it.
//
// Every number here is read from the live Cesium data sources and the feed
// health store. Nothing is computed from a target, an estimate or a constant.

function fmt(n: number): string {
  return n.toLocaleString();
}

function ageLabel(ms: number | undefined): string {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

export function WorldPanel({
  registry,
  viewer,
}: {
  registry: LayerRegistry;
  viewer?: Cesium.Viewer | null;
}): JSX.Element {
  const counts = useLayerCounts(viewer);
  const feedsMap = useFeeds((s) => s.feeds);

  const { byTier, live, biggest, total } = useMemo(() => {
    const byTier = new Map<Tier, { contacts: number; on: number; sources: number }>();
    for (const t of TIER_ORDER) byTier.set(t, { contacts: 0, on: 0, sources: 0 });
    let total = 0;
    let biggest: { id: string; title: string; n: number } | null = null;
    const live: Array<{ id: string; title: string; n: number; tier: Tier | undefined }> = [];
    for (const l of registry.list()) {
      const t = tierOf(l.id);
      const bucket = t ? byTier.get(t) : undefined;
      if (bucket) bucket.sources += 1;
      const n = counts[l.id];
      if (n === undefined) continue; // never spawned: not a zero, an absence
      if (bucket) {
        bucket.on += 1;
        bucket.contacts += n;
      }
      total += n;
      if (n > 0) live.push({ id: l.id, title: l.title, n, tier: t });
      if (n > 0 && (!biggest || n > biggest.n)) biggest = { id: l.id, title: l.title, n };
    }
    live.sort((a, b) => b.n - a.n);
    return { byTier, live, biggest, total };
  }, [registry, counts]);

  const feeds = useMemo(() => Object.values(feedsMap), [feedsMap]);
  const green = feeds.filter((f) => f.status === 'green').length;
  const stalest = useMemo(
    () =>
      feeds
        .filter((f) => typeof f.lastSeen === 'number')
        .sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0))[0],
    [feeds],
  );

  return (
    <div className="flex flex-col gap-0 pb-3">
      <Section label="On the map">
        <div className="flex items-baseline gap-2 px-[14px] pb-[6px]">
          <span className="mono text-[22px] tabular-nums text-txt-0">{fmt(total)}</span>
          <span className="text-[12px] text-txt-3">
            contacts across {live.length} live {live.length === 1 ? 'layer' : 'layers'}
          </span>
        </div>
      </Section>

      <Section label="By provenance">
        {TIER_ORDER.map((t) => {
          const b = byTier.get(t) ?? { contacts: 0, on: 0, sources: 0 };
          const frac = total > 0 ? b.contacts / total : 0;
          const m = TIER_META[t];
          return (
            <div
              key={t}
              className="flex h-[var(--g-row-2)] items-center gap-2 px-[14px]"
              title={m.blurb}
            >
              <span
                className={`mono w-[21px] shrink-0 text-[12px] ${
                  t === 'claim' ? 'text-warn' : 'text-txt-3'
                }`}
              >
                {m.short}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-txt-1">{m.label}</span>
              <span className="mono w-[30px] shrink-0 text-right text-[12px] tabular-nums text-txt-3">
                {b.on}/{b.sources}
              </span>
              <span className="mono w-[62px] shrink-0 text-right text-[12px] tabular-nums text-txt-1">
                {b.on === 0 ? '—' : fmt(b.contacts)}
              </span>
              <span
                className="relative h-[10px] w-[44px] shrink-0 overflow-hidden rounded-[1px] bg-bg-0"
                aria-hidden="true"
              >
                <i
                  className={`absolute inset-y-0 left-0 block ${
                    t === 'claim' ? 'bg-warn' : 'bg-accent'
                  }`}
                  style={{ width: `${Math.min(100, frac * 100)}%` }}
                />
              </span>
            </div>
          );
        })}
        <p className="px-[14px] pb-[6px] pt-[4px] text-[12px] leading-relaxed text-txt-3">
          {byTier.get('claim')?.on
            ? 'A claim layer is on. Nothing it reports has been observed by an instrument.'
            : 'Everything on the map was observed or filed. No claim layer is on.'}
        </p>
      </Section>

      <Section label="Largest layers">
        {live.length === 0 ? (
          <p className="px-[14px] pb-[6px] text-[12px] text-txt-3">
            No layer has reported yet. Sources are still loading.
          </p>
        ) : (
          live.slice(0, 6).map((l) => (
            <div key={l.id} className="flex h-[var(--g-row-2)] items-center gap-2 px-[14px]">
              <span
                className={`mono w-[21px] shrink-0 text-[12px] ${
                  l.tier === 'claim' ? 'text-warn' : 'text-txt-3'
                }`}
              >
                {l.tier ? TIER_META[l.tier].short : '—'}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-txt-1">{l.title}</span>
              <span className="mono shrink-0 text-[12px] tabular-nums text-txt-0">{fmt(l.n)}</span>
            </div>
          ))
        )}
        {biggest && (
          <p className="px-[14px] pb-[6px] pt-[4px] text-[12px] leading-relaxed text-txt-3">
            {biggest.title} is the heaviest layer in view at {fmt(biggest.n)} entities.
          </p>
        )}
      </Section>

      <Findings registry={registry} />

      <Section label="Sources">
        <div className="flex h-[var(--g-row-2)] items-center gap-2 px-[14px]">
          <span className="min-w-0 flex-1 truncate text-[12px] text-txt-1">Reporting</span>
          <span className="mono shrink-0 text-[12px] tabular-nums text-txt-0">
            {feeds.length === 0 ? '—' : `${green} of ${feeds.length}`}
          </span>
        </div>
        <div className="flex h-[var(--g-row-2)] items-center gap-2 px-[14px]">
          <span className="min-w-0 flex-1 truncate text-[12px] text-txt-1">
            {stalest ? `Oldest fix · ${stalest.label}` : 'Oldest fix'}
          </span>
          <span className="mono shrink-0 text-[12px] tabular-nums text-txt-0">
            {ageLabel(stalest?.lastSeen)}
          </span>
        </div>
      </Section>

      <div className="mt-2 flex items-start gap-2 border-t border-line px-[14px] pt-[10px]">
        <Icon name="crosshair" className="mt-[2px] h-3 w-3 shrink-0 text-txt-3" />
        <p className="text-[12px] leading-relaxed text-txt-3">
          Click a contact to replace this with its identity, kinematics and how fresh its last fix
          is.
        </p>
      </div>
    </div>
  );
}

/** A layer whose value is a COUNT the operator should see without having found
 *  the toggle first. Both of these are off by default and both answer a question
 *  worth asking at first paint. */
const FINDING_LAYERS: ReadonlyArray<{
  id: string;
  label: string;
  endpoint: string;
  zero: string;
}> = [
  {
    id: 'intel.sanctions.vessels',
    label: 'Designated hulls under way',
    endpoint: '/api/sanctions/vessels',
    zero: 'None of the vessels reporting right now is on OFAC, UK or UN by IMO or MMSI.',
  },
  {
    id: 'cyber.routing.national',
    label: 'Countries below normal routing',
    endpoint: '/api/cyber/routing?min_drop=5',
    zero: 'Every watched country is announcing its usual prefixes.',
  },
];

/** Counts from the analytic layers, fetched whether or not the layer is on.
 *
 *  This is the "built-but-unreachable capability keeps not converting" finding
 *  from the persona studies, applied to the two newest capabilities. A sanctions
 *  join that only reports once the operator has found and enabled a layer they
 *  did not know existed converts nobody. The count comes to them; enabling the
 *  layer is one click from the number. */
function Findings({ registry }: { registry: LayerRegistry }): JSX.Element {
  const [counts, setCounts] = useState<Record<string, number | 'error' | null>>({});

  useEffect(() => {
    const ab = new AbortController();
    for (const f of FINDING_LAYERS) {
      apiFetch(f.endpoint, { signal: ab.signal })
        .then(async (r) => {
          if (ab.signal.aborted) return;
          if (!r.ok) {
            setCounts((c) => ({ ...c, [f.id]: 'error' }));
            return;
          }
          const j = (await r.json()) as { features?: unknown[] };
          setCounts((c) => ({ ...c, [f.id]: Array.isArray(j.features) ? j.features.length : 0 }));
        })
        .catch(() => {
          if (!ab.signal.aborted) setCounts((c) => ({ ...c, [f.id]: 'error' }));
        });
    }
    return () => ab.abort();
  }, []);

  return (
    <Section label="Findings">
      {FINDING_LAYERS.map((f) => {
        const n = counts[f.id];
        const on = registry.isEnabled(f.id);
        return (
          <div key={f.id} className="px-[14px]">
            <div className="flex h-[var(--g-row-2)] items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-txt-1">{f.label}</span>
              <span
                className={`mono shrink-0 text-[12px] tabular-nums ${
                  typeof n === 'number' && n > 0 ? 'text-alert-fg' : 'text-txt-1'
                }`}
              >
                {n === undefined ? '…' : n === 'error' ? '—' : n === null ? '—' : n}
              </span>
              <button
                type="button"
                onClick={() => (on ? registry.disable(f.id) : registry.enable(f.id))}
                aria-pressed={on}
                className={`mono h-[20px] shrink-0 rounded-sm px-[6px] text-[12px] ${
                  on
                    ? 'bg-accent-dim text-accent-fg shadow-[inset_0_0_0_1px_var(--accent-line)]'
                    : 'text-txt-3 hover:bg-[var(--hover)]'
                }`}
              >
                {on ? 'shown' : 'show'}
              </button>
            </div>
            {n === 0 && (
              <p className="pb-[6px] text-[12px] leading-relaxed text-txt-3">{f.zero}</p>
            )}
            {n === 'error' && (
              <p className="pb-[6px] text-[12px] leading-relaxed text-txt-3">
                Source unavailable, so this is not a zero.
              </p>
            )}
          </div>
        );
      })}
    </Section>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <section aria-label={label}>
      <div className="mt-3 flex h-[26px] items-center border-t border-line px-[14px] pt-[6px] first:mt-0 first:border-t-0 first:pt-0">
        <span className="truncate text-[12px] font-semibold uppercase tracking-[0.6px] text-txt-2">
          {label}
        </span>
      </div>
      {children}
    </section>
  );
}
