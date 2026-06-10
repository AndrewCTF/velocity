import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import type { LayerDescriptor } from '@osint/shared';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useFeeds } from '../state/stores.js';
import { tracks } from '../intel/tracks.js';

interface Props {
  registry: LayerRegistry;
  viewer: Cesium.Viewer | null;
}

const GROUP_LABEL: Record<string, string> = {
  maritime: 'Maritime',
  aviation: 'Aviation',
  hazards: 'Hazards',
  news: 'Events & News',
  infra: 'Infrastructure',
  cyber: 'Cyber',
  space: 'Space',
  rf: 'RF / Signals',
  env: 'Environment',
  imagery: 'Imagery',
  reference: 'Reference',
  seismic: 'Seismic',
  signals: 'Signals',
};

const GROUP_ORDER = ['maritime', 'aviation', 'hazards', 'news', 'cyber', 'infra', 'space', 'rf', 'env', 'imagery', 'reference'];

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
    if (!viewer) return;
    const perDsUnsub = new Map<Cesium.DataSource, () => void>();

    const recount = (): void => {
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

  const grouped = layers.reduce<Record<string, LayerDescriptor[]>>((acc, l) => {
    (acc[l.group] ||= []).push(l);
    return acc;
  }, {});

  const groupKeys = [
    ...GROUP_ORDER.filter((g) => grouped[g]),
    ...Object.keys(grouped).filter((g) => !GROUP_ORDER.includes(g)),
  ];

  return (
    <div className="p-3 space-y-3">
      <header className="flex items-baseline justify-between">
        <h2 className="micro">Layers</h2>
        <span className="micro text-txt-3">{layers.length} registered</span>
      </header>

      {groupKeys.map((group) => {
        const list = grouped[group] ?? [];
        const isCollapsed = collapsed[group];
        return (
          <section key={group}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
              className="flex items-center justify-between w-full text-left micro hover:text-accent"
            >
              <span>{GROUP_LABEL[group] ?? group}</span>
              <span className="text-txt-3">{isCollapsed ? '+' : '−'} {list.length}</span>
            </button>
            {!isCollapsed && (
              <ul className="mt-1 space-y-1">
                {list.map((l) => {
                  const enabled = registry.isEnabled(l.id);
                  const feed = feeds[l.id];
                  const count = counts[l.id] ?? 0;
                  return (
                    <li key={l.id} className="border-l-2 border-line pl-2 hover:border-accent-line">
                      <div className="flex items-center gap-2 text-[11px]">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) => (e.target.checked ? registry.enable(l.id) : registry.disable(l.id))}
                          className="accent-accent"
                          aria-label={`Toggle ${l.title}`}
                        />
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[feed?.status ?? 'unknown']}`} />
                        <span className="text-txt-1 flex-1 truncate" title={l.title}>{l.title}</span>
                        {enabled && (
                          <CountBadge
                            count={count}
                            at={countsAt}
                            feedStatus={feed?.status ?? 'unknown'}
                          />
                        )}
                      </div>
                      {enabled && (
                        <div className="pl-6 mt-1 flex items-center gap-2">
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
                          <span className="micro mono w-7 text-right text-txt-3">
                            {Math.round((l.opacity ?? 1) * 100)}%
                          </span>
                        </div>
                      )}
                      <div className="pl-6 mt-0.5">
                        <span className="micro" title={l.license}>
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
