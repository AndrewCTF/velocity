import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as Cesium from 'cesium';
import type { RuntimeConfig } from '@osint/shared';
import { ConsoleShell } from './shell/ConsoleShell.js';
import { TabbedPanel, type TabDef } from './shell/TabbedPanel.js';
import { CommandBar } from './command-bar/CommandBar.js';
import { useImagery, useFeeds } from './state/stores.js';
import { LayerRail } from './layer-rail/LayerRail.js';
import { OpsPanel } from './layer-rail/OpsPanel.js';
import { ImageryControl } from './imagery/ImageryControl.js';
import { ChokepointsList } from './layer-rail/ChokepointsList.js';
import { FeedsPanel } from './layer-rail/FeedsPanel.js';
import { EntityPanel } from './entity-panel/EntityPanel.js';
import { IntelPanel } from './entity-panel/IntelPanel.js';
import { NewsPanel } from './news-panel/NewsPanel.js';
import { Timeline } from './timeline/Timeline.js';
import { GlobeCanvas } from './globe/GlobeCanvas.js';
import { GlobeOverlays } from './globe/GlobeOverlays.js';
import { GlobeTheater } from './globe/GlobeTheater.js';
import { AgentConsole } from './command-bar/AgentConsole.js';
import { LayerRegistry } from './registry/LayerRegistry.js';
import { registerDefaults } from './registry/defaults.js';
import { fetchRuntimeConfig } from './transport/config.js';
import { AlertSubscriber } from './alerts/AlertSubscriber.js';
import { AlertsPanel } from './alerts/AlertsPanel.js';
import { AlertsRailList } from './alerts/AlertsRailList.js';
import { SimulationOverlay } from './sim/SimulationOverlay.js';
import { ErrorBoundary } from './shell/ErrorBoundary.js';
import { Link } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.js';
import { isSupabaseConfigured } from './transport/supabase.js';
import { resetToTopDown } from './globe/camera.js';

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

  // DEV-only registry handle for debugging/introspection (mirrors __useSelection).
  useEffect(() => {
    if (import.meta.env?.DEV) (window as unknown as { __registry: LayerRegistry }).__registry = registry;
  }, [registry]);

  const leftTabs: TabDef[] = useMemo(
    () => [
      {
        id: 'ops',
        label: 'Ops',
        content: <OpsPanel viewer={viewer} onOpenAlerts={() => setAlertsOpen(true)} />,
      },
      { id: 'layers', label: 'Layers', content: <LayerRail registry={registry} viewer={viewer} /> },
      { id: 'imagery', label: 'Imagery', content: <ImageryControl /> },
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
        left={<TabbedPanel tabs={leftTabs} defaultTab="ops" ariaLabel="Left rail tabs" />}
        leftTabs={leftTabs}
        globe={
          error ? (
            <BootError message={error} />
          ) : config ? (
            <>
              <ErrorBoundary label="globe">
                <GlobeCanvas
                  ionToken={config.cesiumIonToken}
                  registry={registry}
                  onViewerReady={onViewerReady}
                  imageryMode={imageryMode}
                  enableGoogle3D={config.features.enableGoogle3D}
                  googleApiKey={config.googleApiKey}
                />
              </ErrorBoundary>
              {/* Instrument overlays + resting command dock float over the globe.
                  Both are null/viewer-safe and pointer-scoped so they never
                  block globe interaction. */}
              <GlobeTheater viewer={viewer} />
              <GlobeOverlays viewer={viewer} />
              <GlobeControls viewer={viewer} />
              <AuthNotice />
              <AgentConsole viewer={viewer} />
            </>
          ) : (
            <BootLoading />
          )
        }
        right={<TabbedPanel tabs={rightTabs} defaultTab="selection" ariaLabel="Right rail tabs" />}
        rightTabs={rightTabs}
        bottom={<ErrorBoundary label="Timeline"><Timeline viewer={viewer} /></ErrorBoundary>}
      />
      <AlertsPanel open={alertsOpen} onClose={() => setAlertsOpen(false)} viewer={viewer} />
      <SimulationOverlay viewer={viewer} registry={registry} />
    </>
  );
}

// Floating globe controls. A reset-to-top-down button (removes camera tilt /
// "side view" without losing the analyst's location) — the most-requested
// orientation control.
function GlobeControls({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element | null {
  if (!viewer) return null;
  return (
    <div className="absolute bottom-3 right-3 z-[1200] flex flex-col gap-1.5">
      <button
        type="button"
        title="Reset to top-down (nadir) view"
        onClick={() => resetToTopDown(viewer)}
        className="mono text-[10px] px-2 py-1 border border-line rounded-sm bg-bg-1/90 text-txt-1 hover:border-accent-line hover:text-accent"
      >
        ⊕ Top-down
      </button>
    </div>
  );
}

// "You're not signed in" affordance. On the hosted backend every data endpoint
// is auth-gated, so a logged-out visitor sees an empty globe and assumes it's
// broken — there we show the prominent "globe stays blank" overlay. But in
// keyless local mode the same logged-out visitor gets a fully-populated globe
// (ADS-B / AIS / quakes flow without an account), so that copy would be a lie.
// We distinguish the two by reading the live feeds: if any feed has delivered
// data recently, data IS present and we drop to a subtle sign-in chip instead
// of claiming the globe is blank. Only renders when auth is configured AND the
// first session check has resolved to "no user".
const FEED_FRESH_MS = 60_000;

function AuthNotice(): JSX.Element | null {
  const { user, loading } = useAuth();
  const feeds = useFeeds((s) => s.feeds);
  if (loading || user || !isSupabaseConfigured) return null;

  // Live data IS present when at least one feed has reported a recent fix.
  const now = Date.now();
  const hasLiveData = Object.values(feeds).some(
    (f) => f.status === 'green' && f.lastSeen !== undefined && now - f.lastSeen < FEED_FRESH_MS,
  );

  // Data is flowing — don't claim the globe is blank. Keep a subtle sign-in
  // chip so the affordance is still there without the misleading copy.
  if (hasLiveData) {
    return (
      <div className="absolute top-10 right-3 z-[1500] flex justify-end pointer-events-none">
        <Link
          to="/login"
          className="pointer-events-auto bg-bg-1/90 border border-accent-line rounded-sm px-2.5 py-1 text-[11px] font-medium text-accent shadow-lg hover:text-txt-0 hover:border-accent"
        >
          Sign in →
        </Link>
      </div>
    );
  }

  // No data reached the globe yet — the auth-gated hosted case. Make the real
  // reason explicit with a one-click path to sign in.
  return (
    <div className="absolute inset-x-0 top-10 z-[1500] flex justify-center px-3 pointer-events-none">
      <div className="pointer-events-auto bg-bg-1/95 border border-accent-line rounded-md px-4 py-3 shadow-xl max-w-sm text-center">
        <p className="text-txt-0 text-[13px] font-semibold">Sign in to load live data</p>
        <p className="text-txt-2 text-[11px] mt-1 leading-snug">
          Live aircraft, vessels &amp; intel need an account — the globe stays blank until you sign
          in.
        </p>
        <Link
          to="/login"
          className="inline-block mt-2.5 px-3 py-1 rounded-sm text-[12px] font-medium"
          style={{ background: 'var(--accent)', color: '#06121a' }}
        >
          Sign in →
        </Link>
      </div>
    </div>
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
