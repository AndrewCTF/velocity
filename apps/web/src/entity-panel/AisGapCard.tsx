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
  window_requested_s?: number;
  window_available_from_ts?: number;
}

// A shortened window is only worth flagging once it's meaningfully short of
// the ask — this tolerance absorbs the few seconds of clock skew between the
// backend's window_available_from_ts and the browser's Date.now().
const SHORTENED_MARGIN_S = 60;

interface GapState {
  gaps: Gap[];
  // The effective DB-tier history is shorter than what was nominally
  // requested (byte-cap-bound store, see dossier.py window_note) — a
  // "no gaps" render here can never be mistaken for "no gaps existed".
  shortened: boolean;
  availableHours: number;
}

function fmtUtc(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(11, 19) + 'Z';
}

export function AisGapCard({ mmsi }: { mmsi: string | null | undefined }): JSX.Element | null {
  const [state, setState] = useState<GapState | null>(null);

  useEffect(() => {
    setState(null);
    if (!mmsi) return;
    const ab = new AbortController();
    apiFetch(`/api/intel/dossier/vessel/${encodeURIComponent(mmsi)}`, { signal: ab.signal })
      .then((r) => (r.ok ? (r.json() as Promise<DossierResponse>) : null))
      .then((j) => {
        if (ab.signal.aborted) return;
        if (!j?.found) {
          setState({ gaps: [], shortened: false, availableHours: 0 });
          return;
        }
        const requestedS = j.window_requested_s;
        const availableTs = j.window_available_from_ts;
        const availableS = availableTs != null ? Date.now() / 1000 - availableTs : null;
        const shortened =
          requestedS != null && availableS != null && availableS < requestedS - SHORTENED_MARGIN_S;
        setState({
          gaps: j.track?.gaps ?? [],
          shortened,
          availableHours: availableS != null ? availableS / 3600 : 0,
        });
      })
      .catch(() => {
        if (!ab.signal.aborted) setState({ gaps: [], shortened: false, availableHours: 0 });
      });
    return () => ab.abort();
  }, [mmsi]);

  // Nothing to show and nothing pending: render nothing rather than a bare
  // count or an empty-state placeholder — the caller's dealbreaker was a UI
  // that implied gap data existed without showing it. But when the DB-tier
  // window is SHORTENED, render even with zero gaps — otherwise "no gaps
  // shown" silently reads as "no gaps existed" when the store simply never
  // held that far back.
  if (!mmsi || !state || (state.gaps.length === 0 && !state.shortened)) return null;

  return (
    <Widget title="AIS gaps" count={state.gaps.length}>
      <Caveat level="SOURCED" note="from the recorded track, not estimated" tone="neutral" />
      {state.shortened && (
        <div className="mono text-[10px] text-warn mt-1">
          Gaps within available history · last {state.availableHours.toFixed(1)} h
        </div>
      )}
      {state.gaps.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {state.gaps.slice(0, 12).map((g, i) => (
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
      )}
    </Widget>
  );
}
