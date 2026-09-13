// Idle sign-out timer (ASVS V7.3.1). Pure scheduling: no DOM, no Supabase, so
// it runs under fake timers. IdleSignOut.tsx feeds it input events and turns
// its callbacks into a warning toast and a signOut.

export const DEFAULT_IDLE_MINUTES = 30;
/** How long before the sign-out the warning appears. */
export const IDLE_WARNING_MS = 60_000;

export interface IdleTimerOptions {
  /** Read on every re-arm, so a value that arrives later (runtime config) applies. */
  timeoutMs: () => number;
  warnMs?: number;
  onWarn: (msLeft: number) => void;
  /** Activity after a warning, before the sign-out: withdraw the warning. */
  onResume: () => void;
  onIdle: () => void;
}

export interface IdleTimer {
  /** Call on any user input. */
  activity: () => void;
  stop: () => void;
}

export function createIdleTimer(opts: IdleTimerOptions): IdleTimer {
  let warnT: ReturnType<typeof setTimeout> | null = null;
  let idleT: ReturnType<typeof setTimeout> | null = null;
  let warned = false;
  let stopped = false;
  let armedAt = 0;

  const clear = (): void => {
    if (warnT) clearTimeout(warnT);
    if (idleT) clearTimeout(idleT);
    warnT = idleT = null;
  };

  const arm = (): void => {
    clear();
    armedAt = Date.now();
    const total = Math.max(1000, opts.timeoutMs());
    const warnMs = Math.min(opts.warnMs ?? IDLE_WARNING_MS, total);
    warnT = setTimeout(() => {
      warned = true;
      opts.onWarn(warnMs);
    }, total - warnMs);
    idleT = setTimeout(() => {
      stopped = true;
      clear();
      opts.onIdle();
    }, total);
  };

  arm();

  return {
    activity: () => {
      if (stopped) return;
      if (warned) {
        warned = false;
        opts.onResume();
        arm();
        return;
      }
      // mousemove fires per frame; re-arming once a second is plenty.
      if (Date.now() - armedAt >= 1000) arm();
    },
    stop: () => {
      stopped = true;
      clear();
    },
  };
}

/** Minutes from runtime config when the backend sends a sane number, else the default. */
export function idleMinutesFrom(config: unknown): number {
  const v = (config as { sessionIdleTimeoutMin?: unknown } | null)?.sessionIdleTimeoutMin;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_IDLE_MINUTES;
}
