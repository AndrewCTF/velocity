import { useEffect, useState } from 'react';
import { useFeeds, useAlerts, type FeedStatus } from '../state/stores.js';
import { useEntityStats, acquireStats } from '../globe/entityStats.js';
import { apiFetch } from '../transport/http.js';
import type { AlertSeverity } from '@osint/shared';

interface TsBucket {
  t: number;
  aircraft: number;
  vessel: number;
  total: number;
}

// Metrics (design §8 "effects analysis") — a live ops-cadence readout over the
// current picture: contact volume by type, feed health, and alert volume by
// severity. Client-side aggregation of the same live stores the map reads (no
// fabricated history — this is the CURRENT session's cadence, honestly scoped).

const FEED_TONE: Record<FeedStatus, string> = {
  green: 'var(--ok)',
  amber: 'var(--warn)',
  red: 'var(--alert)',
  unknown: 'var(--txt-3)',
};
const SEV_TONE: Record<string, string> = {
  critical: 'var(--alert)',
  high: 'var(--alert)',
  medium: 'var(--warn)',
  low: 'var(--sev-low)',
  info: 'var(--txt-2)',
};
const SEVERITIES: readonly AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }): JSX.Element {
  return (
    <div className="border border-line rounded-sm bg-bg-1 px-3 py-2">
      <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3">{label}</div>
      <div className="mono text-[20px] text-txt-0 tabular-nums leading-tight mt-0.5">{value}</div>
      {sub && <div className="mono text-[10px] text-txt-3 mt-0.5">{sub}</div>}
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }): JSX.Element {
  const W = 100;
  const H = 28;
  if (values.length < 2) {
    return <div className="h-7 flex items-center mono text-[10px] text-txt-4">accumulating…</div>;
  }
  const max = Math.max(1, ...values);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-7">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function MetricsPanel(): JSX.Element {
  // Drive the shared entity-stats sampler while this panel is open.
  useEffect(() => acquireStats(), []);

  // Metrics-over-time (§8) from the real position store.
  const [ts, setTs] = useState<TsBucket[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await apiFetch('/api/history/timeseries?window_sec=3600&bucket_sec=300', { cache: 'no-store' });
        if (!r.ok || !alive) return;
        const d = (await r.json()) as { buckets?: TsBucket[] };
        if (alive) setTs(d.buckets ?? []);
      } catch {
        /* leave last */
      }
    };
    void load();
    const id = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const stats = useEntityStats();
  const feeds = useFeeds((s) => s.feeds);
  const alerts = useAlerts((s) => s.alerts);

  const feedList = Object.values(feeds);
  const feedLive = feedList.filter((f) => f.status === 'green').length;
  const sevCount: Record<string, number> = {};
  for (const a of alerts) sevCount[a.severity] = (sevCount[a.severity] ?? 0) + 1;

  const catHist = stats.histograms.find((h) => h.facet === 'aircraftCategory');
  const typeHist = stats.histograms.find((h) => h.facet === 'vesselType');

  const bars = (title: string, buckets: { label: string; count: number }[], total: number): JSX.Element => (
    <div>
      <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1.5">{title}</div>
      <div className="space-y-1">
        {buckets.slice(0, 8).map((b) => (
          <div key={b.label} className="flex items-center gap-2">
            <span className="mono text-[11px] text-txt-2 w-28 shrink-0 truncate">{b.label}</span>
            <div className="flex-1 h-2 bg-bg-2 rounded-sm overflow-hidden">
              <div
                className="h-full bg-accent"
                style={{ width: `${total > 0 ? Math.round((b.count / total) * 100) : 0}%` }}
              />
            </div>
            <span className="mono text-[11px] text-txt-1 tabular-nums w-12 text-right">{b.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="p-3 flex flex-col gap-4 text-txt-1">
      <div className="grid grid-cols-3 gap-2">
        <Tile
          label="Contacts"
          value={stats.counted.toLocaleString()}
          sub={stats.sampledAt ? `sampled ${Math.max(0, Math.round((Date.now() - stats.sampledAt) / 1000))}s ago` : 'sampling…'}
        />
        <Tile label="Feeds live" value={`${feedLive}/${feedList.length}`} sub="green sources" />
        <Tile label="Alerts" value={alerts.length.toLocaleString()} sub="in buffer" />
      </div>

      {/* contacts over time (§8 metrics-over-time from history.db) */}
      <div>
        <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1">
          Contacts over time · last hour {ts.length > 0 && <span className="text-txt-4">(5-min buckets)</span>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mono text-[10px] text-txt-3 mb-0.5">Aircraft</div>
            <Sparkline values={ts.map((b) => b.aircraft)} color="var(--warn)" />
          </div>
          <div>
            <div className="mono text-[10px] text-txt-3 mb-0.5">Vessels</div>
            <Sparkline values={ts.map((b) => b.vessel)} color="var(--ok)" />
          </div>
        </div>
      </div>

      {/* alert volume by severity */}
      <div>
        <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1.5">Alert volume · by severity</div>
        <div className="flex items-end gap-1.5 h-16">
          {SEVERITIES.map((s) => {
            const n = sevCount[s] ?? 0;
            const max = Math.max(1, ...SEVERITIES.map((x) => sevCount[x] ?? 0));
            return (
              <div key={s} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full flex items-end" style={{ height: 48 }}>
                  <div className="w-full rounded-sm" style={{ height: `${(n / max) * 100}%`, background: SEV_TONE[s], minHeight: n > 0 ? 3 : 0 }} />
                </div>
                <span className="mono text-[10px] uppercase text-txt-3">{s.slice(0, 4)}</span>
                <span className="mono text-[10px] tabular-nums text-txt-1">{n}</span>
              </div>
            );
          })}
        </div>
      </div>

      {catHist && bars('Aircraft · by category', catHist.buckets, catHist.total)}
      {typeHist && bars('Vessels · by type', typeHist.buckets, typeHist.total)}

      {/* feed roster */}
      <div>
        <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1.5">Sources</div>
        <ul className="divide-y divide-line border-y border-line">
          {feedList.map((f) => (
            <li key={f.id} className="flex items-center gap-2 py-1.5">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: FEED_TONE[f.status] }} />
              <span className="mono text-[11px] text-txt-1 truncate flex-1">{f.label}</span>
              <span className="mono text-[10px] uppercase text-txt-3">{f.status}</span>
            </li>
          ))}
          {feedList.length === 0 && (
            <li className="py-2 mono text-[11px] text-txt-3">No feed health reported yet.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
