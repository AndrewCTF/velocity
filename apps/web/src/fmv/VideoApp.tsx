import { useMemo } from 'react';
import * as Cesium from 'cesium';
import { TabbedPanel, type TabDef } from '../shell/TabbedPanel.js';
import { FmvPanel } from './FmvPanel.js';
import { GroundReconPanel } from '../ground/GroundReconPanel.js';
import { ImageryControl } from '../imagery/ImageryControl.js';

// Video app (design §6.1 / §8) — full-motion video + ground recon + detections.
// FMV (notional sensor) and street-level ground imagery share one surface.
//
// Imagery is here because `panels.ts` re-homes the old `imagery` rail item to
// this app ("imagery → the video app"). Nothing rendered it, so `byHome` dropped
// the satellite chip controls entirely: the Selection panel's "Imagery here"
// button set a chip focus with no surface left to steer it from.
export function VideoApp({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const tabs: TabDef[] = useMemo(
    () => [
      { id: 'fmv', label: 'FMV', content: <FmvPanel viewer={viewer} /> },
      { id: 'ground', label: 'Ground recon', content: <GroundReconPanel viewer={viewer} /> },
      { id: 'imagery', label: 'Imagery', content: <ImageryControl /> },
    ],
    [viewer],
  );
  return <TabbedPanel tabs={tabs} defaultTab="fmv" ariaLabel="Video" />;
}
