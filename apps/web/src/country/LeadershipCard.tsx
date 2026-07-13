// Leadership card — portrait tiles for the current head of state / head of
// government / defence & foreign ministers / commander-in-chief from the
// Wikidata profile endpoint. Portraits are Wikimedia Commons Special:FilePath
// URLs; we request a 128px thumbnail, lazy-load, and fall back to an initials
// avatar on error or when no image exists.

import { useState } from 'react';
import {
  Card,
  CaveatList,
  Skeleton,
  humanizeRole,
  type FetchState,
  type LeadershipEntry,
  type ProfileResponse,
} from './shared.js';

// Stable strategic ordering: state > government > defence > foreign > CINC.
function roleRank(role: string): number {
  const r = role.toLowerCase();
  if (r.includes('head of state')) return 0;
  if (r.includes('head of government')) return 1;
  if (r.includes('defence') || r.includes('defense')) return 2;
  if (r.includes('foreign')) return 3;
  if (r.includes('commander')) return 4;
  return 5;
}

function initials(name: string): string {
  const words = name
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w.charAt(0)));
  if (words.length === 0) return '?';
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}

function thumbUrl(image: string): string {
  return `${image}${image.includes('?') ? '&' : '?'}width=128`;
}

function Portrait({ entry }: { entry: LeadershipEntry }): JSX.Element {
  const [broken, setBroken] = useState(false);
  const showImage = Boolean(entry.image) && !broken;
  return (
    <div className="w-12 h-12 shrink-0 rounded-sm overflow-hidden border border-line-2 bg-bg-3 flex items-center justify-center">
      {showImage ? (
        <img
          src={thumbUrl(entry.image as string)}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <span data-testid="initials-avatar" className="font-label text-[14px] text-txt-2 select-none">
          {initials(entry.person)}
        </span>
      )}
    </div>
  );
}

function LeaderTile({ entry }: { entry: LeadershipEntry }): JSX.Element {
  const role = humanizeRole(entry.role);
  const position = entry.position && entry.position !== entry.role ? entry.position : null;
  return (
    <div className="flex items-center gap-2.5 border border-line-2 bg-bg-2 rounded-sm p-2 min-w-0">
      <Portrait entry={entry} />
      <div className="min-w-0 flex flex-col gap-px">
        <div className="text-[12px] font-semibold text-txt-0 truncate" title={entry.person}>
          {entry.person}
        </div>
        <div className="text-[10px] uppercase tracking-[0.5px] text-txt-3 truncate" title={role}>
          {role}
        </div>
        {position && (
          <div className="text-[10px] text-txt-3 truncate" title={position}>
            {position}
          </div>
        )}
        {entry.start && <div className="mono text-[9.5px] text-txt-4">since {entry.start}</div>}
      </div>
    </div>
  );
}

export function LeadershipCard({ state }: { state: FetchState<ProfileResponse> }): JSX.Element {
  const { loading, error, data } = state;
  const leaders = data ? [...data.leadership].sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.role.localeCompare(b.role)) : [];
  return (
    <Card title="Leadership" meta={data ? data.source : undefined}>
      {loading && (
        <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2.5 p-2">
              <Skeleton className="w-12 h-12" />
              <div className="flex-1 flex flex-col gap-1.5">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      )}
      {!loading && error && <div className="mono text-[10px] text-alert-fg">Failed to load leadership: {error}</div>}
      {!loading && !error && data?.unavailable && (
        <div className="mono text-[10px] text-txt-4">
          Wikidata unavailable{data.note ? ` — ${data.note}` : ''}; retries shortly.
        </div>
      )}
      {!loading && !error && data && !data.unavailable && leaders.length === 0 && (
        <div className="mono text-[10px] text-txt-4">No leadership records on Wikidata for this country.</div>
      )}
      {!loading && leaders.length > 0 && (
        <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {leaders.map((l) => (
            <LeaderTile key={`${l.role}:${l.person}`} entry={l} />
          ))}
        </div>
      )}
      {!loading && !error && data && !data.unavailable && (
        <CaveatList notes={['Wikidata current-holder inference: latest dated appointment per role wins.']} />
      )}
    </Card>
  );
}
