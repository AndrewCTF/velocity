// Behaviour from the OWNED archive, not from what this tab happened to see.
//
// The Track card above plots the in-memory ring buffer, which starts empty
// every time the page loads: open the console and click an aircraft and you get
// "insufficient samples" regardless of how long the archive has been running.
// This card asks the archive instead, so the altitude trace is however much
// history you have kept, and it survives a reload.
//
// That distinction is the entire argument for owning history rather than
// renting a live feed (docs/research-last30days-2026-07-29.md §1.1: every
// competitor surveyed is stateless and structurally cannot draw this).
import { useEffect, useState } from 'react';
import * as Cesium from 'cesium';
import { apiFetch } from '../transport/http.js';
import { SectionLabel, Btn } from '../shell/instruments.js';

interface SeriesPoint {
  t: number;
  alt_m: number | null;
  sog: number | null;
}

const WINDOW_SEC = 3600;

// Projection: GET /api/history/project (apps/api/app/intel/project.py). An
// honest cone extrapolated from THIS contact's own recorded fixes (mean
// heading/speed +/- 2 std dev), never a model. "Project 1 h" is a fixed
// horizon — no dial, so the label always matches what was actually asked for.
const PROJECTION_HORIZON_S = 3600;
const PROJECTION_DS_NAME = 'projection';
// Distinct from the live selection magenta (#d946ef, apps/web/CLAUDE.md) so an
// analytic overlay is never mistaken for an observed track.
const PROJECTION_COLOR = Cesium.Color.fromCssColorString('#f59e0b');

interface ProjectionEta {
  name: string;
  eta_s: number;
  bearing_deg: number;
  in_cone: boolean;
}

interface ProjectionResult {
  status: 'ok' | 'insufficient';
  reason?: string;
  mean_kn?: number;
  mean_hdg?: number;
  cone?: { type: 'Polygon'; coordinates: number[][][] };
  eta?: ProjectionEta[];
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${m} min`;
}

/** Draw (or remove) the projection cone as one Cesium entity `proj:<id>` in a
 *  dedicated `projection` CustomDataSource. A polygon outline cannot carry a
 *  dash material in Cesium, so the dashed outline is a separate `polyline`
 *  graphic on the SAME entity, over a faint (10%) polygon fill. Never touches
 *  the contact's own entity — this is an analytic overlay, not a position
 *  (apps/web/CLAUDE.md no-synthesis rule). */
function useProjectionOverlay(
  viewer: Cesium.Viewer | null | undefined,
  id: string | null,
  cone: ProjectionResult['cone'] | undefined,
): void {
  useEffect(() => {
    if (!viewer || !id || !cone || viewer.isDestroyed()) return;
    let ds = viewer.dataSources.getByName(PROJECTION_DS_NAME)[0] as Cesium.CustomDataSource | undefined;
    if (!ds) {
      ds = new Cesium.CustomDataSource(PROJECTION_DS_NAME);
      viewer.dataSources.add(ds);
    }
    const entityId = `proj:${id}`;
    const ring = cone.coordinates[0] ?? [];
    const positions = ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon as number, lat as number));
    ds.entities.removeById(entityId);
    if (positions.length >= 3) {
      ds.entities.add({
        id: entityId,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: PROJECTION_COLOR.withAlpha(0.1),
          outline: false,
        },
        polyline: {
          positions: [...positions, positions[0]!],
          width: 2,
          material: new Cesium.PolylineDashMaterialProperty({ color: PROJECTION_COLOR, dashLength: 12 }),
          clampToGround: true,
        },
      });
    }
    viewer.scene.requestRender();
    return () => {
      try {
        if (!viewer.isDestroyed()) {
          ds?.entities.removeById(entityId);
          viewer.scene.requestRender();
        }
      } catch {
        /* viewer torn down mid-cleanup */
      }
    };
  }, [viewer, id, cone]);
}

/** Minimal SVG trace over a nullable series. Gaps in the data are gaps in the
 *  line, never interpolated: a straight segment across a coverage hole is a
 *  claim we did not observe. */
export function Trace({
  values,
  width = 260,
  height = 34,
}: {
  values: readonly (number | null)[];
  width?: number;
  height?: number;
}): JSX.Element | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  const segs: string[] = [];
  let penDown = false;
  values.forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      penDown = false; // break the line rather than bridging the gap
      return;
    }
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    segs.push(`${penDown ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
    penDown = true;
  });
  return (
    <svg width={width} height={height} className="block">
      <path d={segs.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.2" />
    </svg>
  );
}

export function ArchiveSeriesCard({
  id,
  kind,
  viewer,
}: {
  id: string | null;
  kind: string;
  viewer?: Cesium.Viewer | null;
}): JSX.Element | null {
  const [series, setSeries] = useState<SeriesPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projecting, setProjecting] = useState(false);
  const [projection, setProjection] = useState<ProjectionResult | null>(null);
  const [projError, setProjError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setSeries(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const r = await apiFetch(
          `/api/history/track?id=${encodeURIComponent(id)}&from_ts=${now - WINDOW_SEC}&series=true`,
        );
        if (!r.ok) {
          if (!cancelled) {
            setError(`HTTP ${r.status}`);
            setSeries(null);
          }
          return;
        }
        const body = (await r.json()) as { series?: SeriesPoint[] };
        if (!cancelled) {
          setSeries(body.series ?? []);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError('unreachable');
          setSeries(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Selection changed: the toggle does not carry over to a different contact.
  useEffect(() => {
    setProjecting(false);
    setProjection(null);
    setProjError(null);
  }, [id]);

  useEffect(() => {
    if (!projecting || !id) {
      setProjection(null);
      setProjError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiFetch(
          `/api/history/project?id=${encodeURIComponent(id)}&horizon_s=${PROJECTION_HORIZON_S}`,
        );
        if (!r.ok) {
          if (!cancelled) {
            setProjError(`HTTP ${r.status}`);
            setProjection(null);
          }
          return;
        }
        const body = (await r.json()) as ProjectionResult;
        if (!cancelled) {
          setProjection(body);
          setProjError(null);
        }
      } catch {
        if (!cancelled) {
          setProjError('unreachable');
          setProjection(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, projecting]);

  useProjectionOverlay(viewer, projecting ? id : null, projecting ? projection?.cone : undefined);

  if (!id || (kind !== 'aircraft' && kind !== 'vessel')) return null;

  const alt = (series ?? []).map((s) => s.alt_m);
  const sog = (series ?? []).map((s) => s.sog);
  const haveAlt = alt.filter((v) => typeof v === 'number').length >= 2;
  const haveSog = sog.filter((v) => typeof v === 'number').length >= 2;

  return (
    <section>
      <SectionLabel
        title="Archive"
        count={series == null ? '' : `${series.length} fixes · 1h`}
      />
      <div className="mt-1.5 space-y-1.5">
        {error && <div className="mono text-[10px] text-alert-fg">Archive unavailable ({error}).</div>}
        {!error && series == null && <div className="mono text-[10px] text-txt-4">Loading…</div>}
        {!error && series != null && series.length === 0 && (
          // An empty archive is a real, useful answer and it says which it is:
          // nothing recorded, not nothing happened.
          <div className="mono text-[10px] text-txt-4">
            Nothing recorded for this contact in the last hour.
          </div>
        )}
        {haveAlt && (
          <div>
            <span className="micro">altitude · archived</span>
            <Trace values={alt} />
          </div>
        )}
        {haveSog && (
          <div>
            <span className="micro">speed · archived</span>
            <Trace values={sog} />
          </div>
        )}
        {!error && series != null && series.length > 0 && !haveAlt && !haveSog && (
          <div className="mono text-[10px] text-txt-4">
            {series.length} positions recorded, no altitude or speed among them.
          </div>
        )}
      </div>
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="micro">projection</span>
          <Btn
            size="sm"
            tone={projecting ? 'accent' : 'neutral'}
            title={
              projecting
                ? 'Stop projecting this contact forward'
                : "Project this contact's position 1 hour ahead from its own recorded track"
            }
            onClick={() => setProjecting((p) => !p)}
          >
            Project 1 h
          </Btn>
        </div>
        {projecting && projError && (
          <div className="mono text-[10px] text-alert-fg">Projection unavailable ({projError}).</div>
        )}
        {projecting && !projError && projection == null && (
          <div className="mono text-[10px] text-txt-4">Loading…</div>
        )}
        {projecting && !projError && projection?.status === 'insufficient' && (
          <div className="mono text-[10px] text-txt-4">
            Not enough recorded history to project this contact forward
            {projection.reason ? ` (${projection.reason}).` : '.'}
          </div>
        )}
        {projecting && !projError && projection?.status === 'ok' && (
          <div className="space-y-1">
            {typeof projection.mean_kn === 'number' && typeof projection.mean_hdg === 'number' && (
              <div className="mono text-[10px] text-txt-3">
                {projection.mean_kn.toFixed(1)} kn · heading {projection.mean_hdg.toFixed(0)}°
              </div>
            )}
            {(projection.eta ?? []).length === 0 && (
              <div className="mono text-[10px] text-txt-4">No chokepoint lies on this heading.</div>
            )}
            {(projection.eta ?? []).map((e) => (
              <div key={e.name} className="mono text-[10px] text-txt-2">
                {e.name} · {formatDuration(e.eta_s)} · {e.in_cone ? 'in cone' : 'outside cone'}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
