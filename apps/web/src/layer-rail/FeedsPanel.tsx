import { useMemo } from 'react';
import { useFeeds, type FeedHealth, type FeedStatus } from '../state/stores.js';

// Feeds rail tab — grouped feed-health dashboard.
// Reads useFeeds, groups entries by their upstream source (the layer-id prefix
// before the second dot, e.g. "hazards.usgs" from "hazards.usgs.quakes"), and
// shows per-source counts, the worst status in the group, and per-feed
// status/last-seen details.

const STATUS_DOT: Record<FeedStatus, string> = {
  green: 'bg-ok',
  amber: 'bg-warn',
  red: 'bg-alert',
  unknown: 'bg-txt-4',
};

const STATUS_RANK: Record<FeedStatus, number> = {
  red: 3,
  amber: 2,
  unknown: 1,
  green: 0,
};

function upstreamOf(id: string): string {
  const parts = id.split('.');
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
  return parts[0] ?? id;
}

function worstStatus(feeds: readonly FeedHealth[]): FeedStatus {
  let worst: FeedStatus = 'green';
  for (const f of feeds) {
    if (STATUS_RANK[f.status] > STATUS_RANK[worst]) worst = f.status;
  }
  return worst;
}

function formatLastSeen(epochMs: number | undefined): string {
  if (!epochMs) return '—';
  try {
    const iso = new Date(epochMs).toISOString();
    // YYYY-MM-DDTHH:MM:SSZ — drop ms
    return `${iso.slice(0, 19)}Z`;
  } catch {
    return '—';
  }
}

export function FeedsPanel(): JSX.Element {
  const feedsMap = useFeeds((s) => s.feeds);

  const { groups, total, byStatus } = useMemo(() => {
    const list = Object.values(feedsMap);
    const groups = new Map<string, FeedHealth[]>();
    const byStatus: Record<FeedStatus, number> = { green: 0, amber: 0, red: 0, unknown: 0 };
    for (const f of list) {
      byStatus[f.status]++;
      const key = upstreamOf(f.id);
      const arr = groups.get(key);
      if (arr) arr.push(f);
      else groups.set(key, [f]);
    }
    // Sort groups: worst status first, then alpha.
    const sorted = [...groups.entries()].sort(([ka, a], [kb, b]) => {
      const sa = STATUS_RANK[worstStatus(a)];
      const sb = STATUS_RANK[worstStatus(b)];
      if (sa !== sb) return sb - sa;
      return ka.localeCompare(kb);
    });
    return { groups: sorted, total: list.length, byStatus };
  }, [feedsMap]);

  return (
    <div className="p-3 space-y-3">
      <header className="flex items-baseline justify-between">
        <h2 className="micro">Feeds</h2>
        <span className="micro text-txt-3">{total} tracked</span>
      </header>

      <div className="flex flex-wrap gap-2 text-[11px]">
        <StatusBadge label="green" count={byStatus.green} status="green" />
        <StatusBadge label="amber" count={byStatus.amber} status="amber" />
        <StatusBadge label="red" count={byStatus.red} status="red" />
        <StatusBadge label="unknown" count={byStatus.unknown} status="unknown" />
      </div>

      {total === 0 ? (
        <p className="micro normal-case tracking-normal text-txt-3">
          No feed health reported yet. Adapters publish status as they connect.
        </p>
      ) : (
        <ul className="space-y-3">
          {groups.map(([source, list]) => {
            const worst = worstStatus(list);
            return (
              <li key={source}>
                <div className="flex items-center justify-between border-b border-line pb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[worst]}`} />
                    <span className="mono text-[12px] text-txt-0 truncate" title={source}>{source}</span>
                  </div>
                  <span className="micro tabular-nums">{list.length}</span>
                </div>
                <ul className="mt-1 space-y-1">
                  {list.map((f) => (
                    <li key={f.id} className="border-l border-line pl-2 py-0.5">
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[f.status]}`} />
                        <span className="text-txt-1 flex-1 truncate" title={f.label}>{f.label}</span>
                        <span className="mono micro tabular-nums text-txt-3" title={f.lastSeen ? new Date(f.lastSeen).toISOString() : 'no last-seen'}>
                          {formatLastSeen(f.lastSeen)}
                        </span>
                      </div>
                      {f.note && (
                        <div className="pl-3.5 micro normal-case tracking-normal text-txt-3 leading-snug">
                          {f.note}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ label, count, status }: { label: string; count: number; status: FeedStatus }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
      <span className="text-txt-2">{label}</span>
      <span className="tabular-nums text-txt-1">{count}</span>
    </span>
  );
}
