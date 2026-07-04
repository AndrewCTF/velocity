import { useMemo } from 'react';
import { useFeeds, type FeedHealth, type FeedStatus } from '../state/stores.js';
import { SectionLabel, StatusDot, Badge, type BadgeTone } from '../shell/instruments.js';

// Feeds rail tab — grouped feed-health dashboard.
// Reads useFeeds, groups entries by their upstream source (the layer-id prefix
// before the second dot, e.g. "hazards.usgs" from "hazards.usgs.quakes"), and
// shows per-source counts, the worst status in the group, and per-feed
// status/last-seen details.

const STATUS_RANK: Record<FeedStatus, number> = {
  red: 3,
  amber: 2,
  unknown: 1,
  green: 0,
};

// Map a feed status to the StatusDot tone + summary-badge tone vocabulary.
const STATUS_TONE: Record<FeedStatus, BadgeTone> = {
  green: 'ok',
  amber: 'warn',
  red: 'alert',
  unknown: 'neutral',
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
    <div className="px-3 py-2">
      <SectionLabel title="Feeds" count={`${total} tracked`} />

      {/* Status tally — one badge per state, mono counts */}
      <div className="flex flex-wrap gap-1.5 mt-2.5">
        <StatusTally label="green" count={byStatus.green} status="green" />
        <StatusTally label="amber" count={byStatus.amber} status="amber" />
        <StatusTally label="red" count={byStatus.red} status="red" />
        <StatusTally label="unknown" count={byStatus.unknown} status="unknown" />
      </div>

      {total === 0 ? (
        <p className="mono text-[10.5px] text-txt-3 leading-snug mt-3">
          No feed health reported yet. Adapters publish status as they connect.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {groups.map(([source, list]) => {
            const worst = worstStatus(list);
            return (
              <section key={source}>
                <div className="flex items-center gap-2 pb-1 border-b border-line">
                  <StatusDot tone={worst} />
                  <span className="mono text-[11.5px] text-txt-0 truncate flex-1" title={source}>
                    {source}
                  </span>
                  <span className="mono text-[10px] text-txt-3 tabular-nums">{list.length}</span>
                </div>
                <ul className="mt-0.5">
                  {list.map((f) => (
                    <li
                      key={f.id}
                      className="border-b border-[rgba(255,255,255,0.035)] last:border-b-0 py-[5px]"
                    >
                      <div className="flex items-center gap-2">
                        <StatusDot tone={f.status} />
                        <span className="text-[11px] text-txt-1 flex-1 truncate" title={f.label}>
                          {f.label}
                        </span>
                        <span
                          className="mono text-[10px] tabular-nums text-txt-3 shrink-0"
                          title={f.lastSeen ? new Date(f.lastSeen).toISOString() : 'no last-seen'}
                        >
                          {formatLastSeen(f.lastSeen)}
                        </span>
                      </div>
                      {f.note && (
                        <div className="mono text-[10px] text-txt-3 leading-snug pl-[14px] mt-0.5">
                          {f.note}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusTally({
  label,
  count,
  status,
}: {
  label: string;
  count: number;
  status: FeedStatus;
}): JSX.Element {
  return (
    <Badge tone={STATUS_TONE[status]}>
      <span className="inline-flex items-center gap-1">
        <StatusDot tone={status} />
        {label}
        <span className="tabular-nums">{count}</span>
      </span>
    </Badge>
  );
}
