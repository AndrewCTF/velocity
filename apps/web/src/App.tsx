import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as Cesium from 'cesium';
import type { RuntimeConfig } from '@osint/shared';
import { ConsoleShell } from './shell/ConsoleShell.js';
import { TabbedPanel, type TabDef } from './shell/TabbedPanel.js';
import { CommandBar } from './command-bar/CommandBar.js';
import { useImagery } from './state/stores.js';
import { LayerRail } from './layer-rail/LayerRail.js';
import { ChokepointsList } from './layer-rail/ChokepointsList.js';
import { FeedsPanel } from './layer-rail/FeedsPanel.js';
import { EntityPanel } from './entity-panel/EntityPanel.js';
import { IntelPanel } from './entity-panel/IntelPanel.js';
import { NewsPanel } from './news-panel/NewsPanel.js';
import { Timeline } from './timeline/Timeline.js';
import { GlobeCanvas } from './globe/GlobeCanvas.js';
import { LayerRegistry } from './registry/LayerRegistry.js';
import { registerDefaults } from './registry/defaults.js';
import { fetchRuntimeConfig } from './transport/config.js';
import { AlertSubscriber } from './alerts/AlertSubscriber.js';
import { AlertsPanel } from './alerts/AlertsPanel.js';
import { AlertsRailList } from './alerts/AlertsRailList.js';
import { Attribution } from './shell/Attribution.js';

export function App(): JSX.Element {
  const registry = useMemo(() => {
    const r = new LayerRegistry();
    registerDefaults(r);
    return r;
  }, []);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const imageryMode = useImagery((s) => s.mode);

  useEffect(() => {
    fetchRuntimeConfig()
      .then(setConfig)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Global keyboard shortcut: `a` toggles the Alerts panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'a' || e.key === 'A') setAlertsOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onViewerReady = useCallback((v: Cesium.Viewer | null) => setViewer(v), []);

  const leftTabs: TabDef[] = useMemo(
    () => [
      { id: 'layers', label: 'Layers', content: <LayerRail registry={registry} viewer={viewer} /> },
      { id: 'chokepoints', label: 'Chokepoints', content: <ChokepointsList viewer={viewer} /> },
      { id: 'feeds', label: 'Feeds', content: <FeedsPanel /> },
    ],
    [registry, viewer],
  );

  const rightTabs: TabDef[] = useMemo(
    () => [
      { id: 'selection', label: 'Selection', content: <EntityPanel viewer={viewer} /> },
      { id: 'alerts', label: 'Alerts', content: <AlertsRailList viewer={viewer} /> },
      { id: 'intel', label: 'Intel', content: <IntelPanel viewer={viewer} /> },
      { id: 'news', label: 'News', content: <NewsPanel /> },
    ],
    [viewer],
  );

  return (
    <>
      <AlertSubscriber />
      <ConsoleShell
        top={
          <CommandBar
            viewer={viewer}
            classification={config?.classification ?? 'UNCLAS'}
            ionToken={config?.cesiumIonToken ?? ''}
            onOpenAlerts={() => setAlertsOpen(true)}
          />
        }
        left={<TabbedPanel tabs={leftTabs} defaultTab="layers" ariaLabel="Left rail tabs" />}
        globe={
          error ? (
            <BootError message={error} />
          ) : config ? (
            <GlobeCanvas
              ionToken={config.cesiumIonToken}
              registry={registry}
              onViewerReady={onViewerReady}
              imageryMode={imageryMode}
              enableGoogle3D={config.features.enableGoogle3D}
            />
          ) : (
            <BootLoading />
          )
        }
        right={<TabbedPanel tabs={rightTabs} defaultTab="selection" ariaLabel="Right rail tabs" />}
        bottom={<Timeline viewer={viewer} />}
      />
      <AlertsPanel open={alertsOpen} onClose={() => setAlertsOpen(false)} viewer={viewer} />
      <Attribution />
    </>
  );
}

function BootLoading(): JSX.Element {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <span className="micro">loading config…</span>
    </div>
  );
}

function BootError({ message }: { message: string }): JSX.Element {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="border border-alert/40 bg-alert-bg px-4 py-3 rounded-md">
        <div className="micro text-alert">config error</div>
        <div className="mono text-[11px] text-txt-1 mt-1">{message}</div>
      </div>
    </div>
  );
}
