// E10: the link-analysis graph with its histogram panel, laid out natively. The
// graph is an SVG whose viewBox scales to its pane; the histograms are real
// text. Nodes are a sample of 46 live ontology incidents (/api/ontology/search)
// linked to their detector domains; every histogram counts their real props.
import { BpIcon } from "../../../shell/BpIcon.js";
import { countBy, graphData, type Incident } from "./data.js";
import { EuBar } from "./Bar.js";
import { graphLayout, hubOf } from "./layout.js";
import type { Go } from "./SatMap.js";

const TH: Record<string, string> = { high: "#e86a4a", elevated: "#e0b04a" };
const NONE = "—"; // no value reported

const sortCount = (m: Map<string, number>): [string, number][] =>
  [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

function Hist({ title, rows, shown }: { title: string; rows: [string, number][]; shown?: number }): JSX.Element {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const part = shown === undefined ? rows : rows.slice(0, shown);
  return (
    <>
      <h3 className="eux-sub">{title}</h3>
      <ul className="eux-hist">
        {part.map(([lab, v]) => (
          <li key={lab}>
            <span title={lab}>{lab}</span>
            <span>{v}</span>
            <i style={{ width: `${Math.max(2, (100 * v) / max)}%` }} />
          </li>
        ))}
      </ul>
      {shown !== undefined && rows.length > shown && <small>{`Showing ${shown} of ${rows.length}`}</small>}
    </>
  );
}

export function GraphPage({ all, done, total, status, go }: { all: Incident[]; done: number; total: number; status: string | null; go: Go }): JSX.Element {
  const { inc, doms } = graphData(all);
  const { pos, box } = graphLayout(inc, doms);
  const thr = sortCount(countBy(inc, (i) => [i.threat ?? NONE]));
  const dc = sortCount(countBy(inc, (i) => i.domains));
  const sc = sortCount(countBy(inc, (i) => [i.score === null ? NONE : String(i.score)]));
  return (
    <div className="eux">
      <EuBar go={go} here="graph" crumb="Graph">
        {(done < total || status) && (
          <span className="eux-prog" role="status">
            {status ?? `Loading ontology ${done} of ${total}`}
            {!status && <progress value={done} max={Math.max(1, total)} aria-label="Ontology searches done" />}
          </span>
        )}
      </EuBar>
      <div className="eux-main">
        <div className="eux-plate">
          <svg className="eux-svg" viewBox={box.join(" ")} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Link graph of ${inc.length} incidents and ${doms.length} detector domains`}>
            {inc.flatMap((it, i) =>
              it.domains.map((d) => {
                const [hx, hy] = hubOf(d);
                const [px, py] = pos.get(i)!;
                return <line key={`${i}${d}`} x1={px} y1={py} x2={hx} y2={hy} stroke="#7a848b" strokeWidth="1" opacity=".8" />;
              }),
            )}
            {inc.map((it, i) => {
              const [x, y] = pos.get(i)!;
              return (
                <g key={it.id}>
                  <title>{`${it.id} · threat ${it.threat ?? NONE} · score ${it.score ?? NONE}`}</title>
                  <rect x={x - 7} y={y - 9} width={14} height={18} rx={2} fill="#c8d0d6" />
                  <rect x={x - 7} y={y + 4} width={14} height={5} rx={1} fill={TH[it.threat ?? ""] ?? "#9aa4ab"} />
                  <text x={x} y={y + 22} fontSize={11} textAnchor="middle" fill="#aab5bc">
                    {(it.id.split(":")[1] ?? it.id).slice(0, 7)}
                  </text>
                </g>
              );
            })}
            {doms.map((d) => {
              const [x, y] = hubOf(d);
              return (
                <g key={d}>
                  <rect x={x - 9} y={y - 9} width={18} height={18} rx={3} fill="#3a6fb4" stroke="#9ab8e0" />
                  <text x={x} y={y + 26} fontSize={14} textAnchor="middle" fill="#dfe5ea">
                    {d}
                  </text>
                </g>
              );
            })}
          </svg>
          {inc.length === 0 && <p className="eu-note" style={{ position: "absolute", left: 8, top: 8 }}>{status ?? (done < total ? "Searching the ontology" : "No incidents in the ontology")}</p>}
        </div>
        <aside className="eux-side eux-right" aria-label="Graph summary">
          <div className="eux-h">
            <BpIcon name="graph" size={14} />
            {`${inc.length + doms.length} nodes`}
          </div>
          <Hist title="Object types" rows={[["Incident", inc.length], ["Detector domain", doms.length]]} />
          <Hist title="Threat level" rows={thr} />
          <Hist title="Domains" rows={dc} shown={4} />
          <Hist title="Score" rows={sc} shown={5} />
          <div className="eux-card">
            <h3>Legend</h3>
            {(
              [
                ["#3a6fb4", "Detector domain"],
                ["#e86a4a", "Incident, threat high"],
                ["#e0b04a", "Incident, threat elevated"],
                ["#9aa4ab", "Incident, other"],
              ] as const
            ).map(([c, l]) => (
              <span key={l} className="eux-key">
                <i className="eux-sw" style={{ background: c }} />
                {l}
              </span>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
