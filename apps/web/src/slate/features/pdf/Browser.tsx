// Browser: a keyword search over the nearest-place property, its result list
// and the selected object's view. The bulk Actions menu opens under the list.
import { useState } from "react";
import { Btn, Ic, Ship, hit } from "./kit.js";
import { ObjectView } from "./ObjectView.js";
import { nProps, unavailable } from "./data.js";
import type { Ctx } from "./model.js";

export function Browser({ c }: { c: Ctx }): JSX.Element {
  const [draft, setDraft] = useState(c.kw);
  const [menu, setMenu] = useState(false);
  const sel = c.sel;
  const ham = c.place?.name ?? "";
  const shown = c.list.slice(0, 10);
  const n = shown.length;
  type Item = [string, string, (() => void) | undefined, string];
  const items: (string | Item)[] = [
    "For all results (up to 10,000)",
    ["Open all objects in new tab", "arrow-top-right", undefined, "Objects open in this window"],
    ["Add all objects to map", "send-to-map", undefined, "The map already draws every hull in the box"],
    ["Add all objects to new list", "list", undefined, "No object list store exists"],
    `For current results (${n})`,
    [`Add ${n} objects to list`, "list", undefined, "No object list store exists"],
    ["Remove from list", "list", undefined, "The results are not a list"],
    [`Download ${n} objects as .docx`, "download", undefined, "No .docx exporter exists; export a report from Reports"],
    [`Delete ${n} objects`, "cross-circle", undefined, "Live AIS objects cannot be deleted"],
    ["Open in new tab", "", undefined, "Objects open in this window"],
    ["Open in new window", "", undefined, "Objects open in this window"],
    ["Search using title", "", sel ? () => { setDraft(sel.name); setMenu(false); } : undefined, "No object selected"],
    ["Add to dossier", "document", () => c.go("dossier"), ""],
    ["Add to graph", "send-to-graph", () => c.go("menubar"), ""],
  ];
  return (
    <div className="px-pg pxb">
      <div className="pxb-top">
        <Btn label="All results: the exploration" icon="arrow-left" onClick={() => c.go("explorer")}>All results</Btn>
        <b>Objects</b>
        <span className="px-mu">Showing {n} of {c.res.length} results</span>
        <span className="px-gap" />
        <Btn sq label="Share" icon="share" why="No share list exists for searches" />
      </div>
      <div className="pxb-cols">
        <aside className="px-pane l pxb-filters" aria-label="Filters">
          <div className="px-sect"><Ic n="filter" s={12} /> Filters</div>
          <div className="pxb-f">
            <label className="px-b" htmlFor="pxb-kw">Keyword <span className="px-mu">matches</span></label>
            <div className="px-inp">
              <Ic n="search" />
              <input id="pxb-kw" aria-label="Keyword" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") c.setKw(draft); }} />
            </div>
          </div>
          <div className="pxb-f">
            <span className="px-b">Object Type <span className="px-mu">is any of</span></span>
            <span className="px-chip">Vessel</span>
          </div>
          <div className="pxb-f">
            <Btn label="Add date" why="The box pull carries only each hull's latest fix, so there is no date to filter" className="lnk">+ Add date</Btn>
            <Btn label="Add location" why="The location is the keyword's place and the 10 km radius" className="lnk">+ Add location</Btn>
            <Btn label="Add property" why="Property filters live in the exploration's filter path" className="lnk">+ Add property...</Btn>
          </div>
          <div className="pxb-f">
            <Btn pri label="Search" onClick={() => c.setKw(draft)}>Search</Btn>
          </div>
          {!c.place ? <p className="px-empty">{c.ports.length ? `No place in the recorder box matches "${c.kw}"` : unavailable("Ports", null)}</p> : null}
          <span className="px-gap" />
          <div className="pxb-f pxb-alert">
            <Btn label="Create search alert" icon="notifications-add" why="Alert rules are areas, not keywords; add one from the alert rules list">Create search alert</Btn>
          </div>
        </aside>
        <section className="px-pane l pxb-list" aria-label="Results">
          <div className="px-ph">
            <span className="px-mu">Sorted by <b className="pxb-sort">relevance</b></span>
            <span className="px-gap" />
            <Btn label="Actions" icon="caret-down" on={menu} onClick={() => setMenu((m) => !m)}>Actions</Btn>
          </div>
          {menu ? (
            <div className="pxb-menu" role="menu" aria-label="Bulk actions">
              {items.map((it) =>
                typeof it === "string" ? (
                  <div key={it} className="pxb-mh">{it}</div>
                ) : (
                  <button key={it[0]} type="button" role="menuitem" className="pxb-mi" aria-label={it[0]} title={it[2] ? it[0] : (it[3] || it[0])} disabled={!it[2]} onClick={it[2]}>
                    {it[1] ? <Ic n={it[1]} /> : <span className="pxb-ph" />}
                    {it[0]}
                  </button>
                ),
              )}
              <Btn label="Close the actions menu" icon="cross" sq onClick={() => setMenu(false)} />
            </div>
          ) : null}
          <ul>
            {shown.map((r) => (
              <li key={r.mmsi}>
                <button type="button" className="pxb-res" aria-label={`Open ${r.name}`} title={`Open ${r.name}`} aria-pressed={r === sel} onClick={() => c.pick(r.mmsi)}>
                  <Ship s={18} />
                  <span className="pxb-rt">
                    <b>{r.name}</b>
                    <span className="px-mu">Vessel · {nProps(r.v)} properties</span>
                    <span><span className="px-mu">Nearest place </span>{hit(ham, c.kw)}</span>
                    <span><span className="px-mu">Ship type </span>{r.type}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <ObjectView c={c} where="browser" />
      </div>
    </div>
  );
}
