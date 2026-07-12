import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import * as Cesium from 'cesium';
import { useUiMode, type UiMode } from './state/uiMode.js';
import type { RuntimeConfig } from '@osint/shared';
import { ConsoleShell } from './shell/ConsoleShell.js';
import { type TabDef } from './shell/TabbedPanel.js';
import { LeftIconRail, type RailItem } from './shell/LeftIconRail.js';
import { AppSurface } from './shell/AppSurface.js';
import { useAppView, APP_META } from './state/appView.js';
import { useGeoScope } from './state/geoScope.js';
import { useDashboardMode } from './state/dashboardMode.js';
import { CommandBar } from './command-bar/CommandBar.js';
import {
  useImagery,
  useFeeds,
  useSelection,
  useFilters,
  useAlerts,
  type FilterClause,
} from './state/stores.js';
import { useInbox } from './state/inbox.js';
import { InboxPanel } from './inbox/InboxPanel.js';
import { startSavedSearchPoller } from './state/savedSearches.js';
import { LayerRail } from './layer-rail/LayerRail.js';
import { LayerCatalog } from './layer-rail/LayerCatalog.js';
import { OpsPanel } from './layer-rail/OpsPanel.js';
import { ImageryControl } from './imagery/ImageryControl.js';
import { ChokepointsList } from './layer-rail/ChokepointsList.js';
import { FeedsPanel } from './layer-rail/FeedsPanel.js';
import { AcarsPanel } from './acars/AcarsPanel.js';
import { EntityPanel } from './entity-panel/EntityPanel.js';
import { ObjectInspector } from './entity-panel/ObjectInspector.js';
import { IntelPanel } from './entity-panel/IntelPanel.js';
import { InvestigationCanvas } from './graph/InvestigationCanvas.js';
import { useInvestigation } from './graph/investigationStore.js';
import { ExtractPanel } from './extract/ExtractPanel.js';
import { CountriesPanel } from './osint/CountriesPanel.js';
import { CollabPanel } from './collab/CollabPanel.js';
import { HistogramPanel } from './explorer/HistogramPanel.js';
import { SearchObjectsSidebar } from './explorer/SearchObjectsSidebar.js';
import { NewsPanel } from './news-panel/NewsPanel.js';
import { TaskingPanel } from './tasking/TaskingPanel.js';
import { TargetKanbanPanel } from './target-kanban/TargetKanbanPanel.js';
import { FmvPanel } from './fmv/FmvPanel.js';
import { Timeline } from './timeline/Timeline.js';
import { GlobeCanvas } from './globe/GlobeCanvas.js';
import { GlobeOverlays } from './globe/GlobeOverlays.js';
import { GlobeToolbar } from './globe/GlobeToolbar.js';
import { GlobeTheater } from './globe/GlobeTheater.js';
import { AgentConsole } from './command-bar/AgentConsole.js';
import { LayerRegistry } from './registry/LayerRegistry.js';
import { registerDefaults } from './registry/defaults.js';
import { CopEditor } from './cop/CopEditor.js';
import { Omnibar } from './command-bar/Omnibar.js';
import { AnnotationPanel } from './annotations/AnnotationPanel.js';
import { WatchboxPanel } from './watchbox/WatchboxPanel.js';
import { SituationsPanel } from './situations/SituationsPanel.js';
import { ContextMenu } from './globe/ContextMenu.js';
import { ImageryDiffPopup } from './imagery/ImageryDiff.js';
import { GroundReconPanel } from './ground/GroundReconPanel.js';
import { FieldPanel } from './field/FieldPanel.js';
import { useGround } from './ground/groundStore.js';
import { fetchRuntimeConfig } from './transport/config.js';
import { AlertSubscriber } from './alerts/AlertSubscriber.js';
import { AlertsPanel } from './alerts/AlertsPanel.js';
import { AlertsRailList } from './alerts/AlertsRailList.js';
import { SimulationOverlay } from './sim/SimulationOverlay.js';
import { ErrorBoundary } from './shell/ErrorBoundary.js';
import { Link } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.js';
import { isSupabaseConfigured } from './transport/supabase.js';
import { apiFetch, backendWsUrl, withWsKey } from './transport/http.js';

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
  // "Search around" (EntityPanel → investigationStore) bumps openSeq to bring
  // the Investigation tab forward. TabbedPanel is uncontrolled, so we re-anchor
  // its default to 'investigation' and remount it (keyed on openSeq) when the
  // operator explicitly asks for the graph — a deliberate user action, not a
  // passing render. openSeq===0 (never asked) keeps the normal 'selection'
  // default and a stable key, so the rest of the rails behave exactly as before.
  const investigationOpenSeq = useInvestigation((s) => s.openSeq);
  // Right-click "Ground recon here" bumps groundOpenSeq to bring the Ground tab
  // forward, exactly like investigationOpenSeq does for Search-around.
  const groundOpenSeq = useGround((s) => s.openSeq);

  useEffect(() => {
    fetchRuntimeConfig()
      .then(setConfig)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Saved-search subscription poller (§6.5) — re-runs standing queries, posts to
  // the Inbox when new objects match. Idempotent; no-ops when no searches exist.
  useEffect(() => startSavedSearchPoller(), []);

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

  // View preset (design §6.0/§7): the single console shell renders for every mode;
  // 'professional' = Command (dense, layers open), 'normal' = Field (a lighter
  // landing — map foregrounded, flyout closed). Same components, different defaults.
  const fieldPreset = useDashboardMode((s) => s.mode) === 'normal';

  // Inbox unread badge (design §6.5) — non-archived, unread alerts.
  const alerts = useAlerts((s) => s.alerts);
  const inboxRead = useInbox((s) => s.read);
  const inboxArchived = useInbox((s) => s.archived);
  const inboxUnread = useMemo(
    () => alerts.filter((a) => !inboxArchived.has(a.id) && !inboxRead.has(a.id)).length,
    [alerts, inboxArchived, inboxRead],
  );

  // Cross-app focus (design §6.1 — apps share selection/context). "Search around"
  // (EntityPanel → investigationStore) brings the Graph app forward; "Ground recon
  // here" (right-click) brings the Video app forward — instead of re-keying a tab.
  const setApp = useAppView((s) => s.setApp);
  const activeApp = useAppView((s) => s.app);
  useEffect(() => {
    if (investigationOpenSeq > 0) setApp('graph');
  }, [investigationOpenSeq, setApp]);
  useEffect(() => {
    if (groundOpenSeq > 0) setApp('video');
  }, [groundOpenSeq, setApp]);
  // Geo search-around (§6.4): scoping objects near a map point brings Explorer up.
  const geoSeq = useGeoScope((s) => s.seq);
  useEffect(() => {
    if (geoSeq > 0) setApp('explorer');
  }, [geoSeq, setApp]);

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
      { id: 'acars', label: 'ACARS', content: <AcarsPanel /> },
      { id: 'annotate', label: 'Annotate', content: <AnnotationPanel /> },
      { id: 'extract', label: 'Extract', content: <ExtractPanel /> },
      { id: 'watch', label: 'Watch', content: <WatchboxPanel /> },
      { id: 'situations', label: 'Situations', content: <SituationsPanel viewer={viewer} /> },
    ],
    [registry, viewer],
  );

  // Left icon rail (design §6.1) — every left-rail surface is a visible icon with
  // a floating flyout, replacing the old hidden "Panel ▾" chooser. Primary group
  // = the day-to-day tools; the "more" group holds the deeper instruments.
  const railItems: RailItem[] = useMemo(
    () => [
      { id: 'layers', icon: 'layers', label: 'Layers', content: <LayerCatalog registry={registry} viewer={viewer} /> },
      { id: 'search-objects', icon: 'search', label: 'Search Objects', content: <SearchObjectsSidebar viewer={viewer} /> },
      { id: 'feeds', icon: 'feed', label: 'Feeds', content: <FeedsPanel /> },
      { id: 'ops', icon: 'gauge', label: 'Ops', content: <OpsPanel viewer={viewer} onOpenAlerts={() => setAlertsOpen(true)} /> },
      { id: 'watch', icon: 'crosshair', label: 'Watchboxes', content: <WatchboxPanel /> },
      { id: 'annotate', icon: 'pin', label: 'Annotate', content: <AnnotationPanel /> },
      { id: 'inbox', icon: 'bell', label: 'Inbox', content: <InboxPanel viewer={viewer} />, badge: inboxUnread },
      { id: 'imagery', icon: 'image', label: 'Imagery', content: <ImageryControl />, group: 'more' },
      { id: 'chokepoints', icon: 'route', label: 'Chokepoints', content: <ChokepointsList viewer={viewer} />, group: 'more' },
      { id: 'acars', icon: 'signal', label: 'ACARS', content: <AcarsPanel />, group: 'more' },
      { id: 'extract', icon: 'file', label: 'Extract', content: <ExtractPanel />, group: 'more' },
      { id: 'countries', icon: 'globe', label: 'Countries', content: <CountriesPanel />, group: 'more' },
      { id: 'allsources', icon: 'sliders', label: 'All sources', content: <LayerRail registry={registry} viewer={viewer} />, group: 'more' },
      { id: 'filters', icon: 'filter', label: 'Filters', content: <HistogramPanel viewer={viewer} />, group: 'more' },
      { id: 'field', icon: 'crosshair', label: 'Field', content: <FieldPanel viewer={viewer} />, group: 'more' },
      { id: 'tasking', icon: 'satellite', label: 'Sat tasking', content: <TaskingPanel viewer={viewer} />, group: 'more' },
      { id: 'cop', icon: 'target', label: 'COP editor', content: <CopEditor registry={registry} />, group: 'more' },
    ],
    [registry, viewer, inboxUnread],
  );

  // Right rail = CONTEXT only (what's selected / happening). Tasking, Targeting
  // and FMV are full WORKSPACES opened from the command bar (see ModeSurface),
  // not crammed peer tabs — fixes the 7-tab overflow + the cramped board.
  const rightTabs: TabDef[] = useMemo(
    () => [
      { id: 'selection', label: 'Selection', content: <EntityPanel viewer={viewer} /> },
      { id: 'investigation', label: 'Investigation', content: <InvestigationCanvas /> },
      { id: 'collab', label: 'Collab', content: <CollabPanel /> },
      { id: 'filters', label: 'Filters', content: <HistogramPanel viewer={viewer} /> },
      { id: 'alerts', label: 'Alerts', content: <AlertsRailList viewer={viewer} /> },
      { id: 'intel', label: 'Intel', content: <IntelPanel viewer={viewer} /> },
      { id: 'news', label: 'News', content: <NewsPanel /> },
      { id: 'ground', label: 'Ground', content: <GroundReconPanel viewer={viewer} /> },
      { id: 'field', label: 'Field', content: <FieldPanel viewer={viewer} /> },
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
        iconRail
        fullBleed={APP_META[activeApp].chrome === 'full'}
        mainOverlay={<AppSurface viewer={viewer} />}
        left={<LeftIconRail items={railItems} defaultOpen={fieldPreset ? null : 'layers'} ariaLabel="Map tools" />}
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
              <GlobeToolbar viewer={viewer} />
              <CopControl viewer={viewer} registry={registry} />
              <AuthNotice />
              <OpenModeBanner open={Boolean(config.openMode)} />
              <AgentConsole viewer={viewer} />
              <Omnibar viewer={viewer} registry={registry} />
              <ContextMenu />
              <ImageryDiffPopup />
              <ModeSurface viewer={viewer} registry={registry} />
            </>
          ) : (
            <BootLoading />
          )
        }
        // Right rail is now the single object-centric Inspector (design §6.3) —
        // the old 9-tab pile is redistributed: Investigation→Graph app, Intel/
        // News/Collab→Reports app, Ground→Video app, Filters/Field→rail flyouts,
        // Alerts→Inbox flyout. Selection context is shared across every app.
        right={<ObjectInspector viewer={viewer} />}
        rightTabs={rightTabs}
        bottom={<ErrorBoundary label="Timeline"><Timeline viewer={viewer} /></ErrorBoundary>}
      />
      <AlertsPanel open={alertsOpen} onClose={() => setAlertsOpen(false)} viewer={viewer} />
      <SimulationOverlay viewer={viewer} registry={registry} />
    </>
  );
}
// (Reset-to-top-down now lives in the right-side GlobeToolbar alongside the map
// tools, replacing the old standalone bottom-right GlobeControls button.)

// ── Shared named COP (common operational picture) — Track D2 ────────────────
// Save the current operational picture (camera viewport + enabled layers +
// imagery overlay + selection + faceted filters) as a named map, reload a saved
// one, and optionally JOIN a map's live room so this view follows whoever is
// driving (and broadcasts this camera when leading). Persistence is the
// /api/maps ontology-object store; the live follow-along is the /ws/cop delta
// channel. Both degrade to nothing when signed out / Supabase unset (the list
// just 401/503s and the control shows the reason on hover).

interface CopViewport {
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
}
interface CopImageryRef {
  provider: string;
  layer: string;
  date: string;
  maxZ: number;
  opacity: number;
}
interface CopState {
  viewport: CopViewport | null;
  layers: string[];
  imagery: CopImageryRef | null;
  selection: string | null;
  filters: FilterClause[];
}
interface SavedMap {
  id: string;
  name: string;
  state: CopState;
  updated_at?: string | null;
}

// Read the live camera pose into a serializable viewport. Cesium units are kept
// verbatim (degrees for lon/lat, metres for height, radians for the orientation)
// so a restore is a faithful `setView`.
function readViewport(viewer: Cesium.Viewer): CopViewport | null {
  const carto = viewer.camera.positionCartographic;
  if (!carto) return null;
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
    height: carto.height,
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
    roll: viewer.camera.roll,
  };
}

// Apply a viewport to the camera. `instant` (the follow path) sets the view with
// no slew so a follower tracks the lead frame-to-frame; a load uses a short fly.
function applyViewport(viewer: Cesium.Viewer, vp: CopViewport, instant: boolean): void {
  const destination = Cesium.Cartesian3.fromDegrees(vp.lon, vp.lat, vp.height);
  const orientation = { heading: vp.heading, pitch: vp.pitch, roll: vp.roll };
  if (instant) {
    viewer.camera.setView({ destination, orientation });
  } else {
    viewer.camera.flyTo({ destination, orientation, duration: 0.8 });
  }
}

export function CopControl({
  viewer,
  registry,
}: {
  viewer: Cesium.Viewer | null;
  registry: LayerRegistry;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [maps, setMaps] = useState<SavedMap[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [followingId, setFollowingId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Guards a brief window after we APPLY a follower delta so the resulting
  // camera.changed doesn't echo back out as our own (lead) delta.
  const applyingRef = useRef(false);

  // Pull store setters once (stable references) for restore.
  const setOverlay = useImagery((s) => s.setOverlay);
  const setOverlayOpacity = useImagery((s) => s.setOverlayOpacity);

  const refreshList = useCallback(async () => {
    try {
      const r = await apiFetch('/api/maps');
      if (!r.ok) {
        setStatus(r.status === 401 ? 'sign in to save maps' : r.status === 503 ? 'maps need Supabase' : `list failed (${r.status})`);
        setMaps([]);
        return;
      }
      setMaps((await r.json()) as SavedMap[]);
      setStatus(null);
    } catch {
      setStatus('list failed');
    }
  }, []);

  useEffect(() => {
    if (open) void refreshList();
  }, [open, refreshList]);

  // Tear the socket down on unmount.
  useEffect(() => () => wsRef.current?.close(), []);

  const serializeState = useCallback((): CopState => {
    const overlay = useImagery.getState().overlay;
    const overlayOpacity = useImagery.getState().overlayOpacity;
    return {
      viewport: viewer ? readViewport(viewer) : null,
      layers: registry.list().filter((l) => registry.isEnabled(l.id)).map((l) => l.id),
      imagery: overlay
        ? { provider: overlay.provider, layer: overlay.layer, date: overlay.date, maxZ: overlay.maxZ, opacity: overlayOpacity }
        : null,
      selection: useSelection.getState().selectedEntityId,
      filters: [...useFilters.getState().clauses],
    };
  }, [viewer, registry]);

  const restoreState = useCallback(
    (st: CopState) => {
      // Layers: enable the saved set, disable everything else — drives the
      // adapters via registry events (no removeAll; SVG icons + upsert intact).
      const want = new Set(st.layers);
      for (const l of registry.list()) {
        const on = registry.isEnabled(l.id);
        if (want.has(l.id) && !on) registry.enable(l.id);
        else if (!want.has(l.id) && on) registry.disable(l.id);
      }
      // Imagery overlay.
      setOverlay(st.imagery ? { provider: st.imagery.provider, layer: st.imagery.layer, date: st.imagery.date, maxZ: st.imagery.maxZ } : null);
      if (st.imagery) setOverlayOpacity(st.imagery.opacity);
      // Filters: clear then re-apply each saved clause (no bulk setter exists;
      // toggleClause is idempotent from an empty base).
      const filters = useFilters.getState();
      filters.clear();
      for (const c of st.filters) filters.toggleClause(c.facet, c.value, c.mode);
      // Selection.
      useSelection.getState().select(st.selection ?? null);
      // Camera last, so the view lands on the restored picture.
      if (viewer && st.viewport) applyViewport(viewer, st.viewport, false);
    },
    [registry, setOverlay, setOverlayOpacity, viewer],
  );

  const onSave = useCallback(async () => {
    const name = window.prompt('Save current view as map — name:');
    if (!name) return;
    try {
      const r = await apiFetch('/api/maps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, state: serializeState() }),
      });
      if (!r.ok) {
        setStatus(r.status === 401 ? 'sign in to save' : r.status === 503 ? 'maps need Supabase' : `save failed (${r.status})`);
        return;
      }
      setStatus('saved');
      await refreshList();
    } catch {
      setStatus('save failed');
    }
  }, [serializeState, refreshList]);

  const onLoad = useCallback(
    async (id: string) => {
      try {
        const r = await apiFetch(`/api/maps/${encodeURIComponent(id)}`);
        if (!r.ok) {
          setStatus(`load failed (${r.status})`);
          return;
        }
        restoreState(((await r.json()) as SavedMap).state);
        setStatus('loaded');
      } catch {
        setStatus('load failed');
      }
    },
    [restoreState],
  );

  // ── follow-along over /ws/cop ──────────────────────────────────────────────
  const stopFollow = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setFollowingId(null);
  }, []);

  const onDelete = useCallback(
    async (id: string) => {
      try {
        await apiFetch(`/api/maps/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (followingId === id) stopFollow();
        await refreshList();
      } catch {
        setStatus('delete failed');
      }
    },
    [followingId, refreshList, stopFollow],
  );

  const startFollow = useCallback(
    (id: string) => {
      if (!viewer) return;
      stopFollow();
      const ws = new WebSocket(withWsKey(`${wsBase()}/ws/cop?map=${encodeURIComponent(id)}`));
      wsRef.current = ws;
      setFollowingId(id);
      // Lead: broadcast this camera on move (debounced via Cesium's own change
      // event with a percentage threshold so we don't flood the room).
      const onCamChanged = () => {
        if (applyingRef.current || ws.readyState !== WebSocket.OPEN) return;
        const vp = readViewport(viewer);
        if (vp) ws.send(JSON.stringify({ kind: 'viewport', ...vp }));
      };
      viewer.camera.changed.addEventListener(onCamChanged);
      // Follower: apply incoming viewport deltas instantly (no slew).
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (msg?.kind === 'viewport' && viewer && !viewer.isDestroyed()) {
            applyingRef.current = true;
            applyViewport(viewer, msg as CopViewport, true);
            // Release the echo guard after the change settles.
            window.setTimeout(() => (applyingRef.current = false), 80);
          }
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        if (!viewer.isDestroyed()) viewer.camera.changed.removeEventListener(onCamChanged);
        if (wsRef.current === ws) {
          wsRef.current = null;
          setFollowingId(null);
        }
      };
    },
    [viewer, stopFollow],
  );

  if (!viewer) return null;

  return (
    <div className="absolute bottom-3 right-[112px] z-[var(--z-dock)] flex flex-col items-end gap-1.5">
      {open && (
        <div className="mono text-[10px] w-[212px] max-w-[92vw] border border-line rounded-sm bg-bg-1/95 text-txt-1 shadow-xl p-2 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-label uppercase tracking-[0.7px] text-txt-0 text-[10px]">Shared COP</span>
            <button type="button" className="text-txt-2 hover:text-txt-0 px-1" onClick={onSave} title="Save current view as a named map">
              + Save
            </button>
          </div>
          {status && <div className="text-txt-2 text-[10px]">{status}</div>}
          <div className="flex flex-col gap-0.5 max-h-[180px] overflow-auto">
            {maps.length === 0 && <div className="text-txt-2 text-[10px] py-1">no saved maps</div>}
            {maps.map((m) => (
              <div key={m.id} className="flex items-center gap-1 group">
                <button
                  type="button"
                  className="flex-1 text-left truncate px-1 py-0.5 rounded-sm hover:bg-bg-2 hover:text-accent"
                  onClick={() => void onLoad(m.id)}
                  title={`Load "${m.name}"`}
                >
                  {m.name}
                </button>
                <button
                  type="button"
                  className={`px-1 py-0.5 rounded-sm border ${followingId === m.id ? 'border-accent-line text-accent' : 'border-line-2 text-txt-2 hover:text-txt-0'}`}
                  onClick={() => (followingId === m.id ? stopFollow() : startFollow(m.id))}
                  title={followingId === m.id ? 'Stop following this map' : 'Follow this map live (your view tracks the lead)'}
                >
                  {followingId === m.id ? '◉ live' : 'follow'}
                </button>
                <button
                  type="button"
                  className="px-1 py-0.5 text-txt-2 hover:text-alert opacity-0 group-hover:opacity-100"
                  onClick={() => void onDelete(m.id)}
                  title={`Delete "${m.name}"`}
                  aria-label={`Delete ${m.name}`}
                >
                  <X size={12} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        title="Shared common operational picture — save / load / follow a named map"
        onClick={() => setOpen((v) => !v)}
        className={`mono text-[10px] px-2 py-1 border rounded-sm bg-bg-1/90 ${followingId ? 'border-accent-line text-accent' : 'border-line text-txt-1 hover:border-accent-line hover:text-accent'}`}
      >
        {followingId ? '◉ COP' : '⊞ COP'}
      </button>
    </div>
  );
}

// WS origin for the same host the page is served from (the API is reverse-proxied
// onto the same origin in every deployment), choosing ws/wss off the page scheme.
function wsBase(): string {
  return backendWsUrl('/').replace(/\/$/, '');
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

// Open-mode banner: shown when the backend is keyless AND ALLOW_UNAUTHENTICATED
// is on (the single-box docker default), so the compute/LLM endpoints are served
// to anyone. Dismissible per-browser — the point is a one-time "you're running
// open" heads-up, not a nag. An operator who wanted auth sets API_KEY/Supabase.
const OPEN_MODE_DISMISS_KEY = 'velocity.openModeDismissed';

export function OpenModeBanner({ open }: { open: boolean }): JSX.Element | null {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OPEN_MODE_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (!open || dismissed) return null;
  const close = (): void => {
    setDismissed(true);
    try {
      localStorage.setItem(OPEN_MODE_DISMISS_KEY, '1');
    } catch {
      /* storage disabled — banner just reappears next load */
    }
  };
  return (
    <div className="absolute inset-x-0 bottom-2 z-[var(--z-dock)] flex justify-center px-3 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-2 bg-bg-1/95 border border-warn rounded-sm px-3 py-1.5 shadow-lg max-w-xl">
        <span className="mono text-[10px] uppercase tracking-[0.6px] text-warn">Open mode</span>
        <span className="text-[11px] text-txt-2 leading-snug">
          Compute/LLM endpoints are served without authentication (keyless +
          ALLOW_UNAUTHENTICATED). Fine for a trusted local box; set API_KEY or Supabase
          before exposing it.
        </span>
        <button
          type="button"
          onClick={close}
          className="mono text-[10px] text-txt-3 hover:text-txt-0 px-1"
          aria-label="Dismiss open-mode banner"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export function AuthNotice(): JSX.Element | null {
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
      <div className="absolute top-10 right-3 z-[var(--z-dock)] flex justify-end pointer-events-none">
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
    <div className="absolute inset-x-0 top-10 z-[var(--z-dock)] flex justify-center px-3 pointer-events-none">
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

// Workspace overlay — renders the active command-bar MODE as a large surface
// over the globe (not a cramped rail tab). Targeting = full-width bottom dock
// (the F2T2EA board finally gets real width); Tasking = a tall left instrument
// dock; FMV = a centered sensor window. Closing returns to the live globe.
export function ModeSurface({ viewer, registry }: { viewer: Cesium.Viewer | null; registry: LayerRegistry }): JSX.Element | null {
  const mode = useUiMode((s) => s.mode);
  const setMode = useUiMode((s) => s.setMode);
  if (!mode) return null;
  // Workspaces dock to the RIGHT of the resizable left rail. `left` comes from the
  // live --rail-left-w var (published by ConsoleShell) + a 10px gap, so dragging
  // the rail no longer under-/over-laps the workspace (design §4 grammar #1). fmv
  // is centered and rail-independent.
  const railLeft = 'calc(var(--rail-left-w, 296px) + 10px)';
  const cfg: Record<
    NonNullable<UiMode>,
    { box: string; title: string; node: ReactNode; railDocked: boolean }
  > = {
    targeting: {
      box: 'right-3 top-12 bottom-0',
      title: 'Targeting · F2T2EA kill chain',
      node: <TargetKanbanPanel viewer={viewer} />,
      railDocked: true,
    },
    tasking: {
      box: 'top-12 bottom-3 w-[380px] max-w-[92vw]',
      title: 'Satellite Tasking',
      node: <TaskingPanel viewer={viewer} />,
      railDocked: true,
    },
    fmv: {
      box: 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] max-w-[94vw] h-[470px] max-h-[88vh]',
      title: 'FMV · Notional sensor',
      node: <FmvPanel viewer={viewer} />,
      railDocked: false,
    },
    cop: {
      box: 'top-12 bottom-3 w-[380px] max-w-[92vw]',
      title: 'COP Editor · MIL-STD-2525',
      node: <CopEditor registry={registry} />,
      railDocked: true,
    },
  };
  const c = cfg[mode];
  return (
    <div
      className={`absolute z-[var(--z-overlay)] flex flex-col border border-line-2 rounded-md shadow-2xl overflow-hidden ${c.box}`}
      style={{ background: 'rgba(9,12,18,0.97)', ...(c.railDocked && { left: railLeft }) }}
    >
      <div className="flex items-center justify-between px-3 h-9 flex-none border-b border-line-2 bg-bg-1">
        <span className="font-label text-[12px] tracking-[0.9px] uppercase text-txt-0">{c.title}</span>
        <button
          type="button"
          onClick={() => setMode(null)}
          className="mono text-[13px] leading-none text-txt-2 hover:text-txt-0 px-1 flex items-center"
          aria-label="Close workspace"
          title="Close"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">{c.node}</div>
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
