// Object Explorer: the live recorder box as a filter path. Left, the property
// list and the value histogram of the picked property; right, the filter path
// with its steps; the sentence bar under the results adds the Origin step.
import { useState } from "react";
import { Btn, Ic, Tab } from "./kit.js";
import { funnel, propCounts, unavailable, valueHist, type Step } from "./data.js";
import type { Ctx } from "./model.js";

const STEP_TXT: Record<Step, [string, string]> = {
  box: ["Keeping Objects with Last fix", "within the recorder box"],
  radius: ["Keeping Objects with Last fix", "within 10 km of"],
  stationary: ["Keeping Objects with Speed", "over ground matching any of"],
  origin: ["Keeping Objects with property", "types matching any of"],
};

export function Explorer({ c }: { c: Ctx }): JSX.Element {
  const [steps, setSteps] = useState<Step[]>(["box", "radius", "stationary"]);
  const [prop, setProp] = useState("Origin");
  const place = (c.place?.name ?? "").replace("Lpg", "LPG");
  const { stages, set } = funnel(c.status?.vessel_count ?? 0, c.box, c.place, steps);
  const props = propCounts(set);
  const nprop = props.reduce((a, p) => a + p[1], 0);
  const vals = valueHist(set, prop);
  const top = Math.max(props[0]?.[1] ?? 1, 1);
  const topn = Math.max(1, ...vals.map((t) => t[1]));
  const canAdd = prop === "Origin" && !steps.includes("origin") && steps.length < 4;
  return (
    <div className="px-pg pxe">
      <section className="px-pane pxe-main" aria-label="Results">
        <div className="px-ph">
          <Ic n="database" />
          <h2>Results</h2>
          <span className="px-gap" />
          <span className="px-mu">{set.length} objects</span>
        </div>
        <div className="px-tabs">
          <Tab label="Types" badge={set.length} why="Every object in this set is a Vessel" />
          <Tab label="Properties" badge={nprop} current />
          <Tab label="Links" badge={0} why="Links of one object live in its object view" />
          <Tab label="Timeline" why="The box pull carries only each hull's latest fix" />
          <Tab label="Search: the Browser" icon="search" onClick={() => c.go("browser")} />
          <span className="px-gap" />
          <span className="px-mu">View as Histogram chart</span>
        </div>
        <div className="pxe-split">
          <div className="px-pane l pxe-props">
            <div className="px-sect">Object properties</div>
            {!c.boxRes?.ok ? <p className="px-empty">{unavailable("AIS box", c.boxRes)}</p> : null}
            <ul>
              {props.slice(0, 15).map(([nm, cnt]) => (
                <li key={nm}>
                  <button type="button" className="px-row pxe-prop" aria-label={`Histogram of ${nm}`} title={`Histogram of ${nm}`} aria-pressed={nm === prop} onClick={() => setProp(nm)}>
                    <span className="pxe-nm">{nm}</span>
                    <span className="px-mu pxe-n">{cnt}</span>
                    <span className="px-bar-t pxe-bt"><i style={{ width: `${(100 * cnt) / top}%` }} /></span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="px-pane pxe-vals">
            <div className="px-sect">{prop}</div>
            <ul>
              {vals.slice(0, 100).map(([nm, cnt]) => (
                <li key={nm} className="pxe-val">
                  <span className="pxe-nm" title={nm}>{nm}</span>
                  <span className="px-mu pxe-n">{cnt}</span>
                  <span className="px-bar-t"><i style={{ width: `${Math.max(1, (100 * cnt) / topn)}%` }} /></span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <footer className="pxe-filter">
          <Btn label="Filter property type" icon="caret-down" why="Pick a property in the list on the left">Filter property type</Btn>
          <span>
            <b className="px-lk">Keeping</b> Objects with property types matching any of <span className="pxe-term">{prop}</span>
          </span>
          <span className="px-gap" />
          <Btn label="Clear selection" onClick={prop !== "Origin" ? () => setProp("Origin") : undefined} why="Origin is the default selection">Clear selection</Btn>
          <Btn
            pri
            icon="filter"
            label="Add to filter path"
            onClick={canAdd ? () => setSteps((s) => [...s, "origin"]) : undefined}
            why={prop === "Origin" ? "Origin is already on the filter path" : "Only the Origin property has a filter step"}
          >
            Add to filter path
          </Btn>
        </footer>
      </section>
      <aside className="px-pane r pxe-side" aria-label="Filter path">
        <div className="px-ph">
          <Btn label="Back to home: the Browser" icon="chevron-left" onClick={() => c.go("browser")}>Back to home</Btn>
        </div>
        <div className="pxe-ttl">
          <Ic n="layers" />
          <b>New exploration</b>
          <span className="px-gap" />
          <Btn label="Save" why="Explorations are not stored; the filter path lives while this app is open">Save</Btn>
        </div>
        <div className="px-mu pxe-src">Source: All objects</div>
        <div className="pxe-fp">
          <b>Filter path</b>
          <span className="px-gap" />
          <Btn label="Clear all" onClick={steps.length ? () => setSteps([]) : undefined} why="The filter path is empty">Clear all</Btn>
        </div>
        <ol className="pxe-steps">
          {stages.map((sg) => {
            const lines = STEP_TXT[sg.step];
            const term = sg.step === "radius" ? place : sg.step === "stationary" ? "0.0 kn" : sg.step === "origin" ? "Origin" : null;
            return (
              <li key={sg.step} className="pxe-step">
                <Ic n="filter-keep" />
                <div>
                  {lines.map((l) => <div key={l}>{l}</div>)}
                  {term ? <span className="pxe-term">{term}</span> : null}
                  <div className="px-mu pxe-cnt"><span>Objects</span><span>{sg.from.toLocaleString("en")} → {sg.to.toLocaleString("en")}</span></div>
                </div>
                <Btn sq label={`Remove the step: ${lines.join(" ")}`} icon="cross" onClick={() => setSteps((s) => s.filter((x) => x !== sg.step))} />
              </li>
            );
          })}
        </ol>
        <span className="px-gap" />
        <div className="pxe-res">
          <div className="pxe-ttl"><Ic n="database" /><b>Results</b></div>
          <Btn label="View results: the Browser" onClick={() => c.go("browser")}>View results <span className="px-badge">{set.length}</span></Btn>
          <Btn pri label="Actions: the Browser's bulk actions" icon="caret-down" onClick={() => c.go("browser")}>Actions</Btn>
        </div>
      </aside>
    </div>
  );
}
