import { useEffect, useState } from 'react';
import { Widget, Caveat } from '../shell/instruments.js';
import { apiFetch } from '../transport/http.js';

// Real AIS-gap list for the selected vessel — sourced from the dossier's
// track-reconstruction (app/intel/dossier.py _track_stats: any >10 min hole
// between consecutive fixes), NOT a synthesized or estimated number. The
// journalist-study finding this fixes: the gap COUNT already reached the UI
// (dossier assessment text) but the actual gap list (when/where) never did,
// so "3 AIS gaps" read as an unverifiable claim. This card renders the real
// entries, or nothing at all when there are none — never a fabricated one.

interface Gap {
  start: number;
  end: number;
  minutes: number;
  lon: number;
  lat: number;
}

interface DossierResponse {
  found: boolean;
  track?: { gaps?: Gap[] };
}

function fmtUtc(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(11, 19) + 'Z';
}

export function AisGapCard({ mmsi }: { mmsi: string | null | undefined }): JSX.Element | null {
  const [gaps, setGaps] = useState<Gap[] | null>(null);

  useEffect(() => {
    setGaps(null);
    if (!mmsi) return;
    const ab = new AbortController();
    apiFetch(`/api/intel/dossier/vessel/${encodeURIComponent(mmsi)}`, { signal: ab.signal })
      .then((r) => (r.ok ? (r.json() as Promise<DossierResponse>) : null))
      .then((j) => {
        if (ab.signal.aborted) return;
        setGaps(j?.found ? (j.track?.gaps ?? []) : []);
      })
      .catch(() => {
        if (!ab.signal.aborted) setGaps([]);
      });
    return () => ab.abort();
  }, [mmsi]);

  // Nothing to show and nothing pending: render nothing rather than a bare
  // count or an empty-state placeholder — the caller's dealbreaker was a UI
  // that implied gap data existed without showing it.
  if (!mmsi || !gaps || gaps.length === 0) return null;

  return (
    <Widget title="AIS gaps" count={gaps.length}>
      <Caveat level="SOURCED" note="from the recorded track, not estimated" tone="neutral" />
      <ul className="mt-1.5 space-y-1">
        {gaps.slice(0, 12).map((g, i) => (
          <li
            key={`${g.start}-${i}`}
            className="mono text-[10px] text-txt-2 tabular-nums flex items-center justify-between gap-2 border border-line rounded-sm px-1.5 py-1 bg-bg-2/60"
          >
            <span>
              {fmtUtc(g.start)}–{fmtUtc(g.end)}
            </span>
            <span className="text-warn">{g.minutes} min</span>
            <span className="text-txt-3">
              {g.lat.toFixed(2)}, {g.lon.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </Widget>
  );
}
