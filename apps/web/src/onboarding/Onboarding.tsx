// First-run onboarding overlay. Shows once (localStorage-gated) on the live map
// routes, walks a new analyst through what the console is and where the tools
// live, then gets out of the way. Style mirrors SettingsModal (bg-bg-1 card,
// mono type, accent-line focus). Re-openable from Settings via `resetOnboarding`.
import { useEffect, useState } from 'react';
import { MousePointerClick, Radar, Settings2, Waypoints, type LucideIcon } from 'lucide-react';

const SEEN_KEY = 'velocity.onboarded.v1';

export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true; // no storage → don't nag
  }
}

function markOnboarded(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* private mode — fine, it just shows again next load */
  }
}

/** Clear the flag so the tour shows again (wired to a Settings link if wanted). */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    /* ignore */
  }
}

interface Step {
  tag: string;
  title: string;
  icon: LucideIcon;
  body: JSX.Element;
}

const STEPS: Step[] = [
  {
    tag: 'Welcome',
    icon: Radar,
    title: 'A live OSINT intelligence console',
    body: (
      <>
        Velocity fuses real-time <b className="text-txt-1">ADS-B aircraft</b>,{' '}
        <b className="text-txt-1">AIS vessels</b>, satellites, imagery, ground photos, ACARS
        and digital OSINT onto one Cesium globe — with a Palantir-Gotham-style analyst
        workflow on top. The core feeds run <span className="text-accent">keyless</span>: open
        it and aircraft, ships, quakes and satellites are already moving.
      </>
    ),
  },
  {
    tag: 'The map',
    icon: MousePointerClick,
    title: 'Click anything to interrogate it',
    body: (
      <>
        Every aircraft and vessel renders as its <b className="text-txt-1">category icon</b>,
        rotated to real heading. <b className="text-txt-1">Click one</b> to open the inspector
        on the right — identity, track history, pattern-of-life. The{' '}
        <b className="text-txt-1">left rail</b> toggles layers (traffic, maritime, satellites,
        imagery, fires). Drag to Europe or the Gulf to see the density.
      </>
    ),
  },
  {
    tag: 'Analysis',
    icon: Waypoints,
    title: 'From raw feeds to sense-making',
    body: (
      <>
        Draw a <b className="text-txt-1">watchbox</b> or AOI and get alerts. The{' '}
        <b className="text-txt-1">ontology graph</b> resolves entities and links them;
        behavioral detectors flag AIS gaps, loitering and proximity; the{' '}
        <b className="text-txt-1">watch-officer</b> writes cited incident briefs. Command-K
        opens the omnibar to jump anywhere.
      </>
    ),
  },
  {
    tag: 'Make it yours',
    icon: Settings2,
    title: 'Keys, layout & local AI live in Settings',
    body: (
      <>
        The core is keyless, but <b className="text-txt-1">Settings</b> (top-right) lets you
        bring your own keys for extras — NASA FIRMS fires, high-res satellite imagery — pick a{' '}
        <b className="text-txt-1">dashboard layout</b>, and route AI to a local GPU model. You
        can always re-open this tour from there.
      </>
    ),
  },
];

export function Onboarding({ onClose }: { onClose: () => void }): JSX.Element | null {
  const [i, setI] = useState(0);
  const last = i === STEPS.length - 1;

  const finish = (): void => {
    markOnboarded();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish();
      if (e.key === 'ArrowRight' && !last) setI((n) => n + 1);
      if (e.key === 'ArrowLeft' && i > 0) setI((n) => n - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, last]);

  const step = STEPS[i];
  if (!step) return null;

  return (
    <div
      className="fixed inset-0 z-[var(--z-wizard)] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={finish}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Velocity"
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-md border border-line bg-bg-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="mono text-[12px] tracking-[0.12em] uppercase text-accent">
            {step.tag}
          </span>
          <button
            type="button"
            onClick={finish}
            className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-accent"
          >
            Skip
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-sm border border-line-2 bg-bg-2">
              <step.icon aria-hidden className="h-[18px] w-[18px] text-accent" strokeWidth={1.75} />
            </span>
            <h2 className="mono text-[15px] font-semibold text-txt-0 leading-snug">
              {step.title}
            </h2>
          </div>
          <p className="mono text-[12px] text-txt-2 leading-relaxed mt-2.5">{step.body}</p>
        </div>

        <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
          <div className="flex gap-1.5" aria-hidden="true">
            {STEPS.map((_, n) => (
              <span
                key={n}
                className={`h-1.5 w-1.5 rounded-full ${n === i ? 'bg-accent' : 'bg-line'}`}
              />
            ))}
          </div>
          <div className="flex gap-1.5">
            {i > 0 && (
              <button
                type="button"
                onClick={() => setI((n) => n - 1)}
                className="mono text-[11px] px-2.5 py-1 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-txt-1"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => (last ? finish() : setI((n) => n + 1))}
              className="mono text-[11px] px-3 py-1 border border-accent-line bg-accent-dim rounded-sm text-txt-0 hover:text-accent"
            >
              {last ? 'Start exploring →' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
