// The Gaia home page of the Reports app, laid out natively (it used to be a
// crop of the copied 1920x1080 frame). The data is unchanged: the world map is
// the copy's Natural Earth land plate with live rings, dots and chokepoints
// drawn in its own frame coordinates (mapped onto a 1100x360 viewBox so it
// scales to the column); the table is the live evidence store.
import { useState, type ReactNode } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import {
  UTC,
  chipsOf,
  gx,
  gy,
  unavailable,
  warnRings,
  type Choke,
  type Evid,
  type Res,
} from "./data.js";
import { apiFetch } from "../../../transport/http.js";
import { setDragTitle } from "./drag.js";
import world from "./eu-world.png";
import "./gaia.css";

// the plate's frame origin: world.png is 1100x360 drawn at frame (767, 304)
const OX = 767;
const OY = 304;
const MW = 700; // the plate is 1100 wide but the land ends at ~690 (lon 180)
const MH = 360;
const lx = (lon: number): number => gx(lon) - OX;
const ly = (lat: number): number => gy(lat) - OY;

const GROUPS: [string, [number, number], number, number][] = [
  ["AMERICAS", [-168, -30], 350.0, 498.0],
  ["ATLANTIC AND EUROPE", [-27, 46], 350.0, 498.0],
  ["MIDDLE EAST", [28, 68], 392.0, 538.0],
  ["INDO-PACIFIC", [72, 180], 350.0, 498.0],
];

const shortDate = (iso: string): string => {
  const t = Date.parse(iso) / 1000;
  return Number.isFinite(t) ? UTC(t, "%m/%d/%Y %I:%M %p") : "—";
};
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

async function download(e: Evid): Promise<void> {
  const r = await apiFetch(`/api/evidence/${e.sha256}/blob`);
  if (!r.ok) return;
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = e.filename || `${e.sha256.slice(0, 12)}.bin`;
  a.click();
  URL.revokeObjectURL(url);
}

function Btn({
  icon,
  label,
  onClick,
  why,
  className = "",
  children,
}: {
  icon?: string;
  label: string;
  onClick?: () => void;
  why?: string;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`g-btn ${className}`}
      aria-label={label}
      title={onClick ? label : (why ?? label)}
      disabled={!onClick}
      onClick={onClick}
    >
      {icon && <BpIcon name={icon} size={14} />}
      {children}
    </button>
  );
}

export function GaiaFrame({
  ev,
  chokes,
  chokeRes,
  warns,
  aircraft,
  toMap,
  toChat,
  toReports,
  reload,
}: {
  ev: Res<{ props: Evid }[]> | null;
  chokes: Choke[];
  chokeRes: Res<unknown> | null;
  warns: { y: number; lon: number; lat: number }[];
  aircraft: [number, number][];
  toMap: () => void;
  toChat: () => void;
  toReports: () => void;
  reload: () => void;
}): JSX.Element {
  const [q, setQ] = useState("");
  const [card, setCard] = useState(true);
  const [desc, setDesc] = useState(true);
  const hormuz = chokes.find((c) => c.name === "Strait of Hormuz");
  const needle = q.trim().toLowerCase();
  const rows = (ev?.data ?? [])
    .map((x) => x.props)
    .filter((e) => e.title.toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        (Date.parse(b.captured_at) - Date.parse(a.captured_at)) *
          (desc ? 1 : -1) || 0,
    );
  const NOWHY = "Only the evidence store backs this browser";

  const f = (n: number): string => n.toFixed(1);
  const theatres = GROUPS.map(([lab, [lo0, lo1], y0, y1]) => {
    const x0 = lx(lo0);
    const x1 = lx(lo1);
    const ty0 = y0 - OY;
    const ty1 = y1 - OY;
    const ym = ty0 + (ty1 - ty0) * 0.5;
    const j = 13;
    const d =
      `M${f(x0 + 9)} ${f(ty0)} H${f(x1 - 9)} Q${f(x1)} ${f(ty0)} ${f(x1)} ${f(ty0 + 9)} V${f(ym)} L${f(x1 - j)} ${f(ym + 6)} V${f(ty1 - 9)} Q${f(x1 - j)} ${f(ty1)} ${f(x1 - j - 9)} ${f(ty1)} ` +
      `H${f(x0 + 9)} Q${f(x0)} ${f(ty1)} ${f(x0)} ${f(ty1 - 9)} V${f(ym + 6)} L${f(x0 + j)} ${f(ym)} V${f(ty0 + 9)} Q${f(x0 + j)} ${f(ty0)} ${f(x0 + j + 9)} ${f(ty0)}Z`;
    return { lab, d, cx: x0 + (x1 - x0) / 2, cy: ty0 + 16 };
  });
  const dots = aircraft
    .filter((_, i) => i % 3 === 0)
    .map(([lon, lat]) => [lx(lon), ly(lat)] as const)
    .filter(([x, y]) => x > 3 && x < MW - 3 && y > 2 && y < MH - 8);
  const pct = (x: number, y: number) => ({
    left: `${(x / MW) * 100}%`,
    top: `${(y / MH) * 100}%`,
  });

  return (
    <div className="gaia">
      <div className="g-bar">
        <span className="g-sec">Create</span>
        <Btn
          icon="globe-network"
          label="Create Map"
          onClick={toMap}
          className="g-green"
        >
          Map
        </Btn>
        <Btn
          icon="th"
          label="Create Sheet"
          why="Velocity has no sheet store"
          className="g-green"
        >
          Sheet
        </Btn>
        <Btn
          icon="caret-down"
          label="Sheet options"
          why="Velocity has no sheet store"
          className="g-green g-sq"
        />
        <Btn
          icon="form"
          label="Create Case export"
          onClick={toReports}
          className="g-green"
        >
          Case export
        </Btn>
        <span className="g-gap" />
        <Btn icon="chat" label="Chat" onClick={toChat}>
          Chat
        </Btn>
        <Btn icon="database" label="Latest" onClick={reload}>
          Latest{" "}
          <span className="g-dim">{ev ? `${Math.round(ev.ms)}ms` : "…"}</span>
        </Btn>
        <Btn
          icon="help"
          label="Help"
          why="No help page ships with this build"
          className="g-sq"
        />
      </div>

      <div className="g-top">
        <div className="g-map">
          <div className="g-stage" style={{ aspectRatio: `${MW} / ${MH}` }}>
            <svg viewBox={`0 0 ${MW} ${MH}`} role="img" aria-label="World map">
              <rect width={MW} height={MH} fill="#14181c" />
              <image href={world} width={1100} height={MH} />
              {theatres.map((t) => (
                <path
                  key={t.lab}
                  d={t.d}
                  fill="rgba(120,140,155,.06)"
                  stroke="#8d969d"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {warnRings(warns).map(([x, y], i) => (
                <circle
                  key={`w${i}`}
                  cx={f(x - OX)}
                  cy={f(y - OY)}
                  r="3.1"
                  fill="none"
                  stroke="#e8923a"
                  strokeWidth="1.15"
                  opacity=".9"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {dots.map(([x, y], i) => (
                <circle
                  key={`a${i}`}
                  cx={f(x)}
                  cy={f(y)}
                  r="2.9"
                  fill="#7f8fd6"
                  opacity=".78"
                />
              ))}
              {chokes.map((c) => (
                <circle
                  key={c.name}
                  cx={f(lx(c.lon))}
                  cy={f(ly(c.lat))}
                  r="3"
                  fill="rgba(20,24,28,.6)"
                  stroke="#f0f2f4"
                  strokeWidth="1.3"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            {theatres.map((t) => (
              <span key={t.lab} className="g-theatre" style={pct(t.cx, t.cy)}>
                {t.lab}
              </span>
            ))}
            {hormuz && (
              <button
                type="button"
                className="g-pill"
                aria-label="Preview Strait of Hormuz"
                title="Preview Strait of Hormuz"
                style={pct(lx(hormuz.lon), ly(hormuz.lat) + 30)}
                onClick={() => setCard(true)}
              >
                <BpIcon name="map-marker" size={12} />
                Strait of Hormuz
              </button>
            )}
            <ul className="g-legend">
              <li>
                <i className="g-dot" style={{ background: "#7f8fd6" }} />
                Aircraft
              </li>
              <li>
                <i className="g-ring" style={{ borderColor: "#e8e8e8" }} />
                Chokepoint
              </li>
              <li>
                <i className="g-ring" style={{ borderColor: "#e8923a" }} />
                NGA warning
              </li>
            </ul>
          </div>
        </div>

        {card && (
          <aside className="g-card" aria-label="Region preview">
            <div className="g-card-h">
              <span>Preview</span>
              <button
                type="button"
                className="g-x"
                aria-label="Close preview"
                title="Close preview"
                onClick={() => setCard(false)}
              >
                <BpIcon name="cross" size={14} />
              </button>
            </div>
            <div className="g-card-img">
              <BpIcon name="globe-network" size={44} />
              <span>Map preview not available</span>
            </div>
            <h3>Strait of Hormuz</h3>
            <div className="g-mark">UNCLASSIFIED</div>
            <dl>
              <dt>Vessels in box</dt>
              <dd>
                {hormuz
                  ? `${hormuz.vessels} items`
                  : unavailable("Chokepoints", chokeRes)}
              </dd>
              <dt>Stationary</dt>
              <dd>{hormuz ? `${hormuz.stationary} items` : "—"}</dd>
            </dl>
            <div className="g-presence">
              <BpIcon name="pulse" size={14} />
              Presence not available
            </div>
            <Btn
              icon="share"
              label="Open map"
              onClick={toMap}
              className="g-blue g-wide"
            >
              Open map
            </Btn>
          </aside>
        )}
      </div>

      <div className="g-art">
        <div className="g-tabs" role="tablist">
          <Btn
            icon="duplicate"
            label="All artifacts"
            why={NOWHY}
            className="g-tab"
          >
            All artifacts
          </Btn>
          <Btn
            icon="globe-network"
            label="Maps"
            onClick={toMap}
            className="g-tab"
          >
            Maps
          </Btn>
          <Btn icon="th" label="Datasets" why={NOWHY} className="g-tab">
            Datasets
          </Btn>
          <button
            type="button"
            role="tab"
            aria-selected="true"
            className="g-btn g-tab g-on"
            aria-label="Evidence"
            onClick={() => undefined}
          >
            <BpIcon name="document" size={14} />
            Evidence
          </button>
          <Btn
            icon="document-open"
            label="Reports"
            onClick={toReports}
            className="g-tab"
          >
            Reports
          </Btn>
          <Btn
            icon="lightbulb"
            label="AI briefs"
            why={NOWHY}
            className="g-tab"
          >
            AI briefs
          </Btn>
          <span className="g-gap" />
          <label className="g-search">
            <BpIcon name="search" size={14} />
            <input
              aria-label="Search evidence"
              placeholder="Search evidence"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button
              type="button"
              className="g-x"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => setQ("")}
            >
              <BpIcon name="cross" size={12} />
            </button>
          </label>
        </div>
        <div className="g-body">
          <nav className="g-filters" aria-label="Evidence filters">
            <button
              type="button"
              className="g-f g-on"
              aria-pressed="true"
              onClick={() => setQ("")}
            >
              All evidence
            </button>
            {[
              "Captured by me",
              "Shared with me",
              "Shared with my teams",
              "Favorites",
            ].map((t) => (
              <button
                key={t}
                type="button"
                className="g-f"
                disabled
                title="Open mode has no user identity to filter by"
              >
                {t}
              </button>
            ))}
            <hr />
            <label className="g-chk" title="Every artifact here has a title">
              <input type="checkbox" disabled />
              Show untitled
            </label>
            <label className="g-chk" title="Verification state is not recorded">
              <input type="checkbox" disabled />
              <BpIcon name="pulse" size={12} style={{ color: "#3fa35a" }} />
              Only show verified
            </label>
          </nav>
          <div className="g-table">
            <table>
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>TYPE</th>
                  <th>CREATED BY</th>
                  <th>
                    <button
                      type="button"
                      className="g-sort"
                      aria-label="Sort by last updated"
                      title="Sort by last updated"
                      onClick={() => setDesc((d) => !d)}
                    >
                      LAST UPDATED
                      <BpIcon
                        name={desc ? "sort-desc" : "sort-asc"}
                        size={12}
                      />
                    </button>
                  </th>
                  <th>CLASSIFICATION</th>
                  <th>LABELS</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const [t1, t2] = e.capture_method.split("_");
                  return (
                    <tr
                      key={e.sha256}
                      draggable
                      title={e.title}
                      onDragStart={(d) => {
                        d.dataTransfer.setData("text/plain", e.title);
                        setDragTitle(e.title);
                      }}
                      onDragEnd={() => setDragTitle(null)}
                    >
                      <td className="g-name">
                        <BpIcon
                          name="document"
                          size={14}
                          style={{ color: "#b44fd6" }}
                        />
                        <span>{e.title}</span>
                      </td>
                      <td>
                        {cap(t1 ?? "")}
                        {t2 && <div>{t2}</div>}
                      </td>
                      <td>{e.captured_by || "local"}</td>
                      <td>{shortDate(e.captured_at)}</td>
                      <td>UNCLAS</td>
                      <td>
                        <div className="g-chips">
                          {chipsOf(e).map(([lab, val]) => (
                            <span key={lab} className="g-chip">
                              <b>{lab}:</b> {val}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="g-act">
                        <button
                          type="button"
                          aria-label="Copy SHA-256"
                          title="Copy SHA-256"
                          onClick={() =>
                            void navigator.clipboard?.writeText(e.sha256)
                          }
                        >
                          <BpIcon name="duplicate" size={14} />
                        </button>
                        <button
                          type="button"
                          aria-label="Download artifact"
                          title="Download artifact"
                          onClick={() => void download(e)}
                        >
                          <BpIcon name="export" size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!ev?.ok ? (
              <p className="g-empty g-warn">{unavailable("Evidence", ev)}</p>
            ) : !rows.length ? (
              <p className="g-empty">
                {q ? `No evidence matches "${q}"` : "No evidence captured yet"}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
