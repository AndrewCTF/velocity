// Slides: an incident brief for the searched place, as an outline, the form
// of the open section and a preview of the deck. Hatched chips are fields with
// no source here, left unfilled.
import { useState } from "react";
import { Btn, Ic, type N } from "./kit.js";
import { TRK, hhmm, recorder } from "./data.js";
import type { Ctx } from "./model.js";

// the brief / report-export section list (level, label)
const OUTLINE: [number, string][] = [
  [0, "0. Incident Preliminaries"],
  [1, "a. Incident Information and Additional Products"],
  [1, "b. Five W"],
  [0, "1. Situation"],
  [1, "a. Cluster"],
  [2, "i. Scene Overlay"],
  [1, "b. Nearby Traffic"],
  [0, "2. Assessment"],
  [1, "a. Selected Track"],
  [0, "3. Collection"],
  [1, "a. Concept of Collection"],
  [2, "i. SAR Passes"],
  [2, "ii. AIS Recorder"],
  [2, "iii. Replay Window"],
  [1, "b. Coordinating Instructions"],
  [2, "i. Evidence Capture"],
  [2, "ii. Alert Rules"],
  [1, "c. Timeline"],
  [2, "i. Recorder Timeline"],
  [2, "ii. Data Gaps"],
  [0, "4. Distribution"],
  [1, "a. Report Export"],
  [1, "b. Evidence Locker"],
  [1, "c. Alert Delivery"],
];
const MON = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const p2 = (n: number): string => String(n).padStart(2, "0");

const FIELDS: [string, string, string][] = [
  [
    "Related Stencils",
    "Attach any additional relevant Stencils",
    "Add Related Stencil",
  ],
  ["Related Maps", "Attach any additional relevant Maps", "Add Related Map"],
  [
    "Related Sheets",
    "Attach any additional relevant Sheets",
    "Add Related Sheet",
  ],
  [
    "Additional Products",
    "Attach any additional relevant products (GeoJSON, PDFs, etc.)",
    "Add Product",
  ],
];

const Chip = ({ children }: { children: N }): JSX.Element => (
  <span className="pxs-chip">{children}</span>
);

export function Slides({ c }: { c: Ctx }): JSX.Element {
  const [find, setFind] = useState("");
  const [cur, setCur] = useState(1);
  const now = new Date(c.now * 1000);
  const cao = `${p2(now.getUTCDate())}${MON[now.getUTCMonth()]}${String(now.getUTCFullYear()).slice(2)}`;
  const last = recorder().last || c.now;
  const place = c.place;
  const header = (mid: string): JSX.Element => (
    <div className="pxs-hd">
      <span>
        <Chip>Incident Type</Chip>
      </span>
      <span className="pxs-or">OSINT</span>
      <span>SRC: AIS recorder</span>
      <span>
        CAO: {cao} {hhmm(last).slice(0, -1)} // Status: Draft
      </span>
      <span>{mid}</span>
      <span>
        ORG: <Chip>Org</Chip> - ROLE: <Chip>Position</Chip> - SVOIP:{" "}
        <Chip>SVOIP</Chip>
      </span>
    </div>
  );
  return (
    <div className="px-pg pxs">
      <aside className="px-pane l pxs-out" aria-label="Outline">
        <div className="px-ph">
          <h2>Outline</h2>
        </div>
        <div className="pxs-find">
          <div className="px-inp">
            <Ic n="search" />
            <input
              aria-label="Find form fields"
              placeholder="Find form fields..."
              value={find}
              onChange={(e) => setFind(e.target.value)}
            />
          </div>
        </div>
        <ul>
          {OUTLINE.map(([lv, t], i) => {
            const dim = find && !t.toLowerCase().includes(find.toLowerCase());
            if (lv === 0)
              return (
                <li
                  key={t}
                  className="px-sect"
                  style={dim ? { opacity: 0.55 } : undefined}
                >
                  {t}
                </li>
              );
            return (
              <li key={t}>
                <button
                  type="button"
                  className="px-row pxs-o"
                  style={{
                    paddingLeft: 8 + lv * 12,
                    ...(dim ? { opacity: 0.55 } : {}),
                  }}
                  aria-label={t}
                  title={t}
                  aria-pressed={i === cur}
                  onClick={() => setCur(i)}
                >
                  {t}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="px-pane l pxs-form" aria-label="Form">
        <div className="px-ph">
          <h2>{OUTLINE[cur]![1]}</h2>
        </div>
        <div className="pxs-f">
          <label className="pxs-lb">Brief Type</label>
          <span className="px-mu">Select a brief type for this deck</span>
          <Btn
            label="Brief type"
            icon="caret-down"
            why="No brief type list exists"
            className="pxs-sel"
          >
            Select...
          </Btn>
        </div>
        {FIELDS.map(([t, sub, add]) => (
          <div className="pxs-f" key={t}>
            <label className="pxs-lb">{t}</label>
            <span className="px-mu">{sub}</span>
            <div className="pxs-none px-mu">None added.</div>
            <Btn label={add} icon="add" why="No store feeds this slot">
              {add}
            </Btn>
          </div>
        ))}
      </section>
      <section className="pxs-prev" aria-label="Preview">
        <div className="px-ph">
          <h2>Preview</h2>
          <span className="px-gap" />
          <span className="px-mu">Visual:</span>
          <Btn label="Visual" icon="layers" why="One scene plate: the Gulf">
            Hormuz Gulf
          </Btn>
          <Btn sq label="Print" icon="print" onClick={() => window.print()} />
        </div>
        <div className="pxs-deck">
          <article className="pxs-slide" aria-label="Overview slide">
            {header("Overview")}
            <div className="pxs-bd">
              <div className="pxs-cls">
                <span>The overall classification of this briefing is:</span>
                <b>OSINT</b>
              </div>
              <h2>
                {place
                  ? `${place.name.replace("Lpg", "LPG")} cluster`
                  : "No place searched"}
              </h2>
              <Chip>Incident Type</Chip>
              <p>
                {c.sel
                  ? `${c.res.length} vessels within 10 km, ${TRK(c.sel.mmsi)} nearest track`
                  : `${c.res.length} vessels within 10 km`}
              </p>
              {place ? (
                <p className="px-b">
                  {place.lat.toFixed(4)} N, {place.lon.toFixed(4)} E
                </p>
              ) : null}
              <Chip>Start Time</Chip>
              <b>Status: Draft</b>
              <Chip>Assessment</Chip>
              <hr />
              <Chip>Expanded Purpose</Chip>
            </div>
          </article>
          <article className="pxs-slide pxs-scene" aria-label="Scene slide">
            {header("Scene")}
            <div className="pxs-bd">
              <Chip>Scene Overlay</Chip>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
