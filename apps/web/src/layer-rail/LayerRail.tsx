import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import type { LayerDescriptor } from '@osint/shared';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useFeeds } from '../state/stores.js';
import { tracks } from '../intel/tracks.js';
import { SectionLabel, Toggle, MeterBar } from '../shell/instruments.js';

interface Props {
  registry: LayerRegistry;
  viewer: Cesium.Viewer | null;
}

// Gotham-style numbered folder labels. Each group maps to a display name;
// the sequence number is derived from GROUP_ORDER position at render time.
const GROUP_LABEL: Record<string, string> = {
  conflict:  'Conflict',
  aviation:  'Aviation',
  maritime:  'Maritime',
  space:     'Space',
  hazards:   'Hazards',
  env:       'Environment',
  news:      'OSINT / Events',
  cyber:     'Cyber / Intel',
  infra:     'Infrastructure',
  rf:        'RF / Signals',
  signals:   'Signals',
  imagery:   'Imagery',
  reference: 'Reference',
  seismic:   'Seismic',
};

// Ordered as Gotham numbered groups: conflict + primary mission layers first.
const GROUP_ORDER = [
  'conflict',
  'aviation',
  'maritime',
  'space',
  'hazards',
  'env',
  'news',
  'cyber',
  'infra',
  'rf',
  'signals',
  'imagery',
  'reference',
  'seismic',
];

// One-click mission presets — enable a curated layer set, disable the rest of
// the named layers so the operator gets a clean picture for the task. Unknown
// ids are ignored, so a preset stays valid as layers come and go.
const PRESETS: { label: string; on: string[] }[] = [
  {
    label: 'Conflict Watch',
    on: ['intel.incidents.live', 'cyber.ioda.outages', 'aviation.adsb.live.mil', 'news.acled.events'],
  },
  {
    label: 'Air Picture',
    on: ['aviation.adsb.global', 'aviation.adsb.live.mil', 'aviation.adsb.live.emergencies'],
  },
  {
    label: 'Maritime',
    on: ['maritime.keyless', 'maritime.sar.hormuz'],
  },
  {
    label: 'Cyber',
    on: ['cyber.ioda.outages', 'env.jamming.nacp'],
  },
];

// Status → colour class. Shared by the layer-row swatch (the only per-layer
// colour we honestly have — there is NO per-layer category colour in the
// registry, so the swatch shows feed HEALTH, not an invented category hue).
const STATUS_DOT: Record<string, string> = {
  green: 'bg-ok',
  amber: 'bg-warn',
  red: 'bg-alert',
  unknown: 'bg-txt-4',
};

export function LayerRail({ registry, viewer }: Props): JSX.Element {
  const [layers, setLayers] = useState<readonly LayerDescriptor[]>(() => registry.list());
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [countsAt, setCountsAt] = useState<number>(0);
  // The per-second "Xs ago" tick lives inside <RelativeAge/> below — it
  // owns its own setInterval so updating a single age label does NOT
  // re-render the entire rail (audit fix #4).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const feeds = useFeeds((s) => s.feeds);
  const debugLoggedRef = useRef<boolean>(false);

  useEffect(() => {
    const refresh = () => setLayers([...registry.list()]);
    return registry.subscribe(refresh);
  }, [registry]);

  // Event-driven entity counts. Subscribes to dataSourceAdded /
  // dataSourceRemoved so newly attached layers are picked up immediately,
  // and to each data source's entities.collectionChanged so add/remove
  // bursts (which happen in a single suspendEvents/resumeEvents pair
  // inside the adapters) refresh the count exactly once. A 2s safety
  // interval catches edge cases like Cesium EntityCluster mutations or
  // any source that bypasses collectionChanged. We also use this hook
  // to one-shot log the tracks ring size after 5s in dev so future
  // agents can verify PollGeoJsonAdapter.render() is wiring tracks.push.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const perDsUnsub = new Map<Cesium.DataSource, () => void>();

    const recount = (): void => {
      // A destroyed viewer (HMR / globe ErrorBoundary) throws on .dataSources.
      if (viewer.isDestroyed()) return;
      const next: Record<string, number> = {};
      for (let i = 0; i < viewer.dataSources.length; i++) {
        const ds = viewer.dataSources.get(i);
        // entities.values.length returns the underlying entity total even
        // when EntityCluster aggregates them visually — clustering is a
        // render-time grouping, not a collection mutation. So this count
        // reflects "real contacts", not "icons on screen". Verified for
        // vessels which use EntityCluster.
        next[ds.name] = ds.entities.values.length;
      }
      setCounts(next);
      setCountsAt(Date.now());
    };

    const attachDs = (ds: Cesium.DataSource): void => {
      if (perDsUnsub.has(ds)) return;
      const remove = ds.entities.collectionChanged.addEventListener(recount);
      perDsUnsub.set(ds, remove);
    };
    const detachDs = (ds: Cesium.DataSource): void => {
      const remove = perDsUnsub.get(ds);
      if (remove) {
        remove();
        perDsUnsub.delete(ds);
      }
    };

    // Wire all currently-attached data sources, then subscribe to add/remove.
    for (let i = 0; i < viewer.dataSources.length; i++) {
      attachDs(viewer.dataSources.get(i));
    }
    const removeAdded = viewer.dataSources.dataSourceAdded.addEventListener((_c, ds) => {
      attachDs(ds);
      recount();
    });
    const removeRemoved = viewer.dataSources.dataSourceRemoved.addEventListener((_c, ds) => {
      detachDs(ds);
      recount();
    });

    // Initial count + 2s safety net.
    recount();
    const safetyTimer = window.setInterval(recount, 2000);

    // The per-second "Xs ago" re-render lives inside <RelativeAge/> so it
    // does NOT re-render the entire rail every tick. See bottom of file.

    // Dev-mode one-shot verification: after 5s, log how many entities are
    // in the tracks ring buffer. If this is 0 while aircraft icons are on
    // the globe, the adapter wiring is broken. Off in production by guard.
    let devTimer: number | null = null;
    if (import.meta.env?.DEV && !debugLoggedRef.current) {
      devTimer = window.setTimeout(() => {
        debugLoggedRef.current = true;
        // eslint-disable-next-line no-console
        console.info('[LayerRail] tracks ring size after 5s:', tracks.size());
      }, 5000);
    }

    return () => {
      window.clearInterval(safetyTimer);
      if (devTimer != null) window.clearTimeout(devTimer);
      removeAdded();
      removeRemoved();
      for (const off of perDsUnsub.values()) off();
      perDsUnsub.clear();
    };
  }, [viewer]);

  // Substring filter over title/id so an operator can find a layer without
  // scanning every folder (one of the "grouping sucks" fixes).
  const q = filter.trim().toLowerCase();
  const shown = q
    ? layers.filter((l) => l.title.toLowerCase().includes(q) || l.id.toLowerCase().includes(q))
    : layers;
  const grouped = shown.reduce<Record<string, LayerDescriptor[]>>((acc, l) => {
    (acc[l.group] ||= []).push(l);
    return acc;
  }, {});

  // Layers currently live — pinned at the top so the operator sees what's on
  // without expanding folders.
  const enabledLayers = layers.filter((l) => registry.isEnabled(l.id));

  // Preset = clean picture for a task: enable the named set, turn everything
  // else off. Unknown ids are simply absent from `layers`, so the preset stays
  // valid as the registry changes.
  const applyPreset = (on: string[]): void => {
    const set = new Set(on);
    for (const l of layers) {
      if (set.has(l.id)) registry.enable(l.id);
      else if (registry.isEnabled(l.id)) registry.disable(l.id);
    }
  };

  // Ordered group keys: GROUP_ORDER first (only those present), then any
  // unrecognised groups appended at the end. This means a newly registered
  // group with no explicit position still appears rather than being lost.
  const groupKeys = [
    ...GROUP_ORDER.filter((g) => grouped[g]),
    ...Object.keys(grouped).filter((g) => !GROUP_ORDER.includes(g)),
  ];

  return (
    <div className="p-3 space-y-2.5">
      <SectionLabel title="Layers" count={`${layers.length} REG`} />

      {/* Filter — find a layer without hunting through folders. */}
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter layers…"
        aria-label="Filter layers"
        className="w-full bg-[rgba(255,255,255,0.04)] border border-line rounded-sm px-2 py-1 text-[11px] text-txt-1 placeholder:text-txt-4 focus:outline-none focus:border-accent-line"
      />

      {/* Mission presets — one click for a clean task picture. */}
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyPreset(p.on)}
            className="mono text-[10px] uppercase tracking-[0.6px] px-1.5 py-[3px] rounded-sm border border-line text-txt-3 hover:text-accent hover:border-accent-line/50"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Active — the layers currently live, pinned. */}
      {enabledLayers.length > 0 && (
        <div className="border-t border-[rgba(255,255,255,0.06)] pt-1.5">
          <span className="mono text-[10px] tracking-[0.9px] uppercase text-accent">
            Active · {enabledLayers.length}
          </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {enabledLayers.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => registry.disable(l.id)}
                title={`Disable ${l.title}`}
                className="mono text-[10px] px-1.5 py-[2px] rounded-sm border border-accent-line/40 text-txt-2 hover:text-alert hover:border-alert/50 truncate max-w-[120px]"
              >
                {l.title} ✕
              </button>
            ))}
          </div>
        </div>
      )}

      {groupKeys.map((group, groupIdx) => {
        const list = grouped[group] ?? [];
        const isCollapsed = collapsed[group];
        // Sequence number for Gotham-style "01 Aviation" folder header.
        const seq = String(groupIdx + 1).padStart(2, '0');
        // Count of enabled layers in this folder — shown in the header badge
        // so the operator knows at a glance how many are active without expanding.
        const enabledCount = list.filter((l) => registry.isEnabled(l.id)).length;
        return (
          <section key={group}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
              className="group flex items-center gap-1.5 w-full text-left border-t border-[rgba(255,255,255,0.06)] pt-1.5 hover:border-accent-line/40"
            >
              {/* Sequence number — Gotham numbered-group idiom */}
              <span className="mono text-[10px] tabular-nums text-txt-4 group-hover:text-accent shrink-0 w-[14px]">
                {seq}
              </span>
              <span className="mono text-[10px] tracking-[0.9px] uppercase text-txt-2 group-hover:text-accent">
                {GROUP_LABEL[group] ?? group}
              </span>
              <span className="flex-1 h-px bg-line" />
              {/* Active / total badge */}
              <span className="mono text-[10px] tabular-nums text-txt-4 group-hover:text-txt-3 shrink-0">
                {enabledCount > 0 ? (
                  <span>
                    <span className="text-accent">{enabledCount}</span>
                    <span>/{list.length}</span>
                  </span>
                ) : (
                  list.length
                )}
              </span>
              {/* Collapse chevron */}
              <span className="mono text-[10px] text-txt-4 group-hover:text-accent shrink-0 ml-0.5">
                {isCollapsed ? '▸' : '▾'}
              </span>
            </button>
            {!isCollapsed && (
              <ul className="mt-0.5">
                {list.map((l) => {
                  const enabled = registry.isEnabled(l.id);
                  const feed = feeds[l.id];
                  const status = feed?.status ?? 'unknown';
                  const count = counts[l.id] ?? 0;
                  const opacityPct = Math.round((l.opacity ?? 1) * 100);
                  return (
                    <li
                      key={l.id}
                      className="py-[5px] border-b border-[rgba(255,255,255,0.035)]"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-[9px] w-[9px] rounded-sm shrink-0 ${STATUS_DOT[status] ?? 'bg-txt-3'}`}
                          aria-hidden="true"
                        />
                        <span className="text-txt-1 text-[11px] flex-1 truncate" title={l.title}>
                          {l.title}
                        </span>
                        {enabled && (
                          <CountBadge count={count} at={countsAt} feedStatus={status} />
                        )}
                        {enabled && (
                          <MeterBar pct={opacityPct} className="w-[28px] shrink-0" />
                        )}
                        <Toggle
                          on={enabled}
                          onChange={(v) => (v ? registry.enable(l.id) : registry.disable(l.id))}
                          label={`Toggle ${l.title}`}
                        />
                      </div>
                      {enabled && (
                        <div className="pl-[17px] mt-1 flex items-center gap-2">
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            defaultValue={l.opacity}
                            onChange={(e) => registry.setOpacity(l.id, parseFloat(e.target.value))}
                            className="flex-1 accent-accent h-1"
                            aria-label={`Opacity for ${l.title}`}
                          />
                          <span className="mono text-[10px] tabular-nums w-7 text-right text-txt-3">
                            {opacityPct}%
                          </span>
                        </div>
                      )}
                      <div className="pl-[17px] mt-0.5">
                        <span className="mono text-[10px] tracking-[0.7px] uppercase text-txt-3">
                          {l.auth} · {l.refresh.ttlSec ? `${l.refresh.ttlSec}s` : l.refresh.mode}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// Mono badge showing the live entity count alongside how stale the count is.
// The age renders as "Ns ago" so the analyst knows whether the number is
// current (post-poll) or about to be refreshed. Falls back to just the count
// when we have no timestamp yet (first render before recount fires).
//
// Source-of-truth rule: a healthy feed that legitimately reports zero
// contacts (e.g. no active fires in the AOI) used to render "0", which
// analysts read as "broken". When status === 'green' && count === 0 we
// swap the count for a "live" pill so the absence is explicit rather than
// ambiguous. Non-zero counts always render normally regardless of status.
function CountBadge({
  count,
  at,
  feedStatus,
}: {
  count: number;
  at: number;
  feedStatus: string;
}): JSX.Element {
  if (count === 0 && feedStatus === 'green') {
    return (
      <span
        className="mono micro text-ok tabular-nums border border-line rounded-sm px-1 py-[1px]"
        title="feed live, no contacts"
      >
        live
      </span>
    );
  }
  return (
    <span
      className="mono micro text-txt-2 tabular-nums border border-line rounded-sm px-1 py-[1px]"
      title="live count"
    >
      <span className="text-txt-1">{count.toLocaleString()}</span>
      {at > 0 && (
        <>
          {' · '}
          <RelativeAge t={at} />
        </>
      )}
    </span>
  );
}

// Leaf component that owns its own 1Hz setInterval so the "Xs ago" badge
// can tick without re-rendering the entire LayerRail. Before this split,
// the parent held a setNowTick(n+1) interval that invalidated every row
// in the rail (~100 layer descriptors × group/feed state) every second.
// Audit fix #4.
function RelativeAge({ t }: { t: number }): JSX.Element {
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const ageSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const label =
    ageSec < 1 ? 'now' : ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  return <span className="text-txt-3">{label}</span>;
}
