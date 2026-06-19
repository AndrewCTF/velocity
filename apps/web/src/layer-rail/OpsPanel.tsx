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
import { useAlerts } from '../state/stores.js';
import { useReducedMotion } from '../shell/useReducedMotion.js';

// Each chokepoint gets a small category-toned dot so the list scans fast.
const CATEGORY_DOT: Record<Chokepoint['category'], string> = {
  maritime: '#38bdf8',
  aviation: '#facc15',
  cable: '#c084fc',
  'air-corridor': '#5eead4',
};

// Count entities across all data sources whose sampled position at the current
// clock time falls inside a chokepoint bbox [west, south, east, north]. This is
// the SAME iteration pattern camera.ts uses (viewer.dataSources + clock time);
// entities without a resolvable position at this instant are skipped.
function countInAoi(viewer: Cesium.Viewer): Map<string, number> {
  const time = viewer.clock.currentTime;
  const out = new Map<string, number>();
  for (const c of chokepoints) out.set(c.id, 0);
  const carto = new Cesium.Cartographic();
  const scratch = new Cesium.Cartesian3();
  for (let d = 0; d < viewer.dataSources.length; d++) {
    const ents = viewer.dataSources.get(d).entities.values;
    for (const e of ents) {
      const pos = e.position?.getValue(time, scratch);
      if (!pos) continue;
      Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84, carto);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      for (const c of chokepoints) {
        const [w, s, ee, n] = c.bbox;
        if (lon >= w && lon <= ee && lat >= s && lat <= n) {
          out.set(c.id, (out.get(c.id) ?? 0) + 1);
        }
      }
    }
  }
  return out;
}

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
  const alerts = useAlerts((s) => s.alerts);
  const reduced = useReducedMotion();

  // Live in-AOI contact counts, recomputed every ~2s off the viewer's clock.
  const [liveCounts, setLiveCounts] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    if (!viewer) {
      setLiveCounts(null);
      return;
    }
    let cancelled = false;
    const tick = (): void => {
      if (cancelled || viewer.isDestroyed()) return;
      setLiveCounts(countInAoi(viewer));
    };
    tick();
    const handle = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [viewer]);

  // Group the live alert buffer by severity, keep only non-empty buckets in a
  // fixed critical→info order.
  const detections = useMemo(() => {
    const counts = new Map<AlertSeverity, number>();
    for (const a of alerts) counts.set(a.severity, (counts.get(a.severity) ?? 0) + 1);
    return SEVERITY_ORDER.flatMap((sev) => {
      const n = counts.get(sev) ?? 0;
      return n > 0 ? [{ sev, n }] : [];
    });
  }, [alerts]);

  return (
    <div className="p-3 space-y-4">
      {/* ── AOI watch ─────────────────────────────────────────────────────── */}
      <section className="space-y-1.5">
        <SectionLabel title="AOI watch" count={chokepoints.length} />
        <div className="space-y-px">
          {chokepoints.map((c) => {
            const isActive = active?.id === c.id;
            const live = liveCounts?.get(c.id);
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
                    className="mono text-[9.5px] text-accent tabular-nums shrink-0"
                    title="live in-AOI contacts (sampled every 2s)"
                  >
                    {live}
                  </span>
                )}
                {c.daily_transits !== undefined && (
                  <span
                    className="mono text-[9.5px] text-txt-2 tabular-nums shrink-0"
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
      <section className="space-y-1.5">
        <SectionLabel title="Standing detections" count={alerts.length} />
        {detections.length === 0 ? (
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
