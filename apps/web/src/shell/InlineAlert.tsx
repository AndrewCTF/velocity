// Shared inline alert row — the single home for the "tinted border + tinted bg
// + lightened foreground" pattern that had been hand-copied across the app
// (border-alert-line / bg-alert-bg / text-alert-fg and its warn/ok/info kin).
// tone drives the colour family; everything reads from tokens.css so both the
// dark and light themes stay correct. Use this instead of re-deriving the
// classes inline.
import type { ReactNode } from 'react';

export type AlertTone = 'info' | 'warn' | 'alert' | 'ok';

const TONE: Record<AlertTone, string> = {
  info: 'text-accent-fg bg-accent-dim border-accent-line',
  warn: 'text-warn-fg bg-warn-bg border-warn-line',
  alert: 'text-alert-fg bg-alert-bg border-alert-line',
  ok: 'text-ok bg-ok-bg border-ok-line',
};

export function InlineAlert({
  tone = 'info',
  children,
  icon,
  className = '',
  role,
}: {
  tone?: AlertTone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  // Defaults to "alert" (assertive-ish) for the alert tone, "status" otherwise.
  role?: 'alert' | 'status' | 'note';
}): JSX.Element {
  return (
    <div
      role={role ?? (tone === 'alert' ? 'alert' : 'status')}
      className={`flex items-start gap-2 rounded-sm border px-2.5 py-2 text-[11px] leading-snug ${TONE[tone]} ${className}`}
    >
      {icon != null && <span className="flex-none mt-[1px]">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
