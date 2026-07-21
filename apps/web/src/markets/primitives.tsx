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
  return <div className="mono text-[10px] text-alert-fg">{children}</div>;
}
