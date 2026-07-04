import { useEffect, useMemo, useRef, useState, memo } from 'react';
import type * as Cesium from 'cesium';
import { useAlerts } from '../state/stores.js';
import { slewToEntity } from '../globe/camera.js';
import { SectionLabel, Badge, Btn, type BadgeTone } from '../shell/instruments.js';
import type { Alert } from '@osint/shared';

interface Props {
  open: boolean;
  onClose: () => void;
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

// Severity → header-summary count colour.
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

  // Derive off the buffer once per buffer/filter change — not on every render
  // (e.g. toggling a filter chip no longer re-walks all 500 alerts five times).
  const filtered = useMemo(
    () =>
      alerts.filter((a) => {
        if (filterSev && a.severity !== filterSev) return false;
        if (filterRule && a.ruleId !== filterRule) return false;
        return true;
      }),
    [alerts, filterSev, filterRule],
  );
  const ruleKeys = useMemo(() => Array.from(new Set(alerts.map((a) => a.ruleId))), [alerts]);
  const sevCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of alerts) c[a.severity] = (c[a.severity] ?? 0) + 1;
    return c;
  }, [alerts]);

  // All hooks above run every render; only the visual tree is gated on `open`
  // (a conditional return placed ABOVE the useMemos changed the hook count on
  // open/close → "rendered more hooks than during the previous render" crash).
  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[1450] bg-black/40 backdrop-blur-[1px] cursor-default"
        onClick={onClose}
        aria-label="Close alerts"
      />
      <aside
        ref={dialogRef}
        className="fixed top-[46px] bottom-[170px] right-0 z-[1460] w-full max-w-[460px] bg-bg-1 border-l border-line-2 rounded-l-md flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Alerts"
        style={{
          boxShadow:
            'inset 1px 0 0 rgba(0,0,0,0.5), inset -1px 0 0 rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <header className="px-4 py-3 border-b border-line-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mono text-[11px] tracking-[1px] uppercase text-txt-0">Alerts</div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1.5">
              <span className="mono text-[10px] tracking-[0.4px] uppercase text-txt-3 tabular-nums">
                {alerts.length} TOTAL
              </span>
              {Object.entries(sevCounts).map(([sev, n]) => (
                <span
                  key={sev}
                  className={`mono text-[10px] tracking-[0.4px] uppercase tabular-nums ${SEV_LABEL[sev] ?? 'text-txt-3'}`}
                >
                  {sev} {n}
                </span>
              ))}
            </div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <Btn size="sm" onClick={() => clear()} title="Clear alert buffer">
              clear
            </Btn>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              className="mono text-[11px] px-2 py-1 border border-line-2 bg-bg-2 rounded-sm text-txt-1 hover:border-accent-line hover:text-accent transition-colors"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="px-4 py-2.5 border-b border-line-2 flex flex-wrap items-center gap-1">
          <span className="mono text-[10px] tracking-[0.7px] uppercase text-txt-3 mr-1">sev</span>
          {['critical', 'high', 'medium', 'low'].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilterSev((cur) => (cur === s ? null : s))}
              className={`mono text-[10px] tracking-[0.4px] uppercase px-1.5 py-0.5 border rounded-sm transition-colors ${
                filterSev === s
                  ? 'border-accent-line bg-accent-dim text-accent'
                  : 'border-line text-txt-3 hover:border-accent-line hover:text-txt-1'
              }`}
              aria-pressed={filterSev === s}
            >
              {s} <span className="tabular-nums text-txt-2">{sevCounts[s] ?? 0}</span>
            </button>
          ))}
          {ruleKeys.length > 0 && (
            <span className="mono text-[10px] tracking-[0.7px] uppercase text-txt-3 ml-2 mr-1">rule</span>
          )}
          {ruleKeys.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setFilterRule((cur) => (cur === r ? null : r))}
              className={`mono text-[10px] tracking-[0.4px] uppercase px-1.5 py-0.5 border rounded-sm transition-colors ${
                filterRule === r
                  ? 'border-accent-line bg-accent-dim text-accent'
                  : 'border-line text-txt-3 hover:border-accent-line hover:text-txt-1'
              }`}
              aria-pressed={filterRule === r}
            >
              {RULE_LABEL[r] ?? r}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {filtered.length === 0 ? (
            <p className="text-[10.5px] leading-snug text-txt-3 px-1 py-3 text-center">
              {alerts.length === 0
                ? 'No alerts in buffer. Correlation rules fire when criteria match.'
                : 'No alerts match the current filters.'}
            </p>
          ) : (
            <>
              <SectionLabel title="Buffer" count={filtered.length} />
              {/* Polite live region — announce newly-arrived alerts to assistive
                  tech without re-reading the whole buffer (additions only). */}
              <ul
                className="divide-y divide-line border-b border-line"
                aria-live="polite"
                aria-relevant="additions"
                aria-label="Alert buffer"
              >
                {filtered.map((a) => (
                  <li key={a.id}>
                    <AlertCard alert={a} viewer={viewer} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

// Memoized so a new alert push (or a filter toggle) re-renders only the rows
// that actually changed, not all ≤500 buffered cards. Alert objects are stable
// by id in the buffer, so referential equality holds for untouched rows.
// ponytail: memo is enough at 500 rows; add windowing only if a bigger buffer
// measurably janks the initial render.
const AlertCard = memo(function AlertCard({
  alert: a,
  viewer,
}: {
  alert: Alert;
  viewer: Cesium.Viewer | null;
}): JSX.Element {
  return (
    <article className="relative pl-3 pr-1 py-2.5">
      <span
        className="absolute left-0 top-0 bottom-0 w-[2px]"
        style={{ background: SEV_BAR[a.severity] ?? 'var(--txt-2)' }}
      />
      <div className="flex items-center justify-between gap-2">
        <Badge tone={SEV_BADGE[a.severity] ?? 'neutral'}>{a.severity}</Badge>
        <span className="mono text-[10px] tracking-[0.4px] uppercase tabular-nums text-txt-3">
          {RULE_LABEL[a.ruleId] ?? a.ruleId}
        </span>
      </div>
      <p className="text-[12px] text-txt-0 leading-snug mt-1.5">{a.message}</p>
      <div className="flex items-center gap-2 mt-2">
        <Btn
          size="sm"
          onClick={() => {
            if (viewer && a.geom?.type === 'Point') {
              const [lon, lat] = a.geom.coordinates as [number, number];
              slewToEntity(viewer, a.contributingObservations?.[0], lon, lat, 300_000, 1.0);
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
        {a.contributingObservations?.length > 0 && (
          <span className="mono text-[10px] tabular-nums text-txt-3">
            · {a.contributingObservations.length} contrib
          </span>
        )}
      </div>
    </article>
  );
});
