import { useEffect, useMemo, useState } from 'react';
import type * as Cesium from 'cesium';
import type { AlertSeverity } from '@osint/shared';
import { Icon } from '../../normal/Icon.js';
import { useFeeds, type FeedHealth } from '../../state/stores.js';
import { useEntityStats, setStatsViewer, acquireStats } from '../../globe/entityStats.js';
import { chokepoints } from '../../registry/chokepoints.js';
import { apiFetch } from '../../transport/http.js';

// Info, built from docs/mockups/console-2026-08 (`15-map-info.html`).
//
// "What is the system doing" was four separate rail panels in the old shell:
// Feeds, Ops, ACARS and Chokepoints. One question with four answers, each in a
// different flyout. They are one panel now, with the old panels' own data.
//
// The measured reason it needed rebuilding: the old Feeds panel showed four
// bare counts (green / amber / red / unknown) at 11px and **zero** marks. Feed
// health is the one readout where the shape of the failure matters more than
// the number, so every source now carries its age and a bar, and the rollup is
// a dot matrix rather than four numbers.

const TONE: Record<string, { dot: string; text: string }> = {
  green: { dot: 'bg-ok', text: 'text-ok' },
  amber: { dot: 'bg-warn', text: 'text-warn-fg' },
  red: { dot: 'bg-alert', text: 'text-alert-fg' },
  unknown: { dot: 'bg-bg-4', text: 'text-txt-3' },
};

/** Severity ordering and dot tone for the standing-detection rollup, carried
 *  over from the Ops panel this one replaces. */
const SEVERITY_ORDER: readonly AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEV_DOT: Record<string, string> = {
  critical: 'bg-alert',
  high: 'bg-alert',
  medium: 'bg-warn',
  low: 'bg-accent',
  info: 'bg-bg-4',
};

function ageOf(f: FeedHealth): string {
  if (!f.lastSeen) return '—';
  const s = Math.max(0, Math.round((Date.now() - f.lastSeen) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

export function InfoPanel({ viewer }: { viewer?: Cesium.Viewer | null }): JSX.Element {
  const feedsMap = useFeeds((s) => s.feeds);
  const counted = useEntityStats((s) => s.counted);
  const aoiCounts = useEntityStats((s) => s.aoiCounts);

  useEffect(() => {
    if (!viewer) return;
    setStatsViewer(viewer);
    return acquireStats();
  }, [viewer]);

  // LEVEL poll of the evaluator's most recent picture × the operator's rules,
  // so this survives reloads and reconnects the way the edge-triggered alert
  // buffer does not. `no-store`: never let the browser replay a stale body from
  // a backend blip and freeze the panel on wrong data.
  const [standing, setStanding] = useState<{ counts: Record<string, number>; total: number }>({
    counts: {},
    total: 0,
  });
  const [standingErr, setStandingErr] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const r = await apiFetch('/api/alerts/standing', { cache: 'no-store' });
        if (cancelled) return;
        if (!r.ok) {
          setStandingErr(r.status);
          return;
        }
        const d = (await r.json()) as { detections?: unknown[]; counts?: Record<string, number> };
        if (cancelled) return;
        setStandingErr(null);
        setStanding({ counts: d.counts ?? {}, total: (d.detections ?? []).length });
      } catch {
        /* keep the last good counts on a transient failure */
      }
    };
    void poll();
    const h = window.setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(h);
    };
  }, []);

  const detections = useMemo(
    () =>
      SEVERITY_ORDER.flatMap((sev) => {
        const n = standing.counts[sev] ?? 0;
        return n > 0 ? [{ sev, n }] : [];
      }),
    [standing],
  );

  const { feeds, live, total } = useMemo(() => {
    const list = Object.values(feedsMap).sort((a, b) => a.label.localeCompare(b.label));
    return {
      feeds: list,
      live: list.filter((f) => f.status === 'green').length,
      total: list.length,
    };
  }, [feedsMap]);

  return (
    <div className="pb-2">
      <section aria-label="System">
        <div className="flex h-[26px] items-center gap-[6px] px-[14px]">
          <span className="text-[12px] font-semibold uppercase tracking-[0.6px] text-txt-2">
            System
          </span>
          <span className="flex-1" />
        </div>
        <div className="flex items-center gap-2 px-[14px] py-[4px] text-[12px]">
          <span className="min-w-0 flex-1 text-txt-1">Contacts in view</span>
          <span className="mono w-[52px] shrink-0 text-right tabular-nums text-txt-1">
            {counted.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 px-[14px] py-[4px] text-[12px]">
          <span className="min-w-0 flex-1 text-txt-1">Sources live</span>
          <span className="mono w-[52px] shrink-0 text-right tabular-nums text-txt-1">
            {live} of {total}
          </span>
          {/* A dot matrix, not four numbers: at this N the shape of the failure
              is the information, and a bar would imply precision it lacks. */}
          <span className="flex w-[66px] shrink-0 flex-wrap gap-[2px]" aria-hidden="true">
            {feeds.slice(0, 16).map((f) => (
              <span
                key={f.id}
                className={`h-[6px] w-[6px] rounded-[1px] ${TONE[f.status]?.dot ?? 'bg-bg-4'}`}
              />
            ))}
          </span>
        </div>
      </section>

      <section aria-label="Feeds">
        <div className="mt-3 flex h-[26px] items-center gap-[6px] border-t border-line px-[14px] pt-[6px]">
          <span className="text-[12px] font-semibold uppercase tracking-[0.6px] text-txt-2">
            Feeds
          </span>
          <span className="flex-1" />
          <span className="mono text-[12px] tabular-nums text-txt-3">
            {live} of {total} live
          </span>
        </div>

        {feeds.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center">
            <Icon name="feed" className="h-6 w-6 text-txt-3" />
            <div className="text-[13px] text-txt-1">No sources reporting yet</div>
            <p className="max-w-[220px] text-[12px] leading-relaxed text-txt-3">
              Feed health appears as each source answers for the first time.
            </p>
          </div>
        ) : (
          feeds.map((f) => {
            const tone = TONE[f.status] ?? TONE.unknown;
            return (
              <div
                key={f.id}
                className="flex min-h-[38px] items-center gap-2 px-[14px] py-1 hover:bg-[var(--hover)]"
                title={f.note ?? undefined}
              >
                <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${tone?.dot}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-txt-1">{f.label}</span>
                  {/* The reason, when there is one. A red dot with no sentence
                      is the silent failure both persona waves kept finding. */}
                  <span className="block truncate text-[12px] text-txt-3">
                    {f.note ?? (f.status === 'green' ? 'reporting' : 'no reason given')}
                  </span>
                </span>
                <span className="mono w-[52px] shrink-0 text-right text-[12px] tabular-nums text-txt-2">
                  {ageOf(f)}
                </span>
                <span
                  className="relative h-[10px] w-[66px] shrink-0 overflow-hidden rounded-[1px] bg-bg-0"
                  aria-hidden="true"
                >
                  <i
                    className={`absolute inset-y-0 left-0 block ${tone?.dot}`}
                    style={{
                      width:
                        f.status === 'green' ? '100%' : f.status === 'amber' ? '45%' : f.status === 'red' ? '12%' : '4%',
                    }}
                  />
                </span>
              </div>
            );
          })
        )}
      </section>
      <section aria-label="AOI watch">
        <div className="mt-3 flex h-[26px] items-center gap-[6px] border-t border-line px-[14px] pt-[6px]">
          <span className="text-[12px] font-semibold uppercase tracking-[0.6px] text-txt-2">
            AOI watch
          </span>
          <span className="flex-1" />
          <span className="mono text-[12px] tabular-nums text-txt-3">{chokepoints.length}</span>
        </div>
        {chokepoints.map((c) => {
          const live = aoiCounts[c.id] ?? 0;
          const typical = c.daily_transits ?? 0;
          // Live against the typical daily rate, so "busier than normal" is
          // read rather than computed.
          const frac = typical > 0 ? Math.min(1, live / (typical / 24)) : 0;
          return (
            <div
              key={c.id}
              className="flex min-h-[38px] items-center gap-2 px-[14px] py-1 hover:bg-[var(--hover)]"
              title={c.region}
            >
              <Icon name="route" className="h-3 w-3 shrink-0 text-txt-3" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-txt-1">{c.name}</span>
                <span className="block truncate text-[12px] text-txt-3">{c.region}</span>
              </span>
              <span className="mono w-[52px] shrink-0 text-right text-[12px] tabular-nums text-txt-2">
                {live > 0 ? live : '—'}
              </span>
              <span
                className="relative h-[10px] w-[66px] shrink-0 overflow-hidden rounded-[1px] bg-bg-0"
                aria-hidden="true"
              >
                <i
                  className={`absolute inset-y-0 left-0 block ${frac > 0.9 ? 'bg-warn' : 'bg-accent'}`}
                  style={{ width: `${Math.max(live > 0 ? 3 : 0, frac * 100)}%` }}
                />
              </span>
            </div>
          );
        })}
      </section>

      {/* Standing detections. The old Ops panel had TWO sections and this
          rebuild carried over one: AOI watch came across, the standing-detection
          rollup did not, so the LEVEL view of what is currently tripping the
          operator's rules was lost. It is a different question from the alert
          ticker, which is EDGE-triggered and only blips on a fresh crossing —
          that is exactly why /api/alerts/standing exists.

          A non-2xx poll says so rather than showing a confident zero. */}
      <section aria-label="Standing detections" aria-live="polite">
        <div className="mt-3 flex h-[26px] items-center gap-[6px] border-t border-line px-[14px] pt-[6px]">
          <span className="text-[12px] font-semibold uppercase tracking-[0.6px] text-txt-2">
            Standing detections
          </span>
          <span className="flex-1" />
          <span className="mono text-[12px] tabular-nums text-txt-3">
            {standingErr !== null ? '—' : standing.total}
          </span>
        </div>
        {standingErr !== null ? (
          <p className="px-[14px] py-[4px] text-[12px] leading-relaxed text-alert-fg">
            Standing detections unavailable (HTTP {standingErr})
          </p>
        ) : detections.length === 0 ? (
          <p className="px-[14px] py-[4px] text-[12px] text-txt-3">No detections firing.</p>
        ) : (
          detections.map(({ sev, n }) => (
            <div
              key={sev}
              className="flex min-h-[24px] items-center gap-2 px-[14px] py-[2px] text-[12px]"
            >
              <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${SEV_DOT[sev]}`} aria-hidden />
              <span className="min-w-0 flex-1 truncate uppercase tracking-[0.4px] text-txt-2">
                {sev}
              </span>
              <span className="mono shrink-0 tabular-nums text-txt-1">{n}</span>
              <span
                className="relative h-[10px] w-[66px] shrink-0 overflow-hidden rounded-[1px] bg-bg-0"
                aria-hidden="true"
              >
                <i
                  className={`absolute inset-y-0 left-0 block ${SEV_DOT[sev]}`}
                  style={{
                    width: `${Math.max(3, Math.min(100, (n / Math.max(1, standing.total)) * 100))}%`,
                  }}
                />
              </span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
