// Light refresh hook for Foundry views. Runs `fn` immediately on mount (views
// remount on view-change, so activation = fresh data) then on a plain interval,
// but ONLY while Foundry is the active app and the tab is visible — switching
// to Map or backgrounding the tab stops the work. Deliberately not the
// PollGeoJsonAdapter wall-clock-grid scheduler: that phases many feed pollers;
// one 30s interval per active view doesn't need it and shouldn't touch the
// feed invariants.
import { useEffect, useRef } from 'react';
import { useAppView } from '../state/appView.js';

export function useFoundryPoll(fn: () => void | Promise<void>, intervalMs = 30_000): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const app = useAppView((s) => s.app);

  useEffect(() => {
    if (app !== 'foundry') return; // paused while another app is up
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
