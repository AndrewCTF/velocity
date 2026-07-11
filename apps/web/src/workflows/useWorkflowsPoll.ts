// Light refresh hook for Workflows views — exact mirror of foundry's
// useFoundryPoll.ts (see that file's comment for the rationale), gated on
// app === 'workflows' instead of 'foundry'.
import { useEffect, useRef } from 'react';
import { useAppView } from '../state/appView.js';

export function useWorkflowsPoll(fn: () => void | Promise<void>, intervalMs = 30_000): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const app = useAppView((s) => s.app);

  useEffect(() => {
    if (app !== 'workflows') return; // paused while another app is up
    let active = document.visibilityState === 'visible';
    let timer: ReturnType<typeof setInterval> | null = null;

    const run = (): void => {
      if (document.visibilityState === 'visible') void fnRef.current();
    };
    const start = (): void => {
      stop();
      timer = setInterval(run, intervalMs);
    };
    const stop = (): void => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = (): void => {
      const now = document.visibilityState === 'visible';
      if (now && !active) run(); // refetch on resume
      active = now;
      if (now) start();
      else stop();
    };

    run(); // immediate on activation
    if (active) start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
  }, [app, intervalMs]);
}
