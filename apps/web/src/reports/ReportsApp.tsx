import { useMemo } from 'react';
import * as Cesium from 'cesium';
import { TabbedPanel, type TabDef } from '../shell/TabbedPanel.js';
import { SituationsPanel } from '../situations/SituationsPanel.js';
import { IntelPanel } from '../entity-panel/IntelPanel.js';
import { NewsPanel } from '../news-panel/NewsPanel.js';
import { CollabPanel } from '../collab/CollabPanel.js';
import { MetricsPanel } from '../metrics/MetricsPanel.js';
import { BriefPanel } from './BriefPanel.js';

// Reports app (design §6.1) — the reporting/analysis surfaces that used to be
// crammed into the right-rail tab pile: case files (Situations), cross-domain
// intel briefs, war-filtered news, and collaborative notes.
export function ReportsApp({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const tabs: TabDef[] = useMemo(
    () => [
      { id: 'situations', label: 'Case files', content: <SituationsPanel viewer={viewer} /> },
      { id: 'brief', label: 'Brief', content: <BriefPanel /> },
      { id: 'intel', label: 'Intel brief', content: <IntelPanel viewer={viewer} /> },
      { id: 'metrics', label: 'Metrics', content: <MetricsPanel /> },
      { id: 'news', label: 'News', content: <NewsPanel /> },
      { id: 'collab', label: 'Collab', content: <CollabPanel /> },
    ],
    [viewer],
  );
  return <TabbedPanel tabs={tabs} defaultTab="situations" ariaLabel="Reports" />;
}
