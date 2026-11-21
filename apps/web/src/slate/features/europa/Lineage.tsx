// E11: the data lineage pipeline graph, laid out natively: an SVG whose viewBox
// scales to its pane and a side panel of real text. Nodes, edges, legend counts
// and build counts are /api/foundry/lineage and /api/foundry/summary; the
// chain rows are derived from the live edges (data.ts lineageChains).
import { BpIcon } from "../../../shell/BpIcon.js";
import { unavailable, type FSummary, type Lineage, type LinNode, type Res } from "./data.js";
import { EuBar } from "./Bar.js";
import { NODE_H, NODE_W, lineageLayout } from "./layout.js";
import type { Go } from "./SatMap.js";

// fill and the ink that clears AA on it
const KCOL: Record<string, [string, string]> = {
  raw: ["#23642d", "#ffffff"],
  reference: ["#d3d8dc", "#1c2228"],
  derived: ["#2a62a0", "#ffffff"],
  transform: ["#8c3032", "#ffffff"],
  stale: ["#c8a43c", "#14181c"],
};
const NONE = "—"; // no value reported
const kindOf = (n: LinNode): string => (n.type === "transform" ? "transform" : (n.kind ?? "raw"));

export function LineagePage({ lin, linRes, fs, go }: { lin: Lineage | null; linRes: Res<unknown> | null; fs: FSummary | null; go: Go }): JSX.Element {
  const nodes = lin?.nodes ?? [];
  const { pos, box } = lin ? lineageLayout(lin) : { pos: new Map<string, [number, number]>(), box: [0, 0, 1400, 800] as [number, number, number, number] };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cnt: Record<string, number> = { raw: 0, reference: 0, derived: 0, transform: 0 };
  for (const n of nodes) cnt[kindOf(n)] = (cnt[kindOf(n)] ?? 0) + 1;
  const stale = nodes.filter((n) => n.stale).length;
  const rb = fs?.recent_builds ?? [];
  const nsucc = rb.filter((b) => b.status === "succeeded").length;
  const nfail = rb.filter((b) => b.status === "failed").length;
  const isoRaw = nodes.filter((n) => n.type === "dataset" && n.kind === "raw" && !pos.has(n.id));
  const isoRef = nodes.filter((n) => n.type === "dataset" && n.kind === "reference");
  const legend: [string, string][] = [
    ["raw", `Raw (${cnt["raw"]})`],
    ["reference", `Reference (${cnt["reference"]})`],
    ["transform", `Transform (${cnt["transform"]})`],
    ["stale", `Stale (${stale})`],
    ["derived", `Derived (${cnt["derived"]})`],
  ];
  return (
    <div className="eux">
      <EuBar go={go} here="lineage" crumb="Dataset lineage">
        <span className="eu-dim eux-stat" title="Foundry datasets">
          <BpIcon name="database" size={12} /> {`Datasets ${fs ? fs.datasets : NONE}`}
        </span>
        <span className="eu-dim eux-stat" title="Recent builds succeeded">
          <BpIcon name="tick" size={12} /> {`Succeeded ${fs ? nsucc : NONE}`}
        </span>
        <span className="eu-dim eux-stat" title="Builds failed">
          <BpIcon name="cross" size={12} /> {`Failed ${fs ? fs.failed_builds_24h + nfail : NONE}`}
        </span>
      </EuBar>
      <div className="eux-main">
        <div className="eux-plate">
          <svg className="eux-svg" viewBox={box.join(" ")} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Dataset lineage pipeline">
            <defs>
              <marker id="eux-ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0 0 L8 4 L0 8Z" fill="#8a949b" />
              </marker>
            </defs>
            {(lin?.edges ?? [])
              .filter((e) => pos.has(e.src) && pos.has(e.dst))
              .map((e) => {
                const [ax, ay] = pos.get(e.src)!;
                const [bx, by] = pos.get(e.dst)!;
                return <line key={`${e.src}${e.dst}`} x1={Math.round(ax + NODE_W)} y1={Math.round(ay)} x2={Math.round(bx - 2)} y2={Math.round(by)} stroke="#8a949b" strokeWidth="1.6" markerEnd="url(#eux-ah)" />;
              })}
            {[...pos].map(([id, [x, y]]) => {
              const n = byId.get(id);
              if (!n) return null;
              const [fill, ink] = KCOL[kindOf(n)] ?? KCOL["raw"]!;
              return (
                <svg key={id} x={x} y={y - NODE_H / 2} width={NODE_W} height={NODE_H}>
                  <title>{n.name}</title>
                  <rect x={1} y={1} width={NODE_W - 2} height={NODE_H - 2} rx={3} fill={fill} stroke={n.stale ? KCOL["stale"]![0] : "rgba(0,0,0,.3)"} strokeWidth={n.stale ? 2 : 1} />
                  <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle" fontSize={n.name.length < 20 ? 14 : 11} fill={ink}>
                    {n.name}
                  </text>
                </svg>
              );
            })}
          </svg>
          {!lin && <p className="eu-note" style={{ position: "absolute", left: 8, top: 8 }}>{unavailable("Lineage", linRes)}</p>}
        </div>
        <aside className="eux-side eux-right" aria-label="Lineage legend">
          <div className="eux-h">
            <BpIcon name="data-lineage" size={14} />
            Dataset kind
          </div>
          {legend.map(([k, lab]) => (
            <span key={k} className="eux-key">
              <i className="eux-sw" style={{ background: KCOL[k]![0] }} />
              {lab}
            </span>
          ))}
          {lin && (
            <>
              <h3 className="eux-sub">{`Reference datasets (${isoRef.length})`}</h3>
              <ul className="eux-names">
                {isoRef.map((n) => (
                  <li key={n.id} title={n.name}>{n.name}</li>
                ))}
              </ul>
              <h3 className="eux-sub">{`Unlinked datasets (${isoRaw.length})`}</h3>
              <ul className="eux-names">
                {isoRaw.map((n) => (
                  <li key={n.id} title={n.name}>{n.name}</li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
