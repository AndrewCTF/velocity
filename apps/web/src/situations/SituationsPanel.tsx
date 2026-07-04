import { useEffect } from 'react';
import type * as Cesium from 'cesium';
import { useSituations, type Severity } from './situationStore.js';
import { useSelection } from '../state/stores.js';
import { flyToPosition } from '../globe/camera.js';
import { CoordEntry } from '../globe/CoordEntry.js';
import { SectionLabel, Badge, Btn, MicroLabel, type BadgeTone } from '../shell/instruments.js';
import { ControlSection } from './ControlSection.js';

// Left-rail list of the analyst's Situations (Gotham case files). Click one to
// open its detail in the Selection tab (EntityPanel delegates on a situation: id)
// and fly to its AOI. "+ New" mints an empty situation centred on the globe view.

const SEV_TONE: Record<Severity, BadgeTone> = {
  critical: 'alert',
  high: 'warn',
  med: 'accent',
  low: 'neutral',
};

interface Props {
  viewer?: Cesium.Viewer | null;
}

export function SituationsPanel({ viewer }: Props = {}): JSX.Element {
  const situations = useSituations((s) => s.situations);
  const error = useSituations((s) => s.error);
  const create = useSituations((s) => s.create);
  const load = useSituations((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (id: string, lat?: number | null, lon?: number | null): void => {
    useSelection.getState().select(id);
    if (viewer && typeof lat === 'number' && typeof lon === 'number') {
      flyToPosition(viewer, lon, lat, 1_200_000, 1.0);
    }
  };

  const onNew = async (): Promise<void> => {
    const id = await create({ name: 'New situation' });
    open(id);
  };

  return (
    <div className="p-3 space-y-3">
      <ControlSection viewer={viewer ?? null} />
      <div className="flex items-center gap-2">
        <SectionLabel title="Situations" count={situations.length} className="flex-1" />
        <Btn tone="accent" size="sm" onClick={() => void onNew()}>
          + New
        </Btn>
      </div>
      <div className="space-y-1">
        <MicroLabel>or create at coordinates</MicroLabel>
        <CoordEntry
          viewer={viewer ?? null}
          onPlace={async (lat, lon, label) => {
            const id = await useSituations.getState().create({
              name: label ? `Situation — ${label}` : 'Situation',
              centroid: { lat, lon },
            });
            useSelection.getState().select(id);
          }}
        />
      </div>
      {error && <p className="text-[10px] text-warn">{error}</p>}
      {situations.length === 0 && (
        <p className="text-txt-3 text-[11px]">
          No situations yet. Create one here, right-click the map → "Create situation here", or
          promote an incident from the Intel tab.
        </p>
      )}
      <ul className="space-y-1.5">
        {situations.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => open(s.id, s.centroid?.lat, s.centroid?.lon)}
              className="w-full text-left rounded-sm border border-line bg-bg-1/70 hover:border-accent-line px-2.5 py-2 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Badge tone={SEV_TONE[s.severity]}>{s.severity}</Badge>
                <span className="text-[11px] text-txt-0 truncate flex-1">{s.name}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <MicroLabel>{s.status}</MicroLabel>
                {s.centroid && (
                  <span className="mono text-[10px] text-txt-3 tabular-nums">
                    {s.centroid.lat.toFixed(1)}, {s.centroid.lon.toFixed(1)}
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
