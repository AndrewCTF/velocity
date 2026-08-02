import type * as Cesium from 'cesium';
import type { IconName } from '../../normal/Icon.js';
import { FloatingPanel } from '../FloatingPanel.js';
import { useFloatingPanels } from '../../state/floatingPanels.js';
import { AnnotationPanel } from '../../annotations/AnnotationPanel.js';
import { WatchboxPanel } from '../../watchbox/WatchboxPanel.js';
import { FieldPanel } from '../../field/FieldPanel.js';

// The three surfaces `panels.ts` re-homed as MAP TOOLS rather than panels:
// `annotate`, `watch` and `field`. The rebuild recorded the decision and then
// rendered nothing, because `byHome` only keeps `kind: 'panel'` entries and
// `LeftIconRail` — the one place the floating-panel system was mounted — is not
// part of the new Console. So the annotation draft editor, the watchbox rules
// and the field kit were all constructed in `App.tsx` and dropped on the floor.
//
// A tool that draws on the map still needs somewhere to say WHAT it is drawing:
// GlobeToolbar arms the annotate tool and its own comment says it reads
// "whatever kind/colour/label the operator picked in the Annotate panel", a
// panel that had no way to be opened. These float over the map, which is what a
// tool's settings should do, and they are opened from the toolbar.

export const MAP_TOOL_PANELS: ReadonlyArray<{ id: string; label: string; icon: IconName }> = [
  { id: 'annotate', label: 'Annotations', icon: 'pin' },
  { id: 'watch', label: 'Watchboxes', icon: 'crosshair' },
  { id: 'field', label: 'Field kit', icon: 'compass' },
];

/** Open (or focus) one of the map-tool panels. */
export function openMapToolPanel(id: string): void {
  useFloatingPanels.getState().detach(id);
}

export function MapToolPanels({ viewer }: { viewer?: Cesium.Viewer | null }): JSX.Element | null {
  const open = useFloatingPanels((s) => s.panels);
  const redock = useFloatingPanels((s) => s.redock);
  const shown = MAP_TOOL_PANELS.filter((p) => open[p.id]);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((p) => (
        <FloatingPanel key={p.id} id={p.id} title={p.label} icon={p.icon} onClose={() => redock(p.id)}>
          {p.id === 'annotate' && <AnnotationPanel />}
          {p.id === 'watch' && <WatchboxPanel />}
          {p.id === 'field' && <FieldPanel viewer={viewer ?? null} />}
        </FloatingPanel>
      ))}
    </>
  );
}
