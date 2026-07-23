// Markets app (shell full-page surface, wired in state/appView.ts +
// shell/AppSurface.tsx). Backend thin routes: /api/markets/snapshot,
// /api/markets/stress, /api/markets/predictions (module B2a). Snapshot +
// stress poll every 120 s, predictions every 300 s — cheap upstream data that
// doesn't need the 1 s cadence the globe uses. Each card owns its own
// loading/error/degraded state so one failed upstream never blanks the page;
// all calls go through apiFetch (transport invariant).
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { SnapshotCard } from './SnapshotCard.js';
import { StressCard } from './StressCard.js';
import { PredictionsCard } from './PredictionsCard.js';
import type { FetchState, PredictionsResponse, SnapshotResponse, StressResponse } from './types.js';

const SNAPSHOT_STRESS_REFRESH_MS = 120_000;
const PREDICTIONS_REFRESH_MS = 300_000;

// Polls `url` on `intervalMs`, fetching immediately on mount. Mirrors the
// news-panel poll pattern (cancelled flag + setInterval, no ttl-elapsed math).
function usePoll<T>(url: string, intervalMs: number): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ loading: true, error: null, data: null });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await apiFetch(url);
        if (cancelled) return;
        if (!r.ok) {
          setState({ loading: false, error: `HTTP ${r.status}`, data: stateRef.current.data });
          return;
        }
        const data = (await r.json()) as T;
        setState({ loading: false, error: null, data });
      } catch (e: unknown) {
        if (cancelled) return;
        setState({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
          data: stateRef.current.data,
        });
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [url, intervalMs]);

  return state;
}

export function MarketsApp(): JSX.Element {
  const snapshot = usePoll<SnapshotResponse>('/api/markets/snapshot', SNAPSHOT_STRESS_REFRESH_MS);
  const stress = usePoll<StressResponse>('/api/markets/stress', SNAPSHOT_STRESS_REFRESH_MS);
  const predictions = usePoll<PredictionsResponse>('/api/markets/predictions', PREDICTIONS_REFRESH_MS);

  return (
    <div className="h-full overflow-auto text-txt-1 bg-bg-0">
      <div className="p-4 flex flex-col gap-3 max-w-[1100px]">
        <SnapshotCard state={snapshot} />
        <StressCard state={stress} />
        <PredictionsCard state={predictions} />
      </div>
    </div>
  );
}
