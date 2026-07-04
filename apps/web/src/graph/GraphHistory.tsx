// History helper for the investigation canvas — Gotham-style "graph change over
// time + who changed it". Read-only: scrubbing filters the rendered node set to
// the chosen revision; any live mutation snaps back to live. Class vocabulary
// mirrors InvestigationCanvas.tsx (mono text-[10px], border-line, text-txt-*,
// text-accent) plus the shared MicroLabel idiom.
import { useInvestigation } from './investigationStore.js';
import { MicroLabel } from '../shell/instruments.js';

export function GraphHistory(): JSX.Element | null {
  const revisions = useInvestigation((s) => s.revisions);
  const viewRev = useInvestigation((s) => s.viewRev);
  const setViewRev = useInvestigation((s) => s.setViewRev);
  if (revisions.length === 0) return null;
  const at = viewRev ?? revisions.length - 1;
  return (
    <div className="border-t border-line px-2 py-1.5 mono text-[10px]">
      <div className="flex items-center gap-2">
        <MicroLabel className="text-txt-3">History</MicroLabel>
        <input
          type="range"
          min={0}
          max={revisions.length - 1}
          value={at}
          onChange={(e) => {
            const i = Number(e.currentTarget.value);
            setViewRev(i === revisions.length - 1 ? null : i);
          }}
          className="flex-1"
          aria-label="Graph history scrubber"
        />
        {viewRev !== null && (
          <button type="button" className="text-accent" onClick={() => setViewRev(null)}>
            live
          </button>
        )}
      </div>
      <ol className="mt-1 max-h-24 overflow-y-auto">
        {revisions.map((r, i) => (
          <li key={r.ts + ':' + i} className={i === at ? 'text-txt-1' : 'text-txt-3'}>
            <button type="button" onClick={() => setViewRev(i === revisions.length - 1 ? null : i)}>
              {new Date(r.ts).toLocaleTimeString()} · {r.author} · {r.label} · {r.nodeIds.length} nodes
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
