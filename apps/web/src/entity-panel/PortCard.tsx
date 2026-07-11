import { Widget, Badge, KV, KVRow, MicroLabel } from '../shell/instruments.js';
import type { PortEnrichment } from '../transport/entity.js';

// WPI harbor fields are plain-text strings ("Large"/"Good"/"Unknown"…), not
// letter codes. Render them as badges/rows AS-IS — never re-code or infer a
// value the data doesn't carry. op_status is always "Unknown" today: NGA's
// World Port Index has no live closure feed (docs/places-airspace-plan.md §7).
const CAPABILITY_FIELDS: { key: keyof PortEnrichment; label: string }[] = [
  { key: 'shelter', label: 'Shelter' },
  { key: 'repairs', label: 'Repairs' },
  { key: 'dryDock', label: 'Dry dock' },
  { key: 'railway', label: 'Railway' },
  { key: 'portSecurity', label: 'Security' },
];

export function PortCard({ enrichment }: { enrichment: PortEnrichment }): JSX.Element {
  const hasDepths =
    (typeof enrichment.cargoPierDepth === 'number' && enrichment.cargoPierDepth > 0) ||
    (typeof enrichment.channelDepth === 'number' && enrichment.channelDepth > 0);
  const hasMaxVessel =
    typeof enrichment.maxVesselLength === 'number' ||
    typeof enrichment.maxVesselBeam === 'number' ||
    typeof enrichment.maxVesselDraft === 'number';

  return (
    <Widget title="Seaport">
      <div className="space-y-3">
        <KV>
          <KVRow k="Status" v={enrichment.op_status ?? 'Unknown'} />
          {enrichment.harborSize && <KVRow k="Harbor size" v={enrichment.harborSize} />}
          {enrichment.harborType && <KVRow k="Harbor type" v={enrichment.harborType} />}
          {enrichment.harborUse && <KVRow k="Harbor use" v={enrichment.harborUse} />}
        </KV>

        <div className="flex flex-wrap gap-1.5">
          {CAPABILITY_FIELDS.map(({ key, label }) => {
            const v = enrichment[key];
            if (typeof v !== 'string' || !v) return null;
            return (
              <Badge key={key} tone={v === 'None' || v === 'Unknown' ? 'neutral' : 'accent'}>
                {label}: {v}
              </Badge>
            );
          })}
        </div>

        {hasDepths && (
          <div>
            <MicroLabel>Depths</MicroLabel>
            <KV className="mt-1">
              {typeof enrichment.cargoPierDepth === 'number' && enrichment.cargoPierDepth > 0 && (
                <KVRow k="Cargo pier" v={`${enrichment.cargoPierDepth} m`} />
              )}
              {typeof enrichment.channelDepth === 'number' && enrichment.channelDepth > 0 && (
                <KVRow k="Channel" v={`${enrichment.channelDepth} m`} />
              )}
            </KV>
          </div>
        )}

        {hasMaxVessel && (
          <div>
            <MicroLabel>Max vessel</MicroLabel>
            <KV className="mt-1">
              {typeof enrichment.maxVesselLength === 'number' && (
                <KVRow k="Length" v={`${enrichment.maxVesselLength} m`} />
              )}
              {typeof enrichment.maxVesselBeam === 'number' && <KVRow k="Beam" v={`${enrichment.maxVesselBeam} m`} />}
              {typeof enrichment.maxVesselDraft === 'number' && (
                <KVRow k="Draft" v={`${enrichment.maxVesselDraft} m`} />
              )}
            </KV>
          </div>
        )}
      </div>
    </Widget>
  );
}
