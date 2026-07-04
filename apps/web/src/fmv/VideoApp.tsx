import { useMemo } from 'react';
import * as Cesium from 'cesium';
import { TabbedPanel, type TabDef } from '../shell/TabbedPanel.js';
import { FmvPanel } from './FmvPanel.js';
import { GroundReconPanel } from '../ground/GroundReconPanel.js';

// Video app (design §6.1 / §8) — full-motion video + ground recon + detections.
// FMV (notional sensor) and street-level ground imagery share one surface.
export function VideoApp({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const tabs: TabDef[] = useMemo(
    () => [
      { id: 'fmv', label: 'FMV', content: <FmvPanel viewer={viewer} /> },
      { id: 'ground', label: 'Ground recon', content: <GroundReconPanel viewer={viewer} /> },
    ],
    [viewer],
  );
  return <TabbedPanel tabs={tabs} defaultTab="fmv" ariaLabel="Video" />;
}
