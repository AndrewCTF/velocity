import { useState } from 'react';
import type * as Cesium from 'cesium';
import { useAlerts } from '../state/stores.js';
import { slewToEntity } from '../globe/camera.js';
import { useReducedMotion } from '../shell/useReducedMotion.js';
import { SectionLabel, Badge, Btn, type BadgeTone } from '../shell/instruments.js';
import type { Alert, AlertSeverity } from '@osint/shared';

interface Props {
  viewer: Cesium.Viewer | null;
}

// Severity → <Badge> tone. critical/high read as alert, medium as warn, low and
// info stay neutral so they don't collide with the teal selection accent.
const SEV_BADGE: Record<string, BadgeTone> = {
  critical: 'alert',
  high: 'alert',
  medium: 'warn',
  low: 'neutral',
  info: 'neutral',
};

// Severity → left accent bar colour (the 2px rail on each row).
const SEV_BAR: Record<string, string> = {
  critical: 'var(--alert)',
  high: 'var(--alert)',
  medium: 'var(--warn)',
  low: 'var(--sev-low)',
  info: 'var(--txt-2)',
};

const SEVERITIES: readonly AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

// Compact alerts list for the right-rail tab. The full slide-in panel
// (alerts/AlertsPanel.tsx) is still available via 'a' hotkey — this is
// the at-a-glance feed embedded in the rail.
export function AlertsRailList({ viewer }: Props): JSX.Element {
  const alerts = useAlerts((s) => s.alerts);
  const [filterSev, setFilterSev] = useState<AlertSeverity | null>(null);
  const reduced = useReducedMotion();

  const sevCounts: Record<string, number> = {};
  for (const a of alerts) sevCounts[a.severity] = (sevCounts[a.severity] ?? 0) + 1;

  const filtered = filterSev ? alerts.filter((a) => a.severity === filterSev) : alerts;

  return (
    <div className="p-3 space-y-2.5">
      <SectionLabel title="Alerts" count={`${alerts.length} BUF`} />

      <div className="flex flex-wrap items-center gap-1">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilterSev((cur) => (cur === s ? null : s))}
            className={[
              'mono text-[10px] tracking-[0.4px] uppercase px-1.5 py-0.5 border rounded-sm transition-colors',
              filterSev === s
                ? 'border-accent-line bg-accent-dim text-accent'
                : 'border-line text-txt-3 hover:border-accent-line hover:text-txt-1',
            ].join(' ')}
            aria-pressed={filterSev === s}
          >
            {s} <span className="tabular-nums text-txt-2">{sevCounts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-[10.5px] leading-snug text-txt-3">
          {alerts.length === 0
            ? 'No alerts in buffer. Correlation rules fire when criteria match.'
            : 'No alerts match the current filter.'}
        </p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {filtered.slice(0, 50).map((a) => (
            <li key={a.id}>
              <AlertRow alert={a} viewer={viewer} reduced={reduced} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AlertRow({
  alert: a,
  viewer,
  reduced,
}: {
  alert: Alert;
  viewer: Cesium.Viewer | null;
  reduced: boolean;
}): JSX.Element {
  return (
    <article className="relative pl-3 pr-1 py-2">
      <span
        className="absolute left-0 top-0 bottom-0 w-[2px]"
        style={{ background: SEV_BAR[a.severity] ?? 'var(--txt-2)' }}
      />
      <div className="flex items-center justify-between gap-2">
        <Badge tone={SEV_BADGE[a.severity] ?? 'neutral'}>{a.severity}</Badge>
        <span className="mono text-[10px] tracking-[0.4px] uppercase tabular-nums text-txt-3">
          {a.ruleId}
        </span>
      </div>
      <p className="text-[11px] text-txt-1 leading-snug mt-1.5 line-clamp-2">{a.message}</p>
      <div className="flex items-center gap-2 mt-1.5">
        <Btn
          size="sm"
          onClick={() => {
            if (viewer && a.geom?.type === 'Point') {
              const [lon, lat] = a.geom.coordinates as [number, number];
              slewToEntity(viewer, a.contributingObservations?.[0], lon, lat, 250_000, reduced ? 0 : 1.0);
            }
          }}
        >
          slew to
        </Btn>
        <span className="mono text-[10px] tabular-nums text-txt-3">
          {new Date(a.t).toISOString().slice(11, 19)}Z
        </span>
        <span className="mono text-[10px] tabular-nums text-txt-3">
          conf {(a.confidence * 100).toFixed(0)}%
        </span>
      </div>
    </article>
  );
}
