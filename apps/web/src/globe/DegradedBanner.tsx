// One line at first paint when a capability is not configured.
//
// The single largest cluster of complaints on the highest-scoring launch in
// this category was not a missing feature. It was a map that rendered blank
// because a key was missing and nothing said so:
//
//   "There's no data when I tried it ... No planes etc. No helpful output in
//    the command window."                                   - u/rustyhancock
//   "Yeah this doesn't work on Mac either. This is just broken and
//    nonfunctioning."                                       - u/DetroitThrow
//
// and the author's own diagnosis afterwards: "it's silently failing to fetch
// the streams ... I'm going to push an update to show a prominent 'Backend
// Disconnected / Missing API Keys' warning so it doesn't just look dead."
// (docs/research-last30days-2026-07-29.md §5.1.)
//
// `/api/status/doctor` already knows all of this. This is the half-line of UI
// that stops it being a fact only the API knows.
//
// Deliberately NOT a modal. Everything it reports is optional - the console
// runs keyless - so this is "here is what would widen coverage", not "something
// is broken". A modal would be lying about the severity.
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { apiFetch } from '../transport/http.js';

const DISMISS_KEY = 'velocity.degradedDismissed';

interface Problem {
  capability: string;
  state: string;
  detail: string;
  fix: string | null;
}

function alreadyDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** The banner text. Exported for tests: the wording is the whole point, so it
 *  should not need a browser to check. */
export function degradedText(problems: readonly Problem[]): string | null {
  if (problems.length === 0) return null;
  const names = problems.map((p) => p.capability);
  // Name them when there are few; count them when the list would run off the
  // line. Either way it says what is affected, never just "something is wrong".
  const what = names.length <= 2 ? names.join(' and ') : `${names.length} optional sources`;
  return `${what} not configured. The console runs without them; keys only widen coverage.`;
}

export function DegradedBanner(): JSX.Element | null {
  const loc = useLocation();
  const [dismissed, setDismissed] = useState(alreadyDismissed);
  const [problems, setProblems] = useState<Problem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiFetch('/api/status/doctor');
        if (!r.ok) return;
        const body = (await r.json()) as { problems?: Problem[] };
        if (!cancelled) setProblems(body.problems ?? []);
      } catch {
        // A doctor we cannot reach is not itself worth a banner: the app has
        // louder ways of telling you the backend is down.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loc.pathname !== '/') return null;
  if (dismissed || problems == null) return null;
  const text = degradedText(problems);
  if (!text) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode: dismissed for this session only */
    }
    setDismissed(true);
  };

  return (
    <div
      role="status"
      className="absolute bottom-[204px] left-1/2 -translate-x-1/2 z-[var(--z-dock)] flex items-center gap-2.5 mono text-[10px] px-3 py-1.5 rounded-sm border border-line bg-bg-1/95 text-txt-2 shadow-lg"
    >
      <span>{text}</span>
      <Link to="/?panel=ops" className="text-accent hover:underline">
        details
      </Link>
      <button type="button" onClick={dismiss} className="text-txt-3 hover:text-txt-1">
        dismiss
      </button>
    </div>
  );
}
