import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical } from 'lucide-react';
import * as Cesium from 'cesium';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useSim, useAlerts } from '../state/stores.js';
import { Widget, Btn, SectionLabel, KV, KVRow, MicroLabel, Badge, Toggle } from '../shell/instruments.js';
import { SimController, type SimClock, type SimStats } from './SimController.js';
import type { Alert } from '@osint/shared';
import { buildPlan } from './engine.js';
import { CATALOG, getSystem, ATTACKER_CATEGORIES, DEFENDER_CATEGORIES, type CatalogItem } from './catalog.js';
import { resolveRaid, salvoForDefender, RENDER_AGENT_CAP, type RaidResult } from './combat.js';
import { economicImpact, type EconImpact } from './economics.js';
import { reasonSim, type SimReasonResult } from './reason.js';
import { linkProfileFor } from './links.js';
import type { Jammer, JammerKind } from './ew.js';
import { apiFetch } from '../transport/http.js';
import { CoordEntry } from '../globe/CoordEntry.js';
import type { LatLon, Scenario, ScenarioKind } from './types.js';

// Control-link archetypes a swarm can use (attack derives link from the system).
const LINK_OPTIONS = [
  { key: 'fpv_rf', label: 'FPV · RF (jammable)' },
  { key: 'fpv_fiber', label: 'FPV · fiber (jam-proof, 20 km)' },
  { key: 'owa_ins', label: 'One-way · GPS/INS' },
  { key: 'loiter_rf', label: 'Loitering · RF + INS' },
  { key: 'male_satcom', label: 'MALE · satcom' },
];

// Live high-volume layers dimmed while a scenario plays so sim contacts read
// against (not lost in) the real picture. Restored on exit.
const DIM_LAYERS = ['aviation.adsb.global', 'maritime.digitraffic', 'maritime.aisstream', 'aviation.opensky.states'];

const KIND_LABELS: Record<ScenarioKind, string> = {
  'drone-swarm': 'Swarm',
  'drone-landing': 'Landing',
  attack: 'Attack',
};

function fmtPt(p: LatLon | null): string {
  return p ? `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}` : '— click map —';
}

// Parse the coordinate-entry inputs into a validated {lat, lon}. Accepts a
// pasted "lat, lon" pair in the LAT field (split on comma) so the operator can
// drop a Google-Maps-style string; otherwise reads the two fields separately.
// Returns null when either value is non-finite or out of geographic range.
export function parseLatLon(latStr: string, lonStr: string): LatLon | null {
  let latPart = latStr.trim();
  let lonPart = lonStr.trim();
  if (latPart.includes(',')) {
    const [a, b] = latPart.split(',');
    latPart = (a ?? '').trim();
    lonPart = (b ?? '').trim();
  }
  if (latPart === '' || lonPart === '') return null;
  const lat = Number(latPart);
  const lon = Number(lonPart);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}
function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function linkLabelFor(id: string): string {
  const s = getSystem(id);
  return s ? linkProfileFor(s.id, s.category).label : '—';
}

// De-silo: surface sim outcomes to the real Alerts rail. Aggregate-COALESCED
// (one alert per category, throttled) so a 200-drone raid never floods the rail
// with per-drone events. `center` (the strike point) gives the alert a geometry.
function pushSimAlerts(
  stats: SimStats | undefined,
  prevRef: { current: SimStats | null },
  lastRef: { current: Record<string, number> },
  center: LatLon | null,
): void {
  if (!stats) return;
  const prev = prevRef.current;
  prevRef.current = stats;
  if (!prev) return; // first sample establishes the baseline — no alert
  const now = Date.now();
  const geom: Alert['geom'] = {
    type: 'Point',
    coordinates: center ? [center.lon, center.lat] : [0, 0],
  };
  const fire = (key: keyof SimStats, label: string, severity: Alert['severity']): void => {
    if (stats[key] <= prev[key]) return;
    if (now - (lastRef.current[key] ?? 0) < 2500) return; // coalesce bursts
    lastRef.current[key] = now;
    useAlerts.getState().push({
      id: `sim:${key}:${now}`,
      ruleId: `sim_${key}`,
      severity,
      t: now,
      geom,
      confidence: 1,
      message: `Sim · ${stats[key]} ${label}`,
      contributingObservations: [],
    });
  };
  fire('struck', 'target(s) struck', 'high');
  fire('intercepted', 'intercepted by air defence', 'medium');
  fire('linkLost', 'lost EW / control link', 'medium');
}

export function SimulationOverlay({
  viewer,
  registry,
}: {
  viewer: Cesium.Viewer | null;
  registry: LayerRegistry;
}): JSX.Element | null {
  const active = useSim((s) => s.active);
  const setActive = useSim((s) => s.setActive);
  const ctrlRef = useRef<SimController | null>(null);
  const reasonAbort = useRef<AbortController | null>(null);
  // Sim→Alerts plumbing: previous stats snapshot + per-category throttle + the
  // strike point (kept in a ref so the update listener reads the latest value).
  const prevStatsRef = useRef<SimStats | null>(null);
  const lastAlertRef = useRef<Record<string, number>>({});
  const ptBRef = useRef<LatLon | null>(null);

  const attackerSystems = useMemo(() => CATALOG.filter((c) => ATTACKER_CATEGORIES.includes(c.category)), []);
  const defenderSystems = useMemo(() => CATALOG.filter((c) => DEFENDER_CATEGORIES.includes(c.category)), []);

  const [kind, setKind] = useState<ScenarioKind>('drone-swarm');
  const [ptA, setPtA] = useState<LatLon | null>(null);
  const [ptB, setPtB] = useState<LatLon | null>(null);
  ptBRef.current = ptB; // mirror for the (closure-captured) update listener
  const [count, setCount] = useState(12);
  const [speedKph, setSpeedKph] = useState(185);
  const [altM, setAltM] = useState(1500);
  const [spreadKm, setSpreadKm] = useState(8);
  const [attackerId, setAttackerId] = useState(attackerSystems[0]?.id ?? 'shahed-136');
  const [defenderId, setDefenderId] = useState(defenderSystems[0]?.id ?? 's-400');
  const [attackerCount, setAttackerCount] = useState(20);
  const [defenderCount, setDefenderCount] = useState(2);
  const [playSpeed, setPlaySpeed] = useState(20);
  const [linkKey, setLinkKey] = useState('fpv_rf');
  const [napOfEarth, setNapOfEarth] = useState(false);
  const [jammers, setJammers] = useState<Jammer[]>([]);
  const [jamRadiusKm, setJamRadiusKm] = useState(25);
  const [liveJamLoading, setLiveJamLoading] = useState(false);
  const [placing, setPlacing] = useState<'A' | 'B' | 'JAM' | null>(null);
  const [jamKind, setJamKind] = useState<JammerKind>('comms');
  const [clock, setClock] = useState<SimClock>({ simTime: 0, duration: 0, playing: false });
  const [raid, setRaid] = useState<RaidResult | null>(null);
  const [econ, setEcon] = useState<EconImpact | null>(null);
  const [reason, setReason] = useState<SimReasonResult | null>(null);
  const [reasonLoading, setReasonLoading] = useState(false);

  // Draggable position. Defaults clear of the top command bar (y≈76) and to the
  // RIGHT of the icon rail + an open left flyout (x≈360) so the controls never
  // sit on top of the left bar. Null until first drag → uses the default below.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const onDragDown = (e: ReactPointerEvent): void => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const startX = pos?.x ?? rect.left;
    const startY = pos?.y ?? rect.top;
    const px = e.clientX;
    const py = e.clientY;
    const move = (ev: PointerEvent): void => {
      const x = Math.max(4, Math.min(window.innerWidth - 80, startX + (ev.clientX - px)));
      const y = Math.max(72, Math.min(window.innerHeight - 40, startY + (ev.clientY - py)));
      setPos({ x, y });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    if (!active || !viewer || viewer.isDestroyed()) return;
    const ctrl = new SimController(viewer);
    ctrlRef.current = ctrl;
    prevStatsRef.current = null; // re-baseline the alert diff for this run
    ctrl.setUpdateListener((c) => {
      setClock(c);
      pushSimAlerts(c.stats, prevStatsRef, lastAlertRef, ptBRef.current);
    });
    const restore: Array<[string, number]> = [];
    for (const id of DIM_LAYERS) {
      const d = registry.get(id);
      if (d) {
        restore.push([id, d.opacity]);
        try {
          registry.setOpacity(id, 0.2);
        } catch {
          /* ignore */
        }
      }
    }
    return () => {
      reasonAbort.current?.abort();
      ctrl.setUpdateListener(null);
      ctrl.dispose();
      ctrlRef.current = null;
      for (const [id, op] of restore) {
        try {
          registry.setOpacity(id, op);
        } catch {
          /* ignore */
        }
      }
    };
  }, [active, viewer, registry]);

  if (!active) return null;

  const beginPlace = (which: 'A' | 'B') => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    setPlacing(which);
    ctrl.beginPlace((p) => {
      if (which === 'A') setPtA(p);
      else setPtB(p);
      setPlacing(null);
    });
  };

  // Drop a jammer at an EXPLICIT point. Both the typed CoordEntry and the
  // click-to-place path resolve to this, so a jammer object is built the same
  // way either way. Functional setState keeps the id/index correct under rapid
  // drops. No SimController involvement — the overlay owns the jammer list.
  const addJammerAt = (kind: JammerKind, lat: number, lon: number) => {
    setJammers((js) => [
      ...js,
      { id: `jam:${js.length}:${Math.round(lat * 100)}:${Math.round(lon * 100)}`, lat, lon, radiusKm: jamRadiusKm, kind },
    ]);
  };

  // Click-to-place a jammer: arm the one-shot globe pick, then drop via addJammerAt.
  const addJammer = (kind: JammerKind) => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    setPlacing('JAM');
    ctrl.beginPlace((p) => {
      addJammerAt(kind, p.lat, p.lon);
      setPlacing(null);
    });
  };

  const pullLiveJamming = async () => {
    setLiveJamLoading(true);
    try {
      const r = await apiFetch('/api/jamming/nacp');
      if (!r.ok) return;
      const j = (await r.json()) as { features?: Array<{ geometry?: { type?: string; coordinates?: unknown } }> };
      const next: Jammer[] = [];
      for (const f of (j.features ?? []).slice(0, 24)) {
        const g = f.geometry;
        let lat: number | undefined;
        let lon: number | undefined;
        if (g?.type === 'Point' && Array.isArray(g.coordinates)) {
          [lon, lat] = g.coordinates as [number, number];
        } else if (Array.isArray(g?.coordinates)) {
          const ring = (g!.coordinates as number[][][])[0];
          if (ring && ring.length) {
            let sx = 0;
            let sy = 0;
            for (const c of ring) {
              sx += c[0]!;
              sy += c[1]!;
            }
            lon = sx / ring.length;
            lat = sy / ring.length;
          }
        }
        if (lat != null && lon != null) next.push({ id: `live:${next.length}`, lat, lon, radiusKm: 45, kind: 'gnss' });
      }
      setJammers((js) => [...js, ...next]);
    } catch {
      /* ignore */
    } finally {
      setLiveJamLoading(false);
    }
  };

  const clearResults = () => {
    setRaid(null);
    setEcon(null);
    setReason(null);
    reasonAbort.current?.abort();
  };

  const build = () => {
    const ctrl = ctrlRef.current;
    if (!ctrl || !ptA || !ptB) return;

    if (kind === 'attack') {
      const scenario: Scenario = {
        kind,
        attack: { attackerId, attackerCount, defenderId, defenderCount, launch: ptA, target: ptB },
        jammers,
        napOfEarth,
      };
      ctrl.load(buildPlan(scenario));
      ctrl.setSpeed(playSpeed);
      ctrl.play();

      const atk = getSystem(attackerId);
      const def = getSystem(defenderId);
      const cover = napOfEarth ? 0.7 : 1;
      const raidRes = resolveRaid(
        attackerCount,
        atk?.specs.pk_est ?? 0.6,
        [{ id: defenderId, name: def?.name ?? defenderId, pk: def?.specs.pk_est ?? 0.6, count: defenderCount, salvoPerSite: salvoForDefender(defenderId) }],
        cover,
      );
      const econRes = economicImpact(ptB, raidRes.damageUnits);
      setRaid(raidRes);
      setEcon(econRes);

      reasonAbort.current?.abort();
      const ab = new AbortController();
      reasonAbort.current = ab;
      setReason(null);
      setReasonLoading(true);
      const payload = {
        kind: 'attack',
        attacker: { name: atk?.name, count: attackerCount, specs: atk?.specs },
        defender: { name: def?.name, count: defenderCount, specs: def?.specs },
        target: ptB,
        launch: ptA,
        ew: { jammers: jammers.length, kinds: [...new Set(jammers.map((j) => j.kind))] },
        terrain: { nap_of_earth: napOfEarth },
      };
      reasonSim(payload, { combat: raidRes, economics: econRes }, undefined, ab.signal)
        .then((r) => setReason(r))
        .catch(() => undefined)
        .finally(() => setReasonLoading(false));
      return;
    }

    clearResults();
    const scenario: Scenario =
      kind === 'drone-swarm'
        ? { kind, swarm: { launch: ptA, target: ptB, count, speedKph, altM, spreadKm, linkKey }, jammers, napOfEarth }
        : { kind: 'drone-landing', landing: { start: ptA, pad: ptB, startAltM: altM, speedKph } };
    ctrl.load(buildPlan(scenario));
    ctrl.setSpeed(playSpeed);
    ctrl.play();
  };

  const isSwarm = kind === 'drone-swarm';
  const isAttack = kind === 'attack';
  const labelA = isSwarm || isAttack ? 'Launch' : 'Approach';
  const labelB = isSwarm || isAttack ? 'Target' : 'Pad';
  const ready = ptA != null && ptB != null;

  return (
    <div
      className="absolute z-[var(--z-overlay)] w-[300px] max-h-[calc(100%-6rem)] overflow-y-auto pointer-events-auto rounded-md border border-line bg-bg-0/95 backdrop-blur-sm shadow-[0_8px_30px_-12px_rgba(0,0,0,0.85)]"
      style={pos ? { left: pos.x, top: pos.y } : { left: 360, top: 76 }}
    >
      {/* Drag handle — grab to reposition so the panel never has to sit on the
          left bar. */}
      <div
        onPointerDown={onDragDown}
        className="flex items-center gap-1.5 px-2 h-6 border-b border-line-2 bg-bg-1/80 cursor-grab active:cursor-grabbing select-none sticky top-0 z-10"
      >
        <GripVertical size={12} strokeWidth={1.75} className="text-txt-3" aria-hidden />
        <span className="font-label uppercase tracking-[0.9px] text-[10px] text-txt-2">Simulation controls</span>
      </div>
      <div className="space-y-2.5 p-2">
      <Widget
        title="Simulation"
        action={
          <button
            type="button"
            onClick={() => setActive(false)}
            className="mono text-[10px] text-txt-3 hover:text-alert px-1"
            title="Exit simulation mode"
          >
            ✕
          </button>
        }
      >
        <div className="flex gap-1.5 mb-2">
          {(Object.keys(KIND_LABELS) as ScenarioKind[]).map((k) => (
            <Btn
              key={k}
              size="sm"
              onClick={() => {
                setKind(k);
                clearResults();
              }}
              className={kind === k ? 'border-accent-line text-accent' : ''}
            >
              {KIND_LABELS[k]}
            </Btn>
          ))}
        </div>

        {/* Launch + Target each own an always-visible coordinate field: type
            "lat,lon" or a place / airport / port name, use the ⌖ map-centre
            button, or click the map. No arming step — one field per point. */}
        <div className="space-y-2.5">
          <div>
            <div className="flex items-baseline justify-between">
              <SectionLabel title={labelA} />
              <span className="mono text-[10px] text-txt-1 tabular-nums">{fmtPt(ptA)}</span>
            </div>
            <div className="mt-1">
              <CoordEntry viewer={viewer} onPlace={(lat, lon) => setPtA({ lat, lon })} placeholder="lat,lon or place" />
            </div>
            <button
              type="button"
              className={`mono text-[10px] mt-0.5 ${placing === 'A' ? 'text-accent' : 'text-txt-3'} hover:text-accent`}
              onClick={() => beginPlace('A')}
            >
              {placing === 'A' ? '… click map' : 'or click map'}
            </button>
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <SectionLabel title={labelB} />
              <span className="mono text-[10px] text-txt-1 tabular-nums">{fmtPt(ptB)}</span>
            </div>
            <div className="mt-1">
              <CoordEntry viewer={viewer} onPlace={(lat, lon) => setPtB({ lat, lon })} placeholder="lat,lon or place" />
            </div>
            <button
              type="button"
              className={`mono text-[10px] mt-0.5 ${placing === 'B' ? 'text-accent' : 'text-txt-3'} hover:text-accent`}
              onClick={() => beginPlace('B')}
            >
              {placing === 'B' ? '… click map' : 'or click map'}
            </button>
          </div>
        </div>
      </Widget>

      <Widget title="Force / parameters">
        <div className="space-y-2">
          {isAttack ? (
            <>
              <Select label="Strike system" value={attackerId} options={attackerSystems} onChange={setAttackerId} />
              <Slider label="Strikers" value={attackerCount} min={1} max={2000} step={1} onChange={setAttackerCount} />
              {attackerCount > RENDER_AGENT_CAP && (
                <MicroLabel className="block text-warn">
                  rendering {RENDER_AGENT_CAP} of {attackerCount} — math uses full count
                </MicroLabel>
              )}
              <Select label="Air defence" value={defenderId} options={defenderSystems} onChange={setDefenderId} />
              <Slider label="Defence sites" value={defenderCount} min={1} max={8} step={1} onChange={setDefenderCount} />
            </>
          ) : (
            <>
              {isSwarm && <Slider label="Drones" value={count} min={1} max={2000} step={1} onChange={setCount} />}
              {isSwarm && count > RENDER_AGENT_CAP && (
                <MicroLabel className="block text-warn">
                  rendering {RENDER_AGENT_CAP} of {count} — math uses full count
                </MicroLabel>
              )}
              <Slider label="Speed" value={speedKph} min={40} max={900} step={5} unit=" km/h" onChange={setSpeedKph} />
              <Slider
                label={isSwarm ? 'Cruise alt' : 'Start alt'}
                value={altM}
                min={100}
                max={9000}
                step={100}
                unit=" m"
                onChange={setAltM}
              />
              {isSwarm && <Slider label="Spread" value={spreadKm} min={0} max={50} step={1} unit=" km" onChange={setSpreadKm} />}
            </>
          )}
        </div>
        <div className="mt-2.5">
          <Btn tone="accent" size="md" onClick={build} disabled={!ready} className="w-full justify-center">
            ▶ Run scenario
          </Btn>
          {!ready && <MicroLabel className="block mt-1">place both points to run</MicroLabel>}
        </div>
      </Widget>

      <Widget title="EW & terrain">
        <div className="space-y-2">
          {isSwarm && (
            <label className="block">
              <SectionLabel title="Control link" />
              <select
                value={linkKey}
                onChange={(e) => setLinkKey(e.target.value)}
                className="w-full mt-1 bg-bg-2 border border-line rounded-sm mono text-[10px] text-txt-1 px-1.5 py-1"
              >
                {LINK_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {isAttack && (
            <KVRow k="Link" v={linkLabelFor(attackerId)} />
          )}
          <div className="flex items-center justify-between">
            <SectionLabel title="Nap-of-earth" />
            <Toggle on={napOfEarth} onChange={setNapOfEarth} label="nap of earth" />
          </div>
          <MicroLabel className="block">terrain-follow + LOS masking (needs 3D terrain)</MicroLabel>

          <Slider label="Jammer radius" value={jamRadiusKm} min={5} max={120} step={5} unit=" km" onChange={setJamRadiusKm} />

          {/* Jammer — its own always-visible coordinate field. Pick a band, then
              type "lat,lon" / a place or use ⌖; each entry drops a jammer. */}
          <div className="flex items-center gap-1.5">
            <SectionLabel title="Jammer" />
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setJamKind('comms')}
                className={`mono text-[10px] px-1.5 py-0.5 border rounded-sm ${jamKind === 'comms' ? 'border-accent-line text-accent' : 'border-line text-txt-3 hover:text-txt-1'}`}
              >
                comms
              </button>
              <button
                type="button"
                onClick={() => setJamKind('gnss')}
                className={`mono text-[10px] px-1.5 py-0.5 border rounded-sm ${jamKind === 'gnss' ? 'border-accent-line text-accent' : 'border-line text-txt-3 hover:text-txt-1'}`}
              >
                GNSS
              </button>
            </div>
          </div>
          <CoordEntry
            viewer={viewer}
            onPlace={(lat, lon) => addJammerAt(jamKind, lat, lon)}
            placeholder={`drop ${jamKind} jammer: lat,lon or place`}
          />

          <div className="flex flex-wrap gap-1.5">
            <Btn size="sm" onClick={() => addJammer('comms')} className={placing === 'JAM' ? 'border-accent-line text-accent' : ''}>
              + comms (click map)
            </Btn>
            <Btn size="sm" onClick={() => addJammer('gnss')}>
              + GNSS (click map)
            </Btn>
            <Btn size="sm" onClick={() => void pullLiveJamming()} disabled={liveJamLoading}>
              {liveJamLoading ? '…' : 'live GPS jam'}
            </Btn>
          </div>
          <div className="flex items-center justify-between">
            <MicroLabel>{jammers.length} jammer{jammers.length === 1 ? '' : 's'} placed</MicroLabel>
            {jammers.length > 0 && (
              <button className="mono text-[10px] text-txt-3 hover:text-alert" onClick={() => setJammers([])}>
                clear
              </button>
            )}
          </div>
        </div>
      </Widget>

      {clock.stats && (
        <Widget title="Link / EW status">
          <KV>
            <KVRow k={isSwarm && count > RENDER_AGENT_CAP ? 'Airborne (rendered / total)' : 'Airborne'} v={isSwarm && count > RENDER_AGENT_CAP ? `${clock.stats.airborne} / ${count}` : clock.stats.airborne} />
            <KVRow k="Struck target" v={clock.stats.struck} warn />
            <KVRow k="Intercepted (SAM)" v={clock.stats.intercepted} />
            <KVRow k="Link lost / EW" v={clock.stats.linkLost} />
            <KVRow k="GPS-degraded" v={clock.stats.degraded} />
          </KV>
        </Widget>
      )}

      {clock.duration > 0 && (
        <Widget title="Playback" count={`${fmtClock(clock.simTime)} / ${fmtClock(clock.duration)}`}>
          <input
            type="range"
            min={0}
            max={Math.max(1, clock.duration)}
            step={1}
            value={Math.min(clock.simTime, clock.duration)}
            onChange={(e) => ctrlRef.current?.seek(Number(e.target.value))}
            className="w-full accent-[var(--accent)]"
          />
          <div className="flex items-center gap-1.5 mt-2">
            <Btn size="sm" onClick={() => ctrlRef.current?.togglePlay()}>
              {clock.playing ? '❚❚ Pause' : '▶ Play'}
            </Btn>
            <Btn size="sm" onClick={() => ctrlRef.current?.reset()}>
              ↺ Reset
            </Btn>
            <span className="flex-1" />
            <Badge tone="accent">{playSpeed}×</Badge>
          </div>
          <Slider
            label="Sim speed"
            value={playSpeed}
            min={1}
            max={120}
            step={1}
            unit="×"
            onChange={(v) => {
              setPlaySpeed(v);
              ctrlRef.current?.setSpeed(v);
            }}
          />
        </Widget>
      )}

      {raid && (
        <Widget title="Battle damage" count={`${raid.leakRatePct}% leak`}>
          <KV>
            <KVRow k="Strikers" v={raid.attackerCount} />
            <KVRow k="Intercepted" v={raid.intercepted} />
            <KVRow k="Leakers" v={raid.leakers} warn />
            <KVRow k="Est. hits on target" v={raid.damageUnits} warn />
            <KVRow k="Defence capacity" v={raid.defenseCapacity} />
          </KV>
        </Widget>
      )}

      {econ && (
        <Widget title="Economic impact">
          <KV>
            {econ.nearestChokepoint && <KVRow k="Chokepoint" v={econ.nearestChokepoint} />}
            <KVRow k="Oil price" v={`+${econ.oilPriceShockPct}%`} warn />
            <KVRow k="Trade disrupted" v={`$${(econ.tradeDisruptedUsdPerDay / 1e9).toFixed(1)}B/day`} />
          </KV>
          <p className="text-[10px] text-txt-2 mt-1.5 leading-snug">{econ.summary}</p>
        </Widget>
      )}

      {(reasonLoading || reason) && (
        <Widget title="Analyst assessment" count={reason?.ok ? (reason.model ?? '') : reasonLoading ? '…' : ''}>
          {reasonLoading && <MicroLabel>reasoning over the outcome…</MicroLabel>}
          {reason && !reason.ok && (
            <p className="text-[10px] text-warn leading-snug">model unavailable{reason.error ? `: ${reason.error}` : ''}</p>
          )}
          {reason?.ok && (
            <div className="space-y-2">
              {reason.assessment && <p className="text-[11px] text-txt-1 leading-snug">{reason.assessment}</p>}
              <div className="flex flex-wrap gap-1.5">
                {reason.escalation_risk && <Badge tone="alert">escalation: {reason.escalation_risk}</Badge>}
                {reason.confidence && <Badge tone="accent">confidence {reason.confidence}</Badge>}
              </div>
              {reason.casualties_estimate && (
                <KV>
                  <KVRow k="Casualties" v={reason.casualties_estimate} />
                </KV>
              )}
              {reason.outcomes && reason.outcomes.length > 0 && (
                <div>
                  <SectionLabel title="Outcomes" />
                  <ul className="mt-1 space-y-1">
                    {reason.outcomes.slice(0, 4).map((o, i) => (
                      <li key={i} className="text-[10.5px] text-txt-1 leading-snug">
                        <span className="mono text-accent tabular-nums">{Math.round((o.probability ?? 0) * 100)}%</span>{' '}
                        {o.description}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {reason.second_order && reason.second_order.length > 0 && (
                <div>
                  <SectionLabel title="Second-order" />
                  <ul className="mt-1 list-disc list-inside text-[10.5px] text-txt-2 leading-snug">
                    {reason.second_order.slice(0, 4).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {reason.assumptions && reason.assumptions.length > 0 && (
                <MicroLabel className="block">assumes: {reason.assumptions.slice(0, 3).join('; ')}</MicroLabel>
              )}
            </div>
          )}
        </Widget>
      )}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <SectionLabel title={label} />
        <span className="mono text-[10px] text-txt-1 tabular-nums ml-2">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full mt-1 accent-[var(--accent)]"
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: CatalogItem[];
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="block">
      <SectionLabel title={label} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full mt-1 bg-bg-2 border border-line rounded-sm mono text-[10px] text-txt-1 px-1.5 py-1"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
