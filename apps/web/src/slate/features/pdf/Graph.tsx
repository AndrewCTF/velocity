// The graph document and its Search around state. Every node is a real object:
// the selected track, its nearest ports, nearby vessels of the result set, the
// AIS feeds in its sources list, its flag state and the sanctions lookup.
// Links are drawn only where a record relates them. The canvas is a 1000 x 640
// stage: edges are SVG in that viewBox, nodes are buttons placed by percent, so
// both scale with the pane.
import { useState } from "react";
import { Btn, Ic, Sat, Ship, type N } from "./kit.js";
import { TRK, km, nearestPorts, title, unavailable, type Hit as Row, type Warning } from "./data.js";
import type { Ctx, Page } from "./model.js";

const SW = 1000;
const SH = 640;
type Kind = "place" | "vessel" | "feed" | "flag" | "lists" | "doc";

interface GNode {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  label: string;
  photo?: { lon: number; lat: number };
  sel?: boolean;
  open?: (() => void) | undefined;
  why?: string | undefined;
}
interface GEdge {
  a: [number, number];
  b: [number, number];
  label?: string;
}

const KIND_ICON: Record<Exclude<Kind, "vessel">, [string, string]> = {
  place: ["map-marker", "#d9a63a"], feed: ["feed", "#4c9bf0"], flag: ["flag", "#d65a5a"], lists: ["shield", "#8fb8ee"], doc: ["document", "#c9cfd6"],
};

function KindIcon({ kind, s }: { kind: Kind; s: number }): JSX.Element {
  if (kind === "vessel") return <span style={{ color: "#9aa5b1", display: "inline-flex" }}><Ship s={s} /></span>;
  const [n, col] = KIND_ICON[kind];
  return <span style={{ color: col, display: "inline-flex" }}><Ic n={n} s={s} /></span>;
}

function Canvas({ nodes, edges, arrows = false, zoom, label }: { nodes: GNode[]; edges: GEdge[]; arrows?: boolean; zoom: number; label: string }): JSX.Element {
  return (
    <div className="pxg-pane">
      <div className="pxg-stage" role="group" aria-label={label} style={{ transform: `scale(${zoom})` }}>
        <svg className="pxg-edges" viewBox={`0 0 ${SW} ${SH}`} aria-hidden>
          <defs>
            <marker id="pxg-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0 0L10 5L0 10z" fill="#e5e8eb" />
            </marker>
          </defs>
          {edges.map((e, k) => {
            const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1];
            const n = Math.hypot(dx, dy) || 1;
            const cut = arrows ? 30 : 0;
            return <line key={k} x1={e.a[0]} y1={e.a[1]} x2={e.b[0] - (dx / n) * cut} y2={e.b[1] - (dy / n) * cut} stroke="#7d8791" strokeWidth={1.5} {...(arrows ? { markerEnd: "url(#pxg-ar)" } : {})} />;
          })}
        </svg>
        {edges.map((e, k) =>
          e.label ? (
            <span key={k} className="pxg-el" style={{ left: `${(((e.a[0] + e.b[0]) / 2 + (e.b[0] - e.a[0]) * 0.08) / SW) * 100}%`, top: `${(((e.a[1] + e.b[1]) / 2 + (e.b[1] - e.a[1]) * 0.08) / SH) * 100}%` }}>{e.label}</span>
          ) : null,
        )}
        {nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            className={`pxg-n${n.sel ? " sel" : ""}`}
            style={{ left: `${(n.x / SW) * 100}%`, top: `${(n.y / SH) * 100}%` }}
            aria-label={n.label}
            title={n.open ? n.label : (n.why ?? `${n.label}: no object view for this node`)}
            disabled={!n.open}
            onClick={n.open}
          >
            <span className="pxg-t">{n.photo ? <Sat lon={n.photo.lon} lat={n.photo.lat} z={16} w={64} h={64} /> : <KindIcon kind={n.kind} s={26} />}</span>
            <span className="pxg-l">{n.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The graph's node set, from the live model. */
export function graphModel(c: Ctx) {
  const sel = c.sel;
  if (!sel) return null;
  const at = [sel.v.lon, sel.v.lat];
  const nearV = c.res.filter((r) => r !== sel).map((r) => ({ r, dd: km(at, [r.v.lon, r.v.lat]) })).sort((a, b) => a.dd - b.dd);
  const feeds = sel.v.sources?.length ? sel.v.sources : [sel.v.source ?? "—"];
  const nearP = nearestPorts(c.ports, sel.v.lon, sel.v.lat, 5).map((p) => ({ t: title(p.name), d: km(at, [p.lon, p.lat]) }));
  const flag = c.entity?.flag_country ?? "—";
  const w0 = [...c.warnings].filter((f) => f.geometry).sort((a, b) => dist(a, at) - dist(b, at))[0] ?? null;
  const warnKm = w0 ? km(at, w0.geometry!.coordinates) : null;
  const warnT = w0 ? `NAVAREA ${w0.properties.navArea} ${w0.properties.msgNumber}/${String(w0.properties.msgYear).slice(2)}` : "—";
  return { sel, trk: TRK(sel.mmsi), nearV, feeds, nearP, flag, warnKm, warnT, photo: { lon: sel.v.lon, lat: sel.v.lat } };
}
const dist = (f: Warning, at: number[]): number => Math.hypot((f.geometry!.coordinates[0] ?? 0) - (at[0] ?? 0), (f.geometry!.coordinates[1] ?? 0) - (at[1] ?? 0));

/** The bar over the canvas: the document's name, find, the side tabs, zoom and view tabs. */
function GraphBar({ c, trk, zoom, setZoom, titleGo }: { c: Ctx; trk: string; zoom: number; setZoom: (z: number) => void; titleGo?: () => void }): JSX.Element {
  const side: [string, string, Page][] = [
    ["properties", "Properties: the custom object view", "cov"], ["info-sign", "Info: the Browser", "browser"], ["history", "History: the object's inbox feed", "inbox"],
    ["layers", "Layers: the map", "gaia"], ["warning-sign", "Warnings: the inbox", "inbox"],
  ];
  const view: [string, string, Page][] = [["th-list", "List: the Object Explorer", "explorer"], ["map", "Map: the map", "gaia"], ["time", "Timeline: the AIS timeline", "timeline"]];
  return (
    <div className="pxg-bar">
      {titleGo ? (
        <Btn label="The graph document" icon="send-to-graph" onClick={titleGo}>Investigation into {trk}</Btn>
      ) : (
        <span className="pxg-title"><Ic n="send-to-graph" /> <b>Investigation into {trk}</b></span>
      )}
      <Btn label="Find artifacts, objects and links: the Browser" icon="zoom-in" onClick={() => c.go("browser")}>Find artifacts, objects and links...</Btn>
      <span className="px-gap" />
      {side.map(([ic, l, to]) => <Btn key={l} sq label={l} icon={ic} onClick={() => c.go(to)} />)}
      <span className="pxg-sep" />
      <Btn sq label="Zoom in" icon="zoom-in" onClick={zoom < 2 ? () => setZoom(Math.min(2, zoom * 1.25)) : undefined} why="At the zoom limit" />
      <Btn sq label="Zoom to fit" icon="zoom-to-fit" onClick={zoom !== 1 ? () => setZoom(1) : undefined} why="The graph is already fitted" />
      <Btn sq label="Zoom out" icon="zoom-out" onClick={zoom > 0.5 ? () => setZoom(Math.max(0.5, zoom / 1.25)) : undefined} why="At the zoom limit" />
      <span className="pxg-sep" />
      {view.map(([ic, l, to]) => <Btn key={l} sq label={l} icon={ic} onClick={() => c.go(to)} />)}
    </div>
  );
}

interface HRowP { name: string; icon?: N; cnt?: number; frac: number; sel?: boolean; txt?: string }
const HRow = ({ name, icon, cnt, frac, sel, txt }: HRowP): JSX.Element => (
  <li className={`pxg-hr${sel ? " sel" : ""}`}>
    <span className="pxg-hn">{icon}{name}</span>
    <span className="px-mu pxg-hc">{txt ?? cnt}</span>
    <span className="px-bar-t"><i style={{ width: `${Math.max(3, 100 * frac)}%` }} /></span>
  </li>
);
const HSec = ({ name, cnt, children }: { name: string; cnt: number; children: N }): JSX.Element => (
  <section>
    <h4 className="px-sect"><Ic n="caret-down" s={10} /> {name} <span className="px-gap" /> {cnt}</h4>
    <ul>{children}</ul>
  </section>
);

function Histogram({ close, children }: { close: JSX.Element; children: N }): JSX.Element {
  return (
    <aside className="px-pane r pxg-hist" aria-label="Histogram">
      <div className="px-ph"><h2>Histogram</h2><span className="px-gap" />{close}</div>
      {children}
    </aside>
  );
}

function Empty({ c }: { c: Ctx }): JSX.Element {
  return (
    <div className="px-pg pxg">
      <p className="px-empty">{c.boxRes && !c.boxRes.ok ? unavailable("AIS box", c.boxRes) : "No vessel matches the search, so the graph has no subject."}</p>
    </div>
  );
}

const ICO: Record<string, [string, string]> = { Place: ["geosearch", "#d9a63a"], "AIS feed": ["feed", "#4c9bf0"], "Flag state": ["flag", "#d65a5a"], "Sanctions lookup": ["shield", "#8fb8ee"] };
const typeIcon = (nm: string): JSX.Element => (nm === "Vessel" ? <span className="pxg-ic" style={{ color: "#9aa5b1" }}><Ship s={12} /></span> : <span className="pxg-ic" style={{ color: ICO[nm]![1] }}><Ic n={ICO[nm]![0]} s={12} /></span>);

/** The graph document. */
export function Graph({ c }: { c: Ctx }): JSX.Element {
  const [zoom, setZoom] = useState(1);
  const g = graphModel(c);
  if (!g) return <Empty c={c} />;
  const { sel, trk, nearV, feeds, nearP, flag } = g;
  const vess: { r: Row; dd: number }[] = [{ r: sel, dd: 0 }, ...nearV.slice(0, 9)];
  const types: [string, number][] = [["Vessel", vess.length], ["Place", nearP.length], ["AIS feed", feeds.length], ["Flag state", 1], ["Sanctions lookup", 1]];
  const vcount = (key: (r: Row) => string): [string, number][] => {
    const m = new Map<string, number>();
    for (const { r } of vess) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  // positions in the copy's figure units, mapped onto the stage
  const X = (x: number): number => 60 + (x - 51) * 1.141;
  const Y = (y: number): number => 105 + (y - 162) * 1.067;
  const ctr: [number, number] = [X(545), Y(320)];
  const top = [408, 480, 552, 636, 728];
  const lef: [number, number][] = [[51, 427], [120, 427], [189, 427], [51, 496], [120, 496], [189, 496], [51, 565], [120, 565], [189, 565]];
  const order = [2, 1, 0, 5, 4, 3, 8, 7, 6];
  const nodes: GNode[] = [
    ...nearP.map((p, i): GNode => ({ id: `p${i}`, kind: "place", x: X(top[i]!), y: Y(162), label: p.t, open: () => { c.setKw(p.t); c.go("browser"); } })),
    { id: "sel", kind: "vessel", x: ctr[0], y: ctr[1], label: trk, sel: true, photo: g.photo, open: () => c.go("graph2") },
    ...vess.slice(1).map(({ r }, i): GNode => ({ id: `v${r.mmsi}`, kind: "vessel", x: X(lef[order[i]!]![0]), y: Y(lef[order[i]!]![1]), label: title(r.name), open: () => c.pick(r.mmsi) })),
    { id: "flag", kind: "flag", x: X(718), y: Y(490), label: `Flag state ${flag}`, why: "Flag state comes from the entity lookup" },
    ...feeds.slice(0, 3).map((f, k): GNode => ({ id: `f${k}`, kind: "feed", x: X(650 + 69 * k), y: Y(560), label: f, why: `${f} is an AIS feed in this vessel's sources list` })),
    { id: "lists", kind: "lists", x: X(822), y: Y(490), label: c.sanc ? c.sanc.lists.join(", ") : "Sanctions lookup", open: () => c.go("cov") },
  ];
  const edges: GEdge[] = nodes.filter((n) => n.id !== "sel").map((n) => ({ a: ctr, b: [n.x, n.y] }));
  const mx = Math.max(1, types[0]![1]);
  const pv: [string, [string, number][]][] = [["FLAG STATE", [[flag, 1]]], ["NAME", vess.map(({ r }): [string, number] => [title(r.name), 1])], ["SPEED OVER GROUND (KN)", vcount((r) => r.sog.toFixed(1))], ["SHIP TYPE", vcount((r) => r.type)]];
  return (
    <div className="px-pg pxg">
      <div className="pxg-main">
        <GraphBar c={c} trk={trk} zoom={zoom} setZoom={setZoom} />
        <Canvas nodes={nodes} edges={edges} zoom={zoom} label="Graph of the selected track" />
      </div>
      <Histogram close={<Btn sq label="Close the histogram: the Object Explorer" icon="cross" onClick={() => c.go("explorer")} />}>
        <div className="px-sect">Object types</div>
        <HSec name="OBJECTS" cnt={vess.length + nearP.length + feeds.length + 2}>
          {types.map(([nm, cnt]) => <HRow key={nm} name={nm} cnt={cnt} frac={cnt / mx} icon={typeIcon(nm)} />)}
        </HSec>
        <div className="px-sect">Property values</div>
        {pv.map(([nm, vals]) => {
          const vm = Math.max(1, ...vals.map((v) => v[1]));
          return (
            <HSec key={nm} name={nm} cnt={vals.length}>
              {vals.slice(0, 12).map(([v, cnt]) => <HRow key={v} name={v} cnt={cnt} frac={cnt / vm} />)}
            </HSec>
          );
        })}
      </Histogram>
    </div>
  );
}

/** The Search around state of the same graph. */
export function Graph2({ c }: { c: Ctx }): JSX.Element {
  const [zoom, setZoom] = useState(1);
  const g = graphModel(c);
  if (!g) return <Empty c={c} />;
  const { sel, trk, nearV, feeds, nearP, flag, warnKm, warnT } = g;
  const v5 = [sel, ...nearV.slice(0, 4).map((x) => x.r)];
  const prop = (fn: (r: Row) => string): [string, number, number][] => {
    const m = new Map<string, number>();
    for (const r of v5) m.set(fn(r), (m.get(fn(r)) ?? 0) + 1);
    const sv = fn(sel);
    return [...m.entries()].map(([k, v]): [string, number, number] => [k, v, k === sv ? 1 : 0]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const X = (x: number): number => 60 + (x - 230) * 2.023;
  const Y = (y: number): number => 60 + (y - 185) * 1.53;
  const ctr: [number, number] = [X(499), Y(356)];
  const feed = (i: number): string => feeds[i] ?? feeds[0] ?? "—";
  type Spec = [Kind, number, number, string, string, (() => void) | undefined, string?];
  const nv = (i: number, x: number, y: number): Spec[] => {
    const v = nearV[i];
    return v ? [["vessel", x, y, title(v.r.name), `Nearby ${v.dd.toFixed(1)} km`, () => c.pick(v.r.mmsi)]] : [];
  };
  const np = (i: number, x: number, y: number): Spec[] => {
    const p = nearP[i];
    return p ? [["place", x, y, p.t, `Nearby ${p.d.toFixed(0)} km`, () => { c.setKw(p.t); c.go("browser"); }]] : [];
  };
  const specs: Spec[] = [
    ...(warnKm !== null ? [["doc", 495, 185, warnT, `Nearby ${warnKm.toFixed(0)} km`, () => c.go("inbox")] as Spec] : []),
    ...np(0, 568, 198), ...np(1, 601, 260), ...np(2, 665, 302),
    ["lists", 640, 372, c.sanc ? `${c.sanc.lists.join(", ")}: ${c.sanc.matched ? "match" : "no match"}` : unavailable("Sanctions lookup", c.sancRes), "Looked up in", () => c.go("cov")],
    ["flag", 648, 452, `Flag state ${flag}`, "Flag state", undefined, "Flag state comes from the entity lookup"],
    ["feed", 584, 475, feed(0), "Reported by", undefined], ["feed", 511, 525, feed(1), "Reported by", undefined], ["feed", 424, 466, feed(2), "Reported by", undefined],
    ...nv(0, 381, 433), ...nv(1, 312, 466), ...nv(2, 371, 352), ...nv(3, 230, 360),
  ];
  const nodes: GNode[] = [
    ...specs.map(([kind, x, y, lab, , open, why], i): GNode => ({ id: `n${i}`, kind, x: X(x), y: Y(y), label: lab, open, why: why ?? (kind === "feed" ? `${lab} is an AIS feed in this vessel's sources list` : undefined) })),
    { id: "sel", kind: "vessel", x: ctr[0], y: ctr[1], label: trk, sel: true, photo: g.photo, open: () => c.go("cov") },
  ];
  const edges: GEdge[] = specs.map(([, x, y, , lb]) => ({ a: ctr, b: [X(x), Y(y)], label: lb }));
  const nPlace = Math.min(3, nearP.length), nFeed = Math.min(3, feeds.length);
  const nent = v5.length + nPlace + nFeed + 2;
  const nDoc = warnKm !== null ? 1 : 0;
  const hr = (nm: string, tot: number, s: number, icon: N, denom: number): JSX.Element => <HRow key={nm} name={nm} txt={`${s}/${tot}`} frac={tot / Math.max(denom, 1)} sel={!!s} icon={icon} />;
  const props: [string, (r: Row) => string][] = [["SHIP TYPE", (r) => r.type], ["FLAG STATE", (r) => r.v.flag ?? "—"], ["SOURCE", (r) => r.v.source ?? "—"], ["SPEED OVER GROUND (KN)", (r) => r.sog.toFixed(1)]];
  const M1: [string, string, (() => void) | undefined][] = [
    ["filter-keep", "Add selection as filter", () => c.go("explorer")], ["select", "Select on graph", undefined], ["search-around", "Search around", () => c.go("menubar")],
    ["layout-auto", "Layout", undefined], ["layers", "Layers", () => c.go("gaia")], ["take-action", "Actions", () => c.go("browser")],
  ];
  const M2: [string, string][] = [["style", "Style"], ["edit", "Edit label..."], ["merge-links", "Merge"], ["unlink", "Unresolve"], ["remove", "Remove"]];
  const M3: [string, string, Page][] = [["document", "Documents", "inbox"], ["people", "Entities", "browser"], ["timeline-events", "Events", "timeline"], ["properties", "Properties", "cov"], ["citation", "Record Sourcing", "cov"], ["search-around", "Related artifacts", "browser"]];
  const live = "Not available for a live AIS object";
  const edit = "The graph is drawn from the live records; nodes are not edited here";
  const Item = ({ ic, t, fn, why }: { ic: string; t: string; fn?: (() => void) | undefined; why: string }): JSX.Element => (
    <li><button type="button" className="px-row" aria-label={t} title={fn ? t : why} disabled={!fn} onClick={fn}><Ic n={ic} />{t}</button></li>
  );
  return (
    <div className="px-pg pxg">
      <aside className="px-pane l pxg-menu" aria-label="Search around">
        <div className="px-sect">1 selected item</div>
        <ul>{M1.map(([ic, t, fn]) => <Item key={t} ic={ic} t={t} fn={fn} why={live} />)}</ul>
        <div className="px-sect">1 selected node</div>
        <ul>{M2.map(([ic, t]) => <Item key={t} ic={ic} t={t} why={edit} />)}</ul>
        <div className="px-sect">Search around</div>
        <ul>
          {M3.map(([ic, t, to]) => <Item key={t} ic={ic} t={t} fn={() => c.go(to)} why="" />)}
          <Item ic="more" t="More: the custom object view" fn={() => c.go("cov")} why="" />
          <Item ic="search-text" t="Create new search: the Browser" fn={() => c.go("browser")} why="" />
        </ul>
      </aside>
      <div className="pxg-main">
        <GraphBar c={c} trk={trk} zoom={zoom} setZoom={setZoom} titleGo={() => c.go("menubar")} />
        <Canvas nodes={nodes} edges={edges} arrows zoom={zoom} label="Search around the selected track" />
      </div>
      <Histogram close={<Btn sq label="Close the histogram: the graph document" icon="cross" onClick={() => c.go("menubar")} />}>
        <div className="px-sect">Selected / total</div>
        <HSec name="SUMMARY" cnt={2}>
          {hr("Entity", nent, 1, <span className="pxg-ic" style={{ color: "#4c8bd6" }}><Ic n="circle" s={10} /></span>, nent)}
          {hr("Document", nDoc, 0, <Ic n="document" s={10} />, 1)}
        </HSec>
        <HSec name="ENTITY" cnt={5}>
          {hr("Vessel", v5.length, 1, typeIcon("Vessel"), v5.length)}
          {hr("Place", nPlace, 0, typeIcon("Place"), v5.length)}
          {hr("AIS feed", nFeed, 0, typeIcon("AIS feed"), v5.length)}
          {hr("Flag state", 1, 0, typeIcon("Flag state"), v5.length)}
          {hr("Sanctions lookup", 1, 0, typeIcon("Sanctions lookup"), v5.length)}
        </HSec>
        <HSec name="DOCUMENT" cnt={nDoc}>{hr("NGA warning", nDoc, 0, <Ic n="document" s={10} />, v5.length)}</HSec>
        <div className="px-sect">Property values</div>
        {props.map(([nm, fn]) => {
          const vals = prop(fn);
          return (
            <HSec key={nm} name={nm} cnt={vals.length}>
              {vals.slice(0, 8).map(([v, tot, s]) => <HRow key={v} name={v} txt={`${s}/${tot}`} frac={tot / v5.length} sel={!!s} />)}
            </HSec>
          );
        })}
      </Histogram>
    </div>
  );
}
