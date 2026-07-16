import { useEffect, useState } from 'react';
import type * as Cesium from 'cesium';
import { useAlerts, useImagery, useSim } from '../state/stores.js';
import type { ImageryMode } from '../state/stores.js';
import { useAoi } from '../state/aoi.js';
import { AppSwitcher } from '../shell/AppSwitcher.js';
import { AoiSelector } from './AoiSelector.js';
import { SearchField } from './SearchField.js';
import { flyToChokepoint, flyToGlobal } from '../globe/camera.js';
import { perfSnapshot } from '../globe/perf.js';
import type { Chokepoint } from '../registry/chokepoints.js';
import { Brand, StatusDot, Caveat } from '../shell/instruments.js';
import { useAgent } from '../state/agent.js';
import { apiFetch } from '../transport/http.js';

interface Props {
  viewer: Cesium.Viewer | null;
  classification?: string;
  /**
   * Cesium ion token from runtime config. No longer gates the 3D-sat
   * toggle — the sat/terrain stack is keyless; the token only adds the
   * optional OSM Buildings layer.
   */
  ionToken?: string;
  onOpenAlerts?: () => void;
}

// Each top-level cell: full height, hairline right divider, tight padding.
// px-1 (not px-2/px-3) so the full control row fits 1280px laptops without the
// bar overflowing → no horizontal scrollbar on the top nav. Measured live at 1280:
// px-2 → 41px over; px-1.5 → 14px over; px-1 (+ the SysStats trim below) → fits
// with ~26px margin. Keep it tight if you add a cell.
const CELL = 'h-full flex items-center gap-2 px-1 border-r border-line';

export function CommandBar({
  viewer,
  classification = 'UNCLAS',
  onOpenAlerts,
}: Props): JSX.Element {
  const setActiveAoi = useAoi((s) => s.setActive);
  const imageryMode = useImagery((s) => s.mode);
  const setImageryMode = useImagery((s) => s.setMode);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const onPickAoi = (c: Chokepoint | null) => {
    setActiveAoi(c);
    if (!viewer) return;
    if (c) flyToChokepoint(viewer, c);
    else flyToGlobal(viewer);
  };

  return (
    <div className="flex h-full items-stretch">
      {/* brand mark */}
      <div className={CELL}>
        <Brand name="VELOCITY" version="v1.0.0" />
      </div>

      {/* unified search */}
      <div className={CELL}>
        <SearchField viewer={viewer} />
      </div>

      {/* area-of-interest selector */}
      <div className={CELL}>
        <AoiSelector onPick={onPickAoi} />
      </div>

      {/* Basemap picker. '2d-dark' and '3d-sat' are keyless proxied stacks
          (ion token only adds OSM Buildings on top of 3d-sat); the rest are
          third-party imagery/topo basemaps streamed direct from the browser. */}
      <div className={CELL}>
        <BasemapPicker mode={imageryMode} onChange={setImageryMode} />
      </div>

      {/* simulation mode toggle — browser-side war-game overlay */}
      <div className={CELL}>
        <SimToggle />
      </div>

      {/* App switcher (design §6.1) — the primary top-level navigation. Map is the
          globe; Explorer/Graph/Targeting/Video/Sim/Reports take the main surface. */}
      <div className="h-full flex items-stretch border-l border-line-2">
        <AppSwitcher />
      </div>

      {/* alert ticker — top alert in newest-first buffer; click opens panel.
          flex-1 so it spans the gap between the controls and the right cluster. */}
      <div className={`${CELL} flex-1 min-w-0`}>
        <AlertTicker {...(onOpenAlerts ? { onOpen: onOpenAlerts } : {})} />
      </div>

      {/* AGENT indicator — opens the analyst console; shows the live cross-domain
          incident count from the real /api/intel/brief fusion. */}
      <div className={CELL}>
        <AgentIndicator />
      </div>

      {/* UTC clock — operator orientation */}
      <div className={CELL}>
        <span className="mono text-[11px] text-txt-2 tabular-nums" title="UTC">
          {now.toISOString().slice(11, 19)}Z
        </span>
      </div>

      {/* data-posture caveat — classification marking + the live data posture.
          When SIM mode is on the globe mixes in notional contacts, so the strip
          flips to a SIMULATED warning; otherwise it marks the keyless open-source
          feed posture. Reads only client-observable state (no fabricated tier). */}
      <div className={CELL}>
        <PostureCaveat classification={classification} />
      </div>

      {/* system stats — live entity total (real, from the viewer) + UTC tick
          source FPS, both genuinely measured. Last cell: no right divider. */}
      <div className="h-full flex items-center gap-2 px-2">
        <SysStats viewer={viewer} />
      </div>
    </div>
  );
}

/**
 * Data-posture caveat strip. Replaces the bare classification pill with the
 * shared <Caveat/> primitive, surfacing not just the marking but the live data
 * posture. Both signals are client-observable — no fabricated commercial tier:
 *  - SIM active → the globe carries NOTIONAL sim contacts, so mark the whole
 *    picture "// SIMULATED" in warn tone with a "notional contacts" note.
 *  - SIM off    → live open-source feeds (ADS-B/AIS/quakes are keyless here),
 *    marked neutral with a "keyless OSINT" posture note.
 */
function PostureCaveat({ classification }: { classification: string }): JSX.Element {
  const simActive = useSim((s) => s.active);
  if (simActive) {
    return <Caveat level={`${classification} // SIMULATED`} note="notional contacts" tone="warn" />;
  }
  return <Caveat level={classification} note="keyless OSINT" tone="neutral" />;
}

/**
 * AGENT indicator — the entry point to the analyst console (the "AI bar").
 * Polls the real cross-domain incident brief (/api/intel/brief) for a live
 * convergence count + top threat level; clicking opens the console. No
 * fabricated state — when the brief is empty it reads "· quiet".
 */
function AgentIndicator(): JSX.Element {
  const setOpen = useAgent((s) => s.setOpen);
  const [count, setCount] = useState<number | null>(null);
  const [threat, setThreat] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await apiFetch('/api/intel/brief');
        if (!r.ok) return;
        const d = (await r.json()) as { incident_count?: number; top_threat_level?: string };
        if (!alive) return;
        setCount(d.incident_count ?? 0);
        setThreat(d.top_threat_level ?? null);
      } catch {
        /* leave last-known; never fabricate */
      }
    };
    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const dotTone = threat === 'high' ? 'red' : threat === 'elevated' ? 'amber' : 'ok';
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title="Open the Velocity analyst console (⌘J)"
      aria-label="Open analyst console"
      className="flex items-center gap-2 mono text-[10px] tracking-[0.5px] text-accent hover:text-txt-0"
    >
      <StatusDot tone={dotTone} />
      <span>AGENT ▸</span>
      {count === null ? (
        <span className="text-txt-3">…</span>
      ) : count > 0 ? (
        <span className="text-txt-1">
          <b className="font-medium">{count}</b> incidents · brief ready
        </span>
      ) : (
        <span className="text-txt-3">· quiet</span>
      )}
    </button>
  );
}

/**
 * Live readouts measured straight from the running viewer:
 *  - ent: sum of entities across every attached data source, polled ~1 s.
 *  - fps: render rate from requestAnimationFrame deltas (EMA over ~1 s).
 * If the viewer is null (tests, pre-mount) the entity count is omitted and
 * the FPS loop never starts — nothing is fabricated.
 */
function SysStats({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element | null {
  const [entCount, setEntCount] = useState<number | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  // Governor/drain readout straight from window.__perf (§5.7). rr = real renders/s
  // (distinct from fps rAF frames), dr = last push-application ms.
  const [perf, setPerf] = useState<{ rr: number; dr: number } | null>(null);

  // Entity total — recomputed once a second from the live data sources.
  useEffect(() => {
    if (!viewer) {
      setEntCount(null);
      setPerf(null);
      return;
    }
    const recount = (): void => {
      // A destroyed viewer (HMR teardown / globe ErrorBoundary) is non-null but
      // `.dataSources` throws — skip the tick rather than crash the command bar.
      if (viewer.isDestroyed()) return;
      let total = 0;
      for (let i = 0; i < viewer.dataSources.length; i++) {
        total += viewer.dataSources.get(i).entities.values.length;
      }
      setEntCount(total);
      const p = perfSnapshot();
      setPerf({ rr: p.rendersPerSec, dr: p.drainMsLast });
    };
    recount();
    const t = window.setInterval(recount, 1000);
    return () => window.clearInterval(t);
  }, [viewer]);

  // FPS — measured from rAF frame deltas, surfaced once a second so the
  // number is stable. Only runs when a viewer is mounted (i.e. the globe
  // is actually rendering); no viewer → no readout rather than a fake one.
  useEffect(() => {
    if (!viewer) {
      setFps(null);
      return;
    }
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let acc = 0;
    const tick = (t: number): void => {
      const dt = t - last;
      last = t;
      frames += 1;
      acc += dt;
      if (acc >= 1000) {
        setFps(Math.round((frames * 1000) / acc));
        frames = 0;
        acc = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewer]);

  if (entCount === null && fps === null) return null;

  return (
    <span className="mono text-[10px] tracking-[0.4px] uppercase text-txt-3 flex items-center gap-3 tabular-nums">
      {entCount !== null && (
        <span title="Total entities across all globe data sources">
          ent <b className="text-txt-1 font-semibold">{entCount.toLocaleString()}</b>
        </span>
      )}
      {fps !== null && (
        <span title="Render rate (measured from animation-frame deltas)">
          <b className="text-txt-1 font-semibold">{fps}</b>fps
        </span>
      )}
      {perf !== null && perf.rr > 0 && (
        <span title="Real Cesium scene renders per second (governor metric)">
          <b className="text-txt-1 font-semibold">{perf.rr}</b>rr
        </span>
      )}
      {perf !== null && perf.dr > 0 && (
        <span title="Last aircraft push-application (drain) cost, ms">
          <b className="text-txt-1 font-semibold">{perf.dr}</b>ms
        </span>
      )}
    </span>
  );
}

// "low" severity uses --sev-low (≡ txt-1) so it doesn't collide with the
// teal selection accent. See tokens.css.
const SEV_COLOR: Record<string, string> = {
  info: 'text-txt-2',
  low: 'text-[var(--sev-low)]',
  medium: 'text-warn',
  high: 'text-alert',
  critical: 'text-alert',
};

// Basemap picker options, in display order. Attribution strings double as
// the option tooltip — Esri/OpenTopoMap/USGS/EOX all require it per their
// ToS. The Cesium credit container itself stays off (dark-chrome invariant,
// GlobeCanvas.tsx) so this tooltip is the attribution surface for now; a
// future pass can also surface it in a persistent footer.
const BASEMAP_OPTIONS: Array<{ value: ImageryMode; label: string; title: string }> = [
  { value: '2d-dark', label: '2D dark', title: 'Dark Matter basemap (Carto, proxied, keyless)' },
  {
    value: '3d-sat',
    label: '3D sat',
    title: 'Keyless satellite imagery + 3D terrain (ion token adds OSM Buildings)',
  },
  {
    value: 'esri-imagery',
    label: 'Esri imagery',
    title: 'Esri World Imagery · Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  { value: 'esri-topo', label: 'Esri topo', title: 'Esri World Topographic Map · Esri, HERE, Garmin, FAO, NOAA, USGS' },
  { value: 'esri-dark', label: 'Esri dark', title: 'Esri Dark Gray Canvas · Esri' },
  {
    value: 'opentopo',
    label: 'OpenTopo',
    title: 'OpenTopoMap · Map data (c) OpenStreetMap contributors, SRTM | Map style (c) OpenTopoMap (CC-BY-SA)',
  },
  { value: 'usgs-imagery', label: 'USGS imagery', title: 'USGS Imagery Only · USGS The National Map (public domain)' },
  {
    value: 'eox-s2',
    label: 'EOX S2',
    title: 'Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data)',
  },
];

/**
 * Compact mono basemap picker. Replaces the old binary 3D-sat toggle with a
 * dropdown covering the two proxied/keyless stacks plus six direct
 * third-party basemaps (docs/places-airspace-plan.md §6). Always enabled —
 * an ion token only adds OSM Buildings on top of 3d-sat.
 */
function BasemapPicker({
  mode,
  onChange,
}: {
  mode: ImageryMode;
  onChange: (m: ImageryMode) => void;
}): JSX.Element {
  // BASEMAP_OPTIONS is a non-empty literal array, so the fallback is always defined.
  const current = BASEMAP_OPTIONS.find((o) => o.value === mode) ?? BASEMAP_OPTIONS[0]!;
  return (
    <select
      value={mode}
      onChange={(e) => onChange(e.target.value as ImageryMode)}
      title={current.title}
      aria-label="Basemap"
      data-testid="basemap-picker"
      className="mono text-[10px] tracking-[0.6px] uppercase bg-transparent border border-line rounded-sm px-1.5 py-1 text-txt-2 hover:border-accent-line hover:text-txt-1 focus:outline-none focus:border-accent-line cursor-pointer"
    >
      {BASEMAP_OPTIONS.map((o) => (
        <option key={o.value} value={o.value} title={o.title}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Workspace mode switches — Tasking / Targeting / FMV. Each opens a large
 * surface over the globe (bottom dock / left dock / centered sensor window) via
 * the useUiMode store; clicking the active one closes it. Condensed-label voice.
 */
/**
 * SIM mode pill — toggles the browser-side war-game overlay. When on, the
 * SimulationOverlay mounts and the live ADS-B/AIS layers dim so scenario
 * contacts stand out.
 */
function SimToggle(): JSX.Element {
  const active = useSim((s) => s.active);
  const toggle = useSim((s) => s.toggle);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={active}
      title="Toggle browser-side simulation mode (drones, attack scenarios)"
      data-testid="sim-toggle"
      className={[
        'mono text-[10px] tracking-[0.6px] uppercase px-2 py-1 border rounded-sm transition-colors whitespace-nowrap',
        active
          ? 'border-mag-line text-mag bg-mag-dim'
          : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1',
      ].join(' ')}
    >
      <span aria-hidden="true" className="mr-1">
        {active ? '◉' : '◎'}
      </span>
      SIM
    </button>
  );
}

/**
 * Mockup .ticker: a 2px alert bar on the left edge, mono throughout. When an
 * alert is live the key "ALERT" reads in alert-red and the message in the soft
 * tint #ffc9c5; when the buffer is empty it shows "— quiet". Wiring unchanged:
 * click (or press A) opens the alerts panel.
 */
function AlertTicker({ onOpen }: { onOpen?: () => void }): JSX.Element {
  const alerts = useAlerts((s) => s.alerts);
  const total = alerts.length;
  const top = alerts[0];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative w-full flex items-center gap-2 truncate text-left pl-3 focus:outline-none group"
      aria-live="polite"
      aria-label={total > 0 ? `Open alerts panel (${total} alerts)` : 'Open alerts panel'}
      title="Open alerts panel (press A)"
    >
      <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-alert" aria-hidden="true" />
      {top ? (
        <>
          <span className="mono text-[10px] tracking-[0.7px] uppercase text-alert shrink-0 group-hover:text-accent transition-colors">
            alert
          </span>
          <span className="mono text-[10px] text-txt-4 tabular-nums shrink-0">{total}</span>
          <span className={`mono text-[11px] truncate ${SEV_COLOR[top.severity] ?? 'text-alert-fg'}`}>
            [{top.severity}] {top.message}
          </span>
        </>
      ) : (
        <span className="mono text-[11px] text-txt-3 group-hover:text-accent transition-colors">— quiet</span>
      )}
    </button>
  );
}
