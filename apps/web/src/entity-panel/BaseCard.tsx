import { Widget, Badge, KV, KVRow, Caveat } from '../shell/instruments.js';

// Military-base layer (`app/data/bases.json`, Wikidata SPARQL) has no backend
// enrichment endpoint (docs/places-airspace-plan.md §5) — this card is filled
// entirely from the live property bag already on the map entity: name,
// branch, and position. No fabricated capability/garrison data.
const BRANCH_LABEL: Record<string, string> = {
  air: 'Air',
  naval: 'Naval',
  army: 'Army',
};

export function BaseCard({
  name,
  branch,
  lat,
  lon,
}: {
  name?: string | null;
  branch?: string | null;
  lat?: number | null;
  lon?: number | null;
}): JSX.Element {
  const branchLabel = branch ? (BRANCH_LABEL[branch] ?? branch) : null;
  return (
    <Widget title="Military base">
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          {branchLabel && <Badge tone="warn">{branchLabel}</Badge>}
        </div>
        <KV>
          <KVRow k="Name" v={name || '—'} />
          {typeof lat === 'number' && typeof lon === 'number' && (
            <KVRow k="Position" v={`${lat.toFixed(4)}, ${lon.toFixed(4)}`} />
          )}
        </KV>
        <Caveat
          level="LIMITED DATA"
          note="Wikidata name/branch/coords only — no capability or garrison source"
          tone="neutral"
        />
      </div>
    </Widget>
  );
}
