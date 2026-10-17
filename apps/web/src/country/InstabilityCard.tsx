// Instability card — /api/country/instability/{iso3} (task C3, backend-owned).
// A single 0-100 composite score built from weighted, normalized components
// (conflict, displacement, advisories, etc. — whatever `components_present`
// lists that day). Hides entirely, like DisplacementCard, when the country
// has no snapshot yet (404) rather than showing a permanent empty shell.

import { Card, Skeleton, humanizeRole, useCachedFetch } from "./shared.js";

export interface InstabilityComponent {
  key: string;
  raw: number;
  normalized: number;
  weight: number;
  inputs?: Record<string, unknown> | string[] | null;
}

export interface InstabilityHistoryPoint {
  ts_utc: string;
  score: number;
}

export interface InstabilityResponse {
  iso3: string;
  score: number;
  components: InstabilityComponent[];
  components_present: string[];
  ts_utc: string;
  history: InstabilityHistoryPoint[];
  baseline?: number | null;
}

function summarizeInputs(inputs: InstabilityComponent["inputs"]): string {
  if (!inputs) return "";
  if (Array.isArray(inputs)) return inputs.join(", ");
  return Object.entries(inputs)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function InstabilitySparkline({
  history,
}: {
  history: InstabilityHistoryPoint[];
}): JSX.Element | null {
  const pts = history.filter(
    (p) => typeof p.score === "number" && Number.isFinite(p.score),
  );
  if (pts.length < 2) return null;
  const w = 96;
  const h = 22;
  const ys = pts.map((p) => p.score);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const sx = (i: number): number =>
    pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * (w - 2) + 1;
  const sy = (y: number): number =>
    y1 === y0 ? h / 2 : h - 1 - ((y - y0) / (y1 - y0)) * (h - 2);
  const path = pts
    .map((p, i) => `${sx(i).toFixed(1)},${sy(p.score).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="block"
      aria-hidden
    >
      <polyline
        points={path}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function ComponentBar({
  component,
}: {
  component: InstabilityComponent;
}): JSX.Element {
  const pct = Math.max(0, Math.min(100, component.normalized));
  const weightLabel = `w ${component.weight.toFixed(2).replace(/^0/, "")}`;
  const title = summarizeInputs(component.inputs) || undefined;
  return (
    <div className="flex items-center gap-2 py-0.5" title={title}>
      <span className="text-[10px] text-txt-3 w-24 shrink-0 truncate">
        {humanizeRole(component.key)}
      </span>
      <div className="flex-1 h-2 rounded-sm bg-bg-2 border border-line-2 overflow-hidden">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="mono text-[9.5px] text-txt-4 w-9 text-right shrink-0">
        {weightLabel}
      </span>
    </div>
  );
}

export function InstabilityCard({
  iso3,
}: {
  iso3: string;
}): JSX.Element | null {
  const { loading, error, data } = useCachedFetch<InstabilityResponse>(
    `/api/country/instability/${iso3}`,
  );

  if (loading) {
    return (
      <Card title="Instability">
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-24" />
        </div>
      </Card>
    );
  }

  // 404 (no snapshot) and any other error both hide the card rather than
  // showing a permanent "failed" shell for a country with no coverage.
  if (error || !data) return null;

  const updated = data.ts_utc
    ? data.ts_utc.replace("T", " ").slice(0, 16)
    : null;

  return (
    <Card
      title="Instability"
      meta={updated ? `updated ${updated} UTC` : undefined}
    >
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex items-baseline gap-1">
          <span className="mono text-[24px] text-txt-0">
            {data.score.toFixed(1)}
          </span>
          <span className="text-[11px] text-txt-3">/100</span>
        </div>
        <InstabilitySparkline history={data.history} />
      </div>
      {data.components.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-0.5">
          {data.components.map((c) => (
            <ComponentBar key={c.key} component={c} />
          ))}
        </div>
      )}
      {data.components_present.length > 0 && (
        <div className="mono text-[9.5px] text-txt-4 mt-2">
          Components: {data.components_present.join(", ")}
        </div>
      )}
    </Card>
  );
}
