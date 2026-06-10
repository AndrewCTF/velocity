import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { useAlerts } from '../state/stores.js';
import { flyToPosition } from '../globe/camera.js';
import type { Alert } from '@osint/shared';

interface Props {
  open: boolean;
  onClose: () => void;
  viewer: Cesium.Viewer | null;
}

// "low" severity uses --sev-low (≡ txt-1) so it doesn't collide with the
// teal selection accent. See tokens.css.
const SEV_BG: Record<string, string> = {
  critical: 'border-l-alert bg-alert-bg',
  high: 'border-l-alert bg-alert-bg',
  medium: 'border-l-warn bg-warn-bg',
  low: 'border-l-[var(--sev-low)] bg-bg-2/60',
  info: 'border-l-txt-3',
};

const SEV_LABEL: Record<string, string> = {
  critical: 'text-alert',
  high: 'text-alert',
  medium: 'text-warn',
  low: 'text-[var(--sev-low)]',
  info: 'text-txt-2',
};

const RULE_LABEL: Record<string, string> = {
  emergency_squawk: 'EMERGENCY SQUAWK',
  proximity_mil_vessel: 'MIL ↔ VESSEL',
  major_quake: 'MAJOR QUAKE',
  ais_gap_in_aoi: 'AIS GAP IN AOI',
  mil_in_aoi: 'MIL IN AOI',
};

// Full alerts panel — slide-in from the right, sits above the EntityPanel
// rail. Lists every alert in the live buffer with severity, rule, message,
// confidence, slew-to. Operator can scroll the full history (≤500 buffered).
export function AlertsPanel({ open, onClose, viewer }: Props): JSX.Element | null {
  const alerts = useAlerts((s) => s.alerts);
  const clear = useAlerts((s) => s.clear);
  const [filterSev, setFilterSev] = useState<string | null>(null);
  const [filterRule, setFilterRule] = useState<string | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Close on Escape + focus trap on Tab / Shift+Tab.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      // Standard focusable-elements selector — must be in the DOM, not
      // disabled, and not negative-tabindex.
      const selector =
        'a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(selector),
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !dialog.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus trap: focus close button on open, restore focus on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    // Defer to next tick so the ref is wired up after the dialog renders.
    const id = requestAnimationFrame(() => {
      closeBtnRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') {
        prev.focus();
      }
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  const filtered = alerts.filter((a) => {
    if (filterSev && a.severity !== filterSev) return false;
    if (filterRule && a.ruleId !== filterRule) return false;
    return true;
  });
  const ruleKeys = Array.from(new Set(alerts.map((a) => a.ruleId)));
  const sevCounts: Record<string, number> = {};
  for (const a of alerts) sevCounts[a.severity] = (sevCounts[a.severity] ?? 0) + 1;

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[800] bg-black/40 backdrop-blur-[1px] cursor-default"
        onClick={onClose}
        aria-label="Close alerts"
      />
      <aside
        ref={dialogRef}
        className="fixed top-[46px] bottom-[170px] right-0 z-[810] w-full max-w-[460px] bg-bg-1 border-l border-line flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Alerts"
        style={{
          boxShadow: 'inset 1px 0 0 rgba(0,0,0,0.5), inset -1px 0 0 rgba(255,255,255,0.04)',
        }}
      >
        <header className="px-4 py-3 border-b border-line flex items-center justify-between">
          <div>
            <h2 className="mono text-[13px] text-txt-0">Alerts</h2>
            <p className="micro mt-0.5">
              <span className="mono text-txt-1">{alerts.length}</span> total
              {Object.entries(sevCounts).map(([sev, n]) => (
                <span key={sev} className={`ml-2 ${SEV_LABEL[sev] ?? 'text-txt-3'}`}>
                  {sev} {n}
                </span>
              ))}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => clear()}
              className="mono text-[10px] px-2 py-1 border border-line rounded-sm text-txt-2 hover:text-alert hover:border-alert/40"
            >
              clear
            </button>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              className="mono text-[11px] px-2 py-1 border border-line rounded-sm text-txt-1 hover:border-accent-line"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="px-4 py-2 border-b border-line flex flex-wrap items-center gap-1">
          <span className="micro mr-1">severity:</span>
          {['critical', 'high', 'medium', 'low'].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilterSev((cur) => (cur === s ? null : s))}
              className={`mono text-[10px] px-1.5 py-0.5 border rounded-sm ${
                filterSev === s
                  ? `border-accent-line text-accent`
                  : 'border-line text-txt-2 hover:border-accent-line'
              }`}
              aria-pressed={filterSev === s}
            >
              {s} {sevCounts[s] ?? 0}
            </button>
          ))}
          {ruleKeys.length > 0 && <span className="micro ml-2 mr-1">rule:</span>}
          {ruleKeys.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setFilterRule((cur) => (cur === r ? null : r))}
              className={`mono text-[10px] px-1.5 py-0.5 border rounded-sm ${
                filterRule === r
                  ? 'border-accent-line text-accent'
                  : 'border-line text-txt-2 hover:border-accent-line'
              }`}
              aria-pressed={filterRule === r}
            >
              {RULE_LABEL[r] ?? r}
            </button>
          ))}
        </div>

        <ul className="flex-1 overflow-y-auto p-3 space-y-2">
          {filtered.length === 0 && (
            <li className="micro p-4 text-center">
              {alerts.length === 0
                ? 'No alerts in buffer. Correlation rules fire when criteria match.'
                : 'No alerts match the current filters.'}
            </li>
          )}
          {filtered.map((a) => (
            <li key={a.id}>
              <AlertCard alert={a} viewer={viewer} />
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}

function AlertCard({ alert: a, viewer }: { alert: Alert; viewer: Cesium.Viewer | null }): JSX.Element {
  return (
    <article
      className={`border-l-2 ${SEV_BG[a.severity] ?? ''} px-3 py-2 rounded-r-sm`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={`micro ${SEV_LABEL[a.severity] ?? ''}`}>
          {a.severity.toUpperCase()}
        </span>
        <span className="mono micro tabular-nums">{RULE_LABEL[a.ruleId] ?? a.ruleId}</span>
      </div>
      <p className="text-[12px] text-txt-0 leading-snug mt-1">{a.message}</p>
      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          onClick={() => {
            if (viewer && a.geom?.type === 'Point') {
              const [lon, lat] = a.geom.coordinates as [number, number];
              flyToPosition(viewer, lon, lat, 300_000, 1.0);
            }
          }}
          className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm hover:border-accent-line text-txt-1"
        >
          slew to
        </button>
        <span className="mono micro tabular-nums text-txt-3">
          {new Date(a.t).toISOString().slice(11, 19)}Z
        </span>
        <span className="mono micro tabular-nums text-txt-3">
          conf {(a.confidence * 100).toFixed(0)}%
        </span>
        {a.contributingObservations?.length > 0 && (
          <span className="mono micro tabular-nums text-txt-3">
            · {a.contributingObservations.length} contrib
          </span>
        )}
      </div>
    </article>
  );
}
