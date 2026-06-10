import { useState } from 'react';
import type * as Cesium from 'cesium';
import { useAlerts } from '../state/stores.js';
import { flyToPosition } from '../globe/camera.js';
import { useReducedMotion } from '../shell/useReducedMotion.js';
import type { Alert, AlertSeverity } from '@osint/shared';

interface Props {
  viewer: Cesium.Viewer | null;
}

// "low" severity uses --sev-low (≡ txt-1) so it doesn't collide with the
// teal selection accent. See tokens.css.
const SEV_LABEL: Record<string, string> = {
  critical: 'text-alert',
  high: 'text-alert',
  medium: 'text-warn',
  low: 'text-[var(--sev-low)]',
  info: 'text-txt-2',
};

const SEV_BG: Record<string, string> = {
  critical: 'border-l-alert bg-alert-bg',
  high: 'border-l-alert bg-alert-bg',
  medium: 'border-l-warn bg-warn-bg',
  low: 'border-l-[var(--sev-low)] bg-bg-2/60',
  info: 'border-l-txt-3',
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
    <div className="p-3 space-y-2">
      <header className="flex items-baseline justify-between">
        <h2 className="micro">Alerts</h2>
        <span className="micro text-txt-3">{alerts.length} buffered</span>
      </header>

      <div className="flex flex-wrap items-center gap-1">
        <span className="micro mr-0.5">sev:</span>
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilterSev((cur) => (cur === s ? null : s))}
            className={[
              'mono text-[10px] px-1.5 py-0.5 border rounded-sm',
              filterSev === s
                ? 'border-accent-line text-accent'
                : 'border-line text-txt-2 hover:border-accent-line',
            ].join(' ')}
            aria-pressed={filterSev === s}
          >
            {s} {sevCounts[s] ?? 0}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="micro normal-case tracking-normal text-txt-3">
          {alerts.length === 0
            ? 'No alerts in buffer. Correlation rules fire when criteria match.'
            : 'No alerts match the current filter.'}
        </p>
      ) : (
        <ul className="space-y-1.5">
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
    <article className={`border-l-2 ${SEV_BG[a.severity] ?? ''} px-2 py-1.5 rounded-r-sm`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`micro ${SEV_LABEL[a.severity] ?? ''}`}>{a.severity.toUpperCase()}</span>
        <span className="mono micro tabular-nums">{a.ruleId}</span>
      </div>
      <p className="text-[11px] text-txt-1 leading-snug mt-1 line-clamp-2">{a.message}</p>
      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          onClick={() => {
            if (viewer && a.geom?.type === 'Point') {
              const [lon, lat] = a.geom.coordinates as [number, number];
              flyToPosition(viewer, lon, lat, 250_000, reduced ? 0 : 1.0);
            }
          }}
          className="mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm hover:border-accent-line text-txt-1"
        >
          slew to
        </button>
        <span className="mono micro tabular-nums text-txt-3">
          {new Date(a.t).toISOString().slice(11, 19)}Z
        </span>
        <span className="mono micro tabular-nums text-txt-3">
          conf {(a.confidence * 100).toFixed(0)}%
        </span>
      </div>
    </article>
  );
}
