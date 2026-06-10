import type * as Cesium from 'cesium';
import { chokepoints, type Chokepoint } from '../registry/chokepoints.js';
import { flyToChokepoint } from '../globe/camera.js';
import { useAoi } from '../state/aoi.js';
import { useReducedMotion } from '../shell/useReducedMotion.js';

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
    <div className="p-3 space-y-3">
      <header className="flex items-baseline justify-between">
        <h2 className="micro">Chokepoints</h2>
        <span className="micro text-txt-3">{chokepoints.length} saved</span>
      </header>

      {active && (
        <div className="border border-accent-line/60 bg-accent-dim rounded-sm px-2 py-1.5 flex items-center justify-between">
          <div className="min-w-0">
            <div className="mono text-[11px] text-txt-0 truncate" title={active.name}>{active.name}</div>
            <div className="micro mt-0.5">active AOI</div>
          </div>
          <button
            type="button"
            onClick={() => setActive(null)}
            className="mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm text-txt-2 hover:border-alert/40 hover:text-alert"
            aria-label="Clear active AOI"
          >
            clear
          </button>
        </div>
      )}

      <ul className="space-y-1">
        {chokepoints.map((c) => {
          const isActive = active?.id === c.id;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  setActive(c);
                  if (viewer) flyToChokepoint(viewer, c, reduced ? 0 : 1.4);
                }}
                className={[
                  'w-full text-left border-l-2 pl-2 pr-1.5 py-1.5 hover:border-accent-line',
                  isActive ? 'border-accent bg-accent-dim/60' : 'border-line',
                ].join(' ')}
                aria-pressed={isActive}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="mono text-[12px] text-txt-0 truncate" title={c.name}>{c.name}</span>
                  <span className="micro text-txt-3 shrink-0">{CATEGORY_LABEL[c.category]}</span>
                </div>
                <div className="micro mt-0.5 normal-case tracking-normal text-txt-3 truncate" title={c.region}>{c.region}</div>
                <div className="text-[11px] text-txt-2 leading-snug mt-1 line-clamp-2" title={c.significance}>
                  {c.significance}
                </div>
                {(c.daily_transits != null || c.oil_flow_mbpd != null) && (
                  <div className="mt-1 flex gap-3">
                    {c.daily_transits != null && (
                      <span className="mono micro tabular-nums">
                        <span className="text-txt-3">transits/d </span>
                        <span className="text-txt-1">{c.daily_transits}</span>
                      </span>
                    )}
                    {c.oil_flow_mbpd != null && (
                      <span className="mono micro tabular-nums">
                        <span className="text-txt-3">oil mbpd </span>
                        <span className="text-txt-1">{c.oil_flow_mbpd}</span>
                      </span>
                    )}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
