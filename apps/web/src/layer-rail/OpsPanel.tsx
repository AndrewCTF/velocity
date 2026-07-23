// Ops rail tab — the left-rail "Ops" view of the Cobalt/Ink console.
//
// Two honest, fully-wired sections:
//  1) AOI watch   — one row per strategic chokepoint (registry/chokepoints).
//                   Click flies the camera + sets the active AOI. The per-row
//                   numeric is the registry's typical daily transit count and,
//                   when the globe is live, a LIVE in-AOI contact count derived
//                   by sampling every data-source entity at the current clock
//                   time and testing it against the chokepoint bbox.
//  2) Standing detections — grouped severity counts straight off the live alert
//                   buffer (useAlerts), the same buffer the alert ticker reads.
//
// RESKIN/COMPOSE only: every value here is real. No fabricated counts, no dead
// controls. See the design contract — primitives come from shell/instruments.

import { useEffect, useMemo, useState } from 'react';
import * as Cesium from 'cesium';
import type { AlertSeverity } from '@osint/shared';
import { SectionLabel, Badge, type BadgeTone } from '../shell/instruments.js';
import { chokepoints, type Chokepoint } from '../registry/chokepoints.js';
import { useAoi } from '../state/aoi.js';
import { flyToChokepoint } from '../globe/camera.js';
import { apiFetch } from '../transport/http.js';
import { useReducedMotion } from '../shell/useReducedMotion.js';
import { useEntityStats, setStatsViewer, acquireStats } from '../globe/entityStats.js';

// Each chokepoint gets a small category-toned dot so the list scans fast.
// Token refs (the consumer is CSS style.background), one distinct hue per
// category, theme-aware in both light and dark.
const CATEGORY_DOT: Record<Chokepoint['category'], string> = {
  maritime: 'var(--accent)',
  aviation: 'var(--warn)',
  cable: 'var(--mag)',
  'air-corridor': 'var(--ok)',
};

// Live in-AOI contact counts come from the shared entity-stats sampler
// (globe/entityStats.ts) — ONE idle-scheduled walk for the whole app, instead
// of a second per-2s walk here that competed with Cesium's render loop.

// Severity ordering + badge tone mapping for the standing-detections rollup.
const SEVERITY_ORDER: readonly AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
function severityTone(sev: AlertSeverity): BadgeTone {
  if (sev === 'critical' || sev === 'high') return 'alert';
  if (sev === 'medium') return 'warn';
  return 'neutral';
}

export function OpsPanel({
  viewer,
  onOpenAlerts,
}: {
  viewer: Cesium.Viewer | null;
  onOpenAlerts?: () => void;
}): JSX.Element {
  const active = useAoi((s) => s.active);
  const setActive = useAoi((s) => s.setActive);
  const reduced = useReducedMotion();

  // LEVEL view of what is currently inside the operator's watch areas. Polled
  // from /api/alerts/standing (the evaluator's most recent picture × the user's
  // rules) so this section is stable across reloads / reconnects / restarts —
  // unlike the EDGE-triggered alert buffer, which only blips on a fresh crossing.
  const [standing, setStanding] = useState<{ counts: Record<string, number>; total: number }>({
    counts: {},
    total: 0,
  });
  // A non-2xx poll (e.g. a 401 on a deployment that hard-gates this route) must
  // not read the same as "fetched, zero detections" — this carries the HTTP
  // status so the panel can say so instead of showing a confident 0.
  const [standingUnavailable, setStandingUnavailable] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        // no-store: this is a live level poll — never let the browser replay a
        // stale/misrouted cached body (e.g. an index.html served during a backend
        // blip), which would freeze the panel on wrong data.
        const r = await apiFetch('/api/alerts/standing', { cache: 'no-store' });
        if (cancelled) return;
        if (!r.ok) {
          setStandingUnavailable(r.status);
          return;
        }
        const data = (await r.json()) as {
          detections?: unknown[];
          counts?: Record<string, number>;
        };
        if (cancelled) return;
        setStandingUnavailable(null);
        setStanding({ counts: data.counts ?? {}, total: (data.detections ?? []).length });
      } catch {
        /* keep last good counts on a transient failure */
      }
    };
    void poll();
    const handle = window.setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);

  // Live in-AOI contact counts from the shared entity-stats sampler. Subscribing
  // here also keeps that one walk alive (ref-counted) while Ops is open.
  const aoiCounts = useEntityStats((s) => s.aoiCounts);
  useEffect(() => {
    if (!viewer) return;
    setStatsViewer(viewer);
    return acquireStats();
  }, [viewer]);

  // Group the current standing-detection counts by severity, keep only non-empty
  // buckets in a fixed critical→info order.
  const detections = useMemo(() => {
    return SEVERITY_ORDER.flatMap((sev) => {
      const n = standing.counts[sev] ?? 0;
      return n > 0 ? [{ sev, n }] : [];
    });
  }, [standing]);

  return (
    <div className="p-3 space-y-4">
      {/* ── AOI watch ─────────────────────────────────────────────────────── */}
      <section className="space-y-1.5">
        <SectionLabel title="AOI watch" count={chokepoints.length} />
        <div className="space-y-px">
          {chokepoints.map((c) => {
            const isActive = active?.id === c.id;
            const live = aoiCounts[c.id];
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setActive(c);
                  if (viewer) flyToChokepoint(viewer, c, reduced ? 0 : 1.4);
                }}
                aria-pressed={isActive}
                title={c.significance}
                className={[
                  'w-full text-left flex items-center gap-2 border-l-2 pl-2 pr-1 py-[5px]',
                  'hover:bg-bg-3/50 transition-colors',
                  isActive ? 'border-accent bg-accent-dim/40' : 'border-transparent',
                ].join(' ')}
              >
                <span
                  className="h-2 w-2 rounded-sm shrink-0"
                  style={{ background: CATEGORY_DOT[c.category] }}
                />
                <span className="text-[11.5px] text-txt-1 truncate min-w-0 flex-1">{c.name}</span>
                {live !== undefined && (
                  <span
                    className="mono text-[10px] text-accent tabular-nums shrink-0"
                    title="live in-AOI contacts (sampled every 2s)"
                  >
                    {live}
                  </span>
                )}
                {c.daily_transits !== undefined && (
                  <span
                    className="mono text-[10px] text-txt-2 tabular-nums shrink-0"
                    title="typical daily transits"
                  >
                    {c.daily_transits}/d
                  </span>
                )}
                <Badge tone="neutral">{c.region}</Badge>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Standing detections ───────────────────────────────────────────── */}
      {/* Live region: announce detection changes to assistive tech (the counts
          update off a 5 s poll; the rollup is small so polite re-reads are fine). */}
      <section className="space-y-1.5" aria-live="polite">
        <div
          title={
            standingUnavailable != null
              ? `Standing detections unavailable (HTTP ${standingUnavailable})`
              : undefined
          }
        >
          <SectionLabel
            title="Standing detections"
            count={standingUnavailable != null ? '—' : standing.total}
          />
        </div>
        {standingUnavailable != null ? (
          <div className="mono text-[10px] text-alert px-2 py-[5px]">
            Standing detections unavailable (HTTP {standingUnavailable})
          </div>
        ) : detections.length === 0 ? (
          <div className="mono text-[10px] text-txt-3 px-2 py-[5px]">no detections firing</div>
        ) : (
          <div className="space-y-px">
            {detections.map(({ sev, n }) => (
              <button
                key={sev}
                type="button"
                onClick={() => onOpenAlerts?.()}
                className="w-full text-left flex items-center gap-2 px-2 py-[5px] hover:bg-bg-3/50 transition-colors"
              >
                <span className="mono text-[11px] text-txt-1 uppercase tracking-[0.4px] flex-1">
                  {sev}
                </span>
                <Badge tone={severityTone(sev)}>{n}</Badge>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
