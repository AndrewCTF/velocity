import type * as Cesium from 'cesium';
import { chokepoints, type Chokepoint } from '../registry/chokepoints.js';
import { flyToChokepoint } from '../globe/camera.js';
import { useAoi } from '../state/aoi.js';
import { useReducedMotion } from '../shell/useReducedMotion.js';
import { SectionLabel, MicroLabel, Badge, Btn, KV, KVRow } from '../shell/instruments.js';

interface Props {
  viewer: Cesium.Viewer | null;
}

const CATEGORY_LABEL: Record<Chokepoint['category'], string> = {
  maritime: 'maritime',
  aviation: 'aviation',
  cable: 'cable',
  'air-corridor': 'air-corridor',
};

// Chokepoints rail tab — strategic AOI list (see registry/chokepoints.ts).
// Click flies the camera to the chokepoint bbox and sets the active AOI so
// downstream filters (dark-vessel candidates, etc.) scope to that region.
export function ChokepointsList({ viewer }: Props): JSX.Element {
  const active = useAoi((s) => s.active);
  const setActive = useAoi((s) => s.setActive);
  const reduced = useReducedMotion();

  return (
    <div className="px-3 py-2">
      <SectionLabel title="Chokepoints" count={`${chokepoints.length} saved`} />

      {active && (
        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-sm border border-accent-line bg-accent-dim px-2 py-1.5">
          <div className="min-w-0">
            <div className="mono text-[11px] text-txt-0 truncate" title={active.name}>
              {active.name}
            </div>
            <MicroLabel className="mt-0.5 block">active AOI</MicroLabel>
          </div>
          <Btn size="sm" onClick={() => setActive(null)} title="Clear active AOI">
            clear
          </Btn>
        </div>
      )}

      <ul className="mt-2.5">
        {chokepoints.map((c) => {
          const isActive = active?.id === c.id;
          return (
            <li key={c.id} className="border-b border-[rgba(255,255,255,0.035)] last:border-b-0">
              <button
                type="button"
                onClick={() => {
                  setActive(c);
                  if (viewer) flyToChokepoint(viewer, c, reduced ? 0 : 1.4);
                }}
                className={[
                  'w-full text-left border-l-2 pl-2 pr-1.5 py-[7px] transition-colors',
                  isActive
                    ? 'border-accent bg-accent-dim/60'
                    : 'border-transparent hover:border-accent-line hover:bg-bg-2',
                ].join(' ')}
                aria-pressed={isActive}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="mono text-[11.5px] text-txt-0 truncate" title={c.name}>
                    {c.name}
                  </span>
                  <Badge tone={isActive ? 'accent' : 'neutral'}>{CATEGORY_LABEL[c.category]}</Badge>
                </div>
                <div className="mono text-[10px] text-txt-3 truncate mt-0.5" title={c.region}>
                  {c.region}
                </div>
                <div
                  className="text-[10.5px] text-txt-2 leading-snug mt-1 line-clamp-2"
                  title={c.significance}
                >
                  {c.significance}
                </div>
                {(c.daily_transits != null || c.oil_flow_mbpd != null) && (
                  <KV className="mt-1.5">
                    {c.daily_transits != null && (
                      <KVRow k="transits/d" v={c.daily_transits} />
                    )}
                    {c.oil_flow_mbpd != null && (
                      <KVRow k="oil mbpd" v={c.oil_flow_mbpd} />
                    )}
                  </KV>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
