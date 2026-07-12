import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { deviceTier } from '../shell/device.js';

// One-shot low-end suggestion. When the graded device probe (shell/device.ts:
// deviceTier) reports a software / very-weak GPU, offer — but never force — the
// 2D MapLibre map, which runs where the 3D globe can't (App2D / "/2d" is the
// sanctioned resilience path). Dismissible; the choice sticks per browser. Shown
// only on the 3D route ("/"); suggesting 2D while already on 2D would be absurd.
const DISMISS_KEY = 'velocity.lowEndDismissed';

function alreadyDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function LowEndBanner(): JSX.Element | null {
  const loc = useLocation();
  const [dismissed, setDismissed] = useState(alreadyDismissed);
  // Only the 3D console home; never /2d, auth, news, studio.
  if (loc.pathname !== '/') return null;
  if (dismissed) return null;
  if (deviceTier() !== 'low') return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode — dismiss for this session only */
    }
    setDismissed(true);
  };

  return (
    <div
      role="status"
      className="absolute bottom-[172px] left-1/2 -translate-x-1/2 z-[var(--z-dock)] flex items-center gap-2.5 mono text-[10px] px-3 py-1.5 rounded-sm border border-accent-line bg-bg-1/95 text-txt-1 shadow-lg"
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
      <span>
        Low-end graphics detected — the <span className="text-accent">2D map</span> runs smoother
        on this device. Or lower <span className="text-txt-0">Settings → Display → quality</span>.
      </span>
      <Link
        to="/2d"
        onClick={dismiss}
        className="px-2 py-0.5 rounded-sm border border-accent-line text-accent hover:bg-accent-dim shrink-0"
      >
        Switch to 2D
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="px-1.5 py-0.5 rounded-sm border border-line text-txt-3 hover:text-txt-1 hover:border-accent-line shrink-0"
      >
        ✕
      </button>
    </div>
  );
}
