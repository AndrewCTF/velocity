import { useMemo, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { useAoi } from '../state/aoi.js';
import { useTaskingQuestions } from '../state/taskingQuestions.js';
import { AoiSelector } from '../command-bar/AoiSelector.js';
import { flyToPosition } from '../globe/camera.js';
import {
  SectionLabel,
  Widget,
  KV,
  KVRow,
  Btn,
  Badge,
  Toggle,
  MicroLabel,
  Caveat,
} from '../shell/instruments.js';
import {
  SENSOR_SATS,
  SENSOR_KINDS,
  sensorOf,
  type SensorKind,
} from '../registry/sensorSats.js';
import {
  passesOverAoi,
  skyView,
  coverageStats,
  type Pass,
  type SkyPoint,
  type Window as TaskWindow,
} from '../sim/tasking.js';
import { SkyViewPlot } from './SkyViewPlot.js';

// Collection planner — "when can a sensor satellite see my AOI, and how often?"
// Reuses the SGP4 stack (satellite.js) via pure tasking.ts math. Pulls CelesTrak
// `active` TLEs, filters to the curated commercial-sensor catalogue (sensorSats),
// computes AOI passes / sky-track / revisit, and renders the result. PREDICTION
// stays here — nothing is written back into the live globe.

interface Props {
  viewer: any; // Cesium.Viewer | null — optional "center on AOI" convenience
}

interface OmmRecord {
  OBJECT_NAME?: string;
  NORAD_CAT_ID?: number | string;
  TLE_LINE1?: string;
  TLE_LINE2?: string;
}

interface SatPasses {
  norad: string;
  name: string;
  sensor: SensorKind;
  operator: string;
  passes: Pass[];
}

interface RunResult {
  knownSensorCount: number; // sats in the catalogue present in the CelesTrak pull
  evaluatedCount: number; // sats actually run (matched selected sensor chips)
  perSat: SatPasses[];
  allPasses: Pass[];
  sky: SkyPoint[];
}

const SENSOR_TONE: Record<SensorKind, 'accent' | 'mag' | 'warn' | 'ok'> = {
  EO: 'accent',
  MSI: 'ok',
  SAR: 'warn',
  RF: 'mag',
};

// Coarse step keeps the worst case (all chips, long window, dozens of sats)
// snappy. 30 s resolves ISS-class passes to a few-percent of duration, which is
// fine for planning. The set evaluated is bounded by SENSOR_SATS, never the full
// CelesTrak group.
const STEP_SEC = 30;
const MIN_ELEV_DEG = 10;
const MAX_WINDOW_HOURS = 72;

// Local datetime-local string (no seconds) for the default "From" value.
function toLocalInput(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function fmtClock(ms: number): string {
  try {
    return new Date(ms).toISOString().slice(11, 16) + 'Z';
  } catch {
    return '—';
  }
}

function fmtDur(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

export function TaskingPanel({ viewer }: Props): JSX.Element {
  const aoi = useAoi((s) => s.active);
  const setActive = useAoi((s) => s.setActive);

  // AOI lat/lon: seeded from the active chokepoint center ([lon,lat]) but
  // independently editable for an ad-hoc point.
  const [lat, setLat] = useState<string>(aoi ? String(aoi.center[1]) : '40.4');
  const [lon, setLon] = useState<string>(aoi ? String(aoi.center[0]) : '-3.7');
  const [fromStr, setFromStr] = useState<string>(toLocalInput(new Date()));
  const [hours, setHours] = useState<string>('24');
  const [minRevisit, setMinRevisit] = useState<string>('90');
  const [chips, setChips] = useState<Record<SensorKind, boolean>>({
    EO: true,
    MSI: true,
    SAR: true,
    RF: true,
  });

  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  // §8 question queue.
  const questions = useTaskingQuestions((s) => s.questions);
  const addQuestion = useTaskingQuestions((s) => s.add);
  const removeQuestion = useTaskingQuestions((s) => s.remove);

  const catalogueTotal = useMemo(
    () => new Set(SENSOR_SATS.map((s) => s.match)).size,
    [],
  );

  // When the operator picks a chokepoint from the selector, sync the lat/lon
  // inputs to its center so a Run targets the strait immediately.
  function pickAoi(c: Parameters<typeof setActive>[0]): void {
    setActive(c);
    if (c) {
      setLat(String(c.center[1]));
      setLon(String(c.center[0]));
    }
  }

  function toggleChip(k: SensorKind): void {
    setChips((p) => ({ ...p, [k]: !p[k] }));
  }

  async function run(): Promise<void> {
    setErr(null);
    const latN = Number(lat);
    const lonN = Number(lon);
    const hoursN = Math.min(MAX_WINDOW_HOURS, Math.max(0.25, Number(hours) || 0));
    const fromMs = new Date(fromStr).getTime();
    if (!isFinite(latN) || latN < -90 || latN > 90) {
      setErr('latitude must be between -90 and 90');
      return;
    }
    if (!isFinite(lonN) || lonN < -180 || lonN > 180) {
      setErr('longitude must be between -180 and 180');
      return;
    }
    if (!isFinite(fromMs)) {
      setErr('invalid start time');
      return;
    }
    const selected = SENSOR_KINDS.filter((k) => chips[k]);
    if (selected.length === 0) {
      setErr('select at least one sensor type');
      return;
    }

    const win: TaskWindow = { startMs: fromMs, endMs: fromMs + hoursN * 3600_000 };
    const aoiPt = { lat: latN, lon: lonN };

    setRunning(true);
    try {
      const r = await apiFetch('/api/space/gp?group=active&limit=20000');
      if (!r.ok) {
        setErr(`CelesTrak upstream ${r.status}`);
        setRunning(false);
        return;
      }
      const j = (await r.json()) as { items?: OmmRecord[] };
      const items = j.items ?? [];

      // Filter the full active group down to curated sensor sats (bounded set),
      // honoring the selected sensor chips, deduped by NORAD id.
      const seen = new Set<string>();
      let knownSensorCount = 0;
      const targets: Array<{
        norad: string;
        name: string;
        sensor: SensorKind;
        operator: string;
        l1: string;
        l2: string;
      }> = [];
      for (const it of items) {
        const l1 = it.TLE_LINE1;
        const l2 = it.TLE_LINE2;
        if (!l1 || !l2) continue;
        const name = (it.OBJECT_NAME ?? '').trim();
        const noradNum = Number(it.NORAD_CAT_ID);
        const hit = sensorOf(name, isFinite(noradNum) ? noradNum : undefined);
        if (!hit) continue;
        const noradStr = String(it.NORAD_CAT_ID ?? name);
        if (seen.has(noradStr)) continue;
        seen.add(noradStr);
        knownSensorCount++;
        if (!chips[hit.sensor]) continue;
        targets.push({
          norad: noradStr,
          name: name || hit.name,
          sensor: hit.sensor,
          operator: hit.operator,
          l1,
          l2,
        });
      }

      // Compute passes per target. Yield to the event loop every few sats so a
      // large AOI window never freezes the panel.
      const perSat: SatPasses[] = [];
      const allPasses: Pass[] = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]!;
        const passes = passesOverAoi(t.l1, t.l2, aoiPt, win, STEP_SEC, MIN_ELEV_DEG, t.name);
        if (passes.length > 0) {
          perSat.push({
            norad: t.norad,
            name: t.name,
            sensor: t.sensor,
            operator: t.operator,
            passes,
          });
          for (const p of passes) allPasses.push(p);
        }
        if (i % 6 === 5) await new Promise((res) => setTimeout(res, 0));
      }

      // Sky-track: draw the best-covering sat (most passes) to keep the scope
      // readable, plus note in the UI that it's a single sat's track.
      perSat.sort((a, b) => b.passes.length - a.passes.length);
      const top = perSat[0];
      const tgtTop = top ? targets.find((t) => t.norad === top.norad) : undefined;
      const sky = tgtTop ? skyView(tgtTop.l1, tgtTop.l2, aoiPt, win, STEP_SEC) : [];

      perSat.sort((a, b) => {
        const ea = Math.max(...a.passes.map((p) => p.maxElevDeg), 0);
        const eb = Math.max(...b.passes.map((p) => p.maxElevDeg), 0);
        return eb - ea;
      });

      setResult({
        knownSensorCount,
        evaluatedCount: targets.length,
        perSat,
        allPasses,
        sky,
      });
    } catch {
      setErr('failed to load satellite elements');
    } finally {
      setRunning(false);
    }
  }

  const stats = useMemo(() => {
    if (!result) return null;
    const fromMs = new Date(fromStr).getTime();
    const hoursN = Math.min(MAX_WINDOW_HOURS, Math.max(0.25, Number(hours) || 0));
    return coverageStats(result.allPasses, {
      startMs: fromMs,
      endMs: fromMs + hoursN * 3600_000,
    });
  }, [result, fromStr, hours]);

  const minRevisitN = Number(minRevisit);
  const revisitWarn =
    stats != null &&
    isFinite(minRevisitN) &&
    minRevisitN > 0 &&
    stats.passCount >= 2 &&
    stats.avgRevisitMin > minRevisitN;

  // Flatten all passes into a single chronological flyover list.
  const flyovers = useMemo(() => {
    if (!result) return [];
    return [...result.allPasses].sort((a, b) => a.startMs - b.startMs).slice(0, 60);
  }, [result]);

  const topSatName = result?.perSat
    ? [...result.perSat].sort((a, b) => b.passes.length - a.passes.length)[0]?.name
    : undefined;

  return (
    <div className="px-3 py-2">
      <SectionLabel title="Satellite tasking" count="planner" />
      <div className="mt-1.5">
        <Caveat level="PREDICTED" note="SGP4 forecast — not live track" tone="warn" />
      </div>

      {/* ── Question queue (§8 MetaConstellation) — standing "can a sensor answer
             at place X" questions; load one back into the planner. ─────────── */}
      <Widget title="Question queue" className="mt-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <MicroLabel>ask a place, load it to run</MicroLabel>
          <button
            type="button"
            onClick={() => {
              const latN = Number(lat);
              const lonN = Number(lon);
              if (!isFinite(latN) || !isFinite(lonN)) return;
              const label = aoi?.name ?? `${latN.toFixed(2)}, ${lonN.toFixed(2)}`;
              addQuestion({ label, lat: latN, lon: lonN, hours: Math.max(0.25, Number(hours) || 24) });
            }}
            className="mono text-[10px] uppercase tracking-[0.4px] px-1.5 py-0.5 rounded-sm border border-accent-line text-accent bg-accent-dim"
          >
            + Save
          </button>
        </div>
        {questions.length === 0 ? (
          <MicroLabel>no standing questions</MicroLabel>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {questions.map((q) => (
              <li key={q.id} className="flex items-center gap-2 py-1.5">
                <span className="text-[11px] text-txt-1 flex-1 truncate">
                  {q.label} <span className="mono text-[10px] text-txt-3">· {q.hours}h</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setLat(String(q.lat));
                    setLon(String(q.lon));
                    setHours(String(q.hours));
                  }}
                  className="mono text-[10px] uppercase px-1.5 py-0.5 rounded-sm border border-line text-txt-2 hover:text-txt-0 hover:border-accent-line"
                >
                  Load
                </button>
                <button
                  type="button"
                  onClick={() => removeQuestion(q.id)}
                  aria-label="Remove question"
                  className="mono text-[10px] text-txt-3 hover:text-alert"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </Widget>

      {/* ── AOI ─────────────────────────────────────────────────────────── */}
      <Widget title="Target AOI" className="mt-2.5">
        <div className="mb-2">
          <AoiSelector onPick={pickAoi} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <MicroLabel>lat</MicroLabel>
            <input
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              inputMode="decimal"
              className="mono mt-0.5 w-full bg-bg-2 border border-line rounded-sm px-2 py-1 text-[11px] text-txt-0 focus:outline-none focus:border-accent-line"
            />
          </label>
          <label className="block">
            <MicroLabel>lon</MicroLabel>
            <input
              value={lon}
              onChange={(e) => setLon(e.target.value)}
              inputMode="decimal"
              className="mono mt-0.5 w-full bg-bg-2 border border-line rounded-sm px-2 py-1 text-[11px] text-txt-0 focus:outline-none focus:border-accent-line"
            />
          </label>
        </div>
        {viewer && (
          <Btn
            size="sm"
            className="mt-2"
            onClick={() => {
              const la = Number(lat);
              const lo = Number(lon);
              if (isFinite(la) && isFinite(lo)) flyToPosition(viewer, lo, la, 800_000, 0.8);
            }}
            title="Center the globe on this AOI"
          >
            center map
          </Btn>
        )}
      </Widget>

      {/* ── Mission window ──────────────────────────────────────────────── */}
      <Widget title="Mission window" className="mt-2.5">
        <label className="block">
          <MicroLabel>from (local)</MicroLabel>
          <input
            type="datetime-local"
            value={fromStr}
            onChange={(e) => setFromStr(e.target.value)}
            className="mono mt-0.5 w-full bg-bg-2 border border-line rounded-sm px-2 py-1 text-[11px] text-txt-0 focus:outline-none focus:border-accent-line"
          />
        </label>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <label className="block">
            <MicroLabel>for (hours)</MicroLabel>
            <input
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              inputMode="numeric"
              className="mono mt-0.5 w-full bg-bg-2 border border-line rounded-sm px-2 py-1 text-[11px] text-txt-0 focus:outline-none focus:border-accent-line"
            />
          </label>
          <label className="block">
            <MicroLabel>max revisit (min)</MicroLabel>
            <input
              value={minRevisit}
              onChange={(e) => setMinRevisit(e.target.value)}
              inputMode="numeric"
              className="mono mt-0.5 w-full bg-bg-2 border border-line rounded-sm px-2 py-1 text-[11px] text-txt-0 focus:outline-none focus:border-accent-line"
            />
          </label>
        </div>
      </Widget>

      {/* ── Sensor chips ────────────────────────────────────────────────── */}
      <Widget title="Sensor types" className="mt-2.5">
        <div className="flex flex-col gap-1.5">
          {SENSOR_KINDS.map((k) => (
            <div key={k} className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Badge tone={SENSOR_TONE[k]}>{k}</Badge>
                <span className="mono text-[10px] text-txt-3">
                  {k === 'EO'
                    ? 'electro-optical'
                    : k === 'MSI'
                      ? 'multispectral'
                      : k === 'SAR'
                        ? 'radar (all-weather)'
                        : 'RF geolocation'}
                </span>
              </span>
              <Toggle on={chips[k]} onChange={() => toggleChip(k)} label={`toggle ${k}`} />
            </div>
          ))}
        </div>
      </Widget>

      <Btn
        tone="accent"
        className="mt-3 w-full justify-center"
        disabled={running}
        onClick={() => void run()}
      >
        {running ? 'computing passes…' : 'Run tasking'}
      </Btn>
      {err && (
        <p className="mono text-[10px] text-[#ffb3ae] mt-2 leading-snug">{err}</p>
      )}

      {/* ── Results ─────────────────────────────────────────────────────── */}
      {result && stats && (
        <div className="mt-3 flex flex-col gap-2.5">
          <Widget
            title="Coverage"
            count={`${result.evaluatedCount} of ${result.knownSensorCount} known-sensor sats`}
          >
            <KV>
              <KVRow k="passes" v={stats.passCount} />
              <KVRow
                k="avg revisit"
                v={stats.passCount >= 2 ? `${stats.avgRevisitMin.toFixed(0)} min` : '—'}
                warn={revisitWarn}
              />
              <KVRow
                k="max gap"
                v={`${stats.maxGapMin.toFixed(0)} min`}
                warn={revisitWarn}
              />
              <KVRow k="in-view" v={`${stats.coveragePct.toFixed(1)}%`} />
              <KVRow k="sats w/ passes" v={result.perSat.length} />
            </KV>
            {revisitWarn && (
              <p className="mono text-[10px] text-[#fcd9a0] mt-2 leading-snug">
                avg revisit {stats.avgRevisitMin.toFixed(0)} min exceeds target{' '}
                {minRevisitN} min — add sensors or widen the window.
              </p>
            )}
            <p className="mono text-[10px] text-txt-3 mt-2 leading-snug">
              From the curated commercial-sensor catalogue ({catalogueTotal} constellations).
              Not a complete catalogue of all imaging satellites.
            </p>
          </Widget>

          <Widget title="Sky view" count={topSatName ?? ''}>
            <div className="flex justify-center py-1">
              <SkyViewPlot samples={result.sky} size={220} />
            </div>
            <p className="mono text-[10px] text-txt-3 leading-snug text-center">
              {topSatName
                ? `az/el track of ${topSatName} (most passes) over the AOI`
                : 'no satellite rises above the horizon in this window'}
            </p>
          </Widget>

          <Widget title="Flyovers" count={flyovers.length}>
            {flyovers.length === 0 ? (
              <p className="mono text-[10px] text-txt-3 leading-snug">
                No sensor satellite passes above {MIN_ELEV_DEG}° over this AOI in the window.
              </p>
            ) : (
              <ul>
                {flyovers.map((p, i) => (
                  <li
                    key={`${p.satName}-${p.startMs}-${i}`}
                    className="border-b border-[rgba(255,255,255,0.035)] last:border-b-0 py-[5px]"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="mono text-[11px] text-txt-1 flex-1 truncate"
                        title={p.satName}
                      >
                        {p.satName ?? '—'}
                      </span>
                      <span className="mono text-[10px] tabular-nums text-txt-3 shrink-0">
                        {fmtClock(p.startMs)}
                      </span>
                    </div>
                    <div className="mono text-[10px] text-txt-3 mt-0.5 flex gap-3">
                      <span>
                        el<span className="text-txt-1"> {p.maxElevDeg.toFixed(0)}°</span>
                      </span>
                      <span>
                        dur<span className="text-txt-1"> {fmtDur(p.durationS)}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Widget>
        </div>
      )}
    </div>
  );
}
