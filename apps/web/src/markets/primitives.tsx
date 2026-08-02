// Small local helpers for the Markets app cards. Re-exports the shared
// instrument Card (Widget) so cards read consistent with the rest of the
// shell; Skeleton is a tiny local copy of the country app's shimmer block
// (country/shared.tsx) so this module stays self-contained to markets/.
import type { ReactNode } from 'react';

export { Widget } from '../shell/instruments.js';

export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return <div className={`animate-pulse bg-bg-3 rounded-sm ${className}`} aria-hidden />;
}

export function ErrorLine({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mono text-[12px] text-alert-fg">{children}</div>;
}

/** `2026-08-02T02:51:03.416804+00:00` is a wire value, not a time an operator
 *  reads. The card headers printed it verbatim, microseconds and all. */
export function asOf(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} Z`;
}
