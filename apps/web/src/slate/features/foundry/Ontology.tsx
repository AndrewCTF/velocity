// Ontology Manager pages D184-D187 and D190: native reflowing layouts that share
// one shell (toolbar + object nav), on the live schema. The fixed-frame copy
// (gotham/docs/_build_foundry_apps.py sec_d184-d190) is gone; its data, hooks and
// navigation are carried over, its own chrome (logo tile, app title) is not.
import { useState, type ReactNode } from "react";
import { Ii } from "./kit.js";
import "./ontology.css";
import {
  nf,
  useJson,
  why,
  type Binding,
  type Dataset,
  type Schema,
  type Status,
} from "./data.js";
import type { Nav } from "./nav.js";

const KIND_TILE: Record<string, string> = {
  aircraft: "#12a89d",
  vessel: "#2d72d2",
  situation: "#d9822b",
  resource: "#8f56bf",
  incident: "#cd4246",
  evidence: "#5f6b7c",
};
const cap = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const join = (...m: Array<string | null | undefined | false>): string =>
  m.filter(Boolean).join(" · ");
const NOT_EDITED =
  "Base types come from the ontology schema; they are not edited here";
const DOCS = "Documentation is not bundled with this build";

const Learn = (): JSX.Element => (
  <button type="button" className="om-learn" disabled title={DOCS}>
    Learn more
  </button>
);

/** Capability card header: icon, title, description, Learn more, and a chevron when it has a body. */
function OmCard({
  id,
  icon,
  title,
  desc,
  open,
  onToggle,
  children,
}: {
  id: string;
  icon: string;
  title: string;
  desc: string;
  open?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}): JSX.Element {
  return (
    <section className="om-card" aria-labelledby={`om-${id}`}>
      <div className="om-card-h">
        {onToggle ? (
          <button
            type="button"
            className="om-toggle"
            aria-expanded={open}
            onClick={onToggle}
          >
            {Ii(icon, 16, "#5f6b7c")}
            <b id={`om-${id}`}>{title}</b>
            <span>{desc}</span>
          </button>
        ) : (
          <div className="om-toggle">
            {Ii(icon, 16, "#5f6b7c")}
            <b id={`om-${id}`}>{title}</b>
            <span>{desc}</span>
          </div>
        )}
        <Learn />
        {onToggle ? (
          <button
            type="button"
            className="om-chev"
            aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
            onClick={onToggle}
          >
            {Ii(open ? "chevron-down" : "chevron-right", 16, "#5f6b7c")}
          </button>
        ) : null}
      </div>
      {onToggle && open ? <div className="om-card-b">{children}</div> : null}
    </section>
  );
}

function OmRow({
  title,
  desc,
  learn,
  children,
}: {
  title: string;
  desc?: string;
  learn?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="om-row">
      <div>
        <div className="om-row-t">{title}</div>
        {desc || learn ? (
          <div className="om-row-d">
            {desc} {learn ? <Learn /> : null}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function OmSelect({
  label,
  value,
  onChange,
  options,
  clear,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  clear?: boolean;
  placeholder?: string;
}): JSX.Element {
  return (
    <div className="om-sel">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">
          {placeholder ??
            (label.startsWith("Default")
              ? "Choose a value"
              : "Choose a property")}
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {clear && value ? (
        <button
          type="button"
          className="om-clear"
          aria-label={`Clear ${label}`}
          onClick={() => onChange("")}
        >
          {Ii("small-cross", 16, "#5f6b7c")}
        </button>
      ) : null}
    </div>
  );
}

/** A property picker that starts on the schema-bound property (when there is one) and can be cleared. */
function PropPick({
  label,
  options,
  bound,
  tag,
}: {
  label: string;
  options: string[];
  bound?: string | undefined;
  tag?: string;
}): JSX.Element {
  const [v, setV] = useState<string | null>(null);
  const val = v ?? bound ?? "";
  return (
    <div className="om-pick">
      {tag && val && val === bound ? (
        <em className="om-active">{tag}</em>
      ) : null}
      <OmSelect
        label={label}
        value={val}
        onChange={setV}
        options={options}
        clear
      />
    </div>
  );
}

function BaseRow({
  name,
  desc,
  on,
  children,
}: {
  name: string;
  desc: string;
  on?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="om-brow">
      <div className="om-brow-h">
        <input
          type="checkbox"
          checked={!!on}
          readOnly
          disabled
          title={NOT_EDITED}
          aria-label={name}
        />
        <b>{name}</b>
        <span>{"– " + desc}</span>
        <Learn />
      </div>
      {children ? <div className="om-brow-b">{children}</div> : null}
    </div>
  );
}

const NAV_ROWS: Array<[string, string]> = [
  ["desktop", "Overview"],
  ["properties", "Properties"],
  ["shield", "Security"],
  ["database", "Datasources"],
  ["timeline-line-chart", "Observability"],
  ["layers", "Capabilities"],
  ["widget", "Object views"],
  ["edit", "Application styles"],
  ["form", "Interfaces"],
  ["upload", "Materializations"],
  ["flash", "Automations"],
  ["series-derived", "Usage"],
  ["history", "History"],
];

interface ShellProps {
  nav: Nav;
  kind: string;
  icon: string;
  sub: string;
  propCount: number | undefined;
  current: "Capabilities" | "Properties";
  toProps?: () => void;
  toCaps?: () => void;
  actions?: ReactNode;
  notice?: ReactNode;
  noticeAction?: ReactNode;
  children: ReactNode;
}

/** The one native shell every Ontology page shares: toolbar, object nav, scrolling column. */
function OmShell({
  nav,
  kind,
  icon,
  sub,
  propCount,
  current,
  toProps,
  toCaps,
  actions,
  notice,
  noticeAction,
  children,
}: ShellProps): JSX.Element {
  const color = KIND_TILE[kind.toLowerCase()] ?? "#2d72d2";
  // destination per nav row; a row with no page behind it is disabled, not decorative
  const go: Record<string, (() => void) | undefined> = {
    Overview: () => nav.workbench("ontology"),
    Properties: toProps,
    Datasources: () => nav.workbench("datasets"),
    Capabilities: toCaps,
  };
  return (
    <div className="om">
      <header className="om-bar">
        <button type="button" className="om-btn" onClick={nav.menu}>
          {Ii("applications", 16, "#404854")}
          Apps
        </button>
        <button
          type="button"
          className="om-btn om-ghost"
          onClick={() => nav.workbench("home")}
        >
          {Ii("arrow-left", 16, "#404854")}
          Home
        </button>
        <nav className="om-crumb" aria-label="Breadcrumb">
          {"Ontology · "}
          <b>{kind}</b>
        </nav>
        <span className="om-grow" />
        {actions}
        <label className="om-search">
          {Ii("search", 16, "#404854")}
          <input
            type="search"
            placeholder="Search resources"
            disabled
            title="Resource search is not wired to the ontology"
            aria-label="Search resources"
          />
        </label>
        <button
          type="button"
          className="om-btn"
          disabled
          title="Only the Main branch is available here"
        >
          {Ii("git-branch", 16, "#404854")}
          Main
          {Ii("caret-down", 16, "#5f6b7c")}
        </button>
        <button
          type="button"
          className="om-btn"
          disabled
          title="Object types come from the ontology schema; they are not created here"
        >
          New
          {Ii("caret-down", 16, "#5f6b7c")}
        </button>
      </header>
      <div className="om-body">
        <aside className="om-nav">
          <div className="om-obj">
            <span className="om-tile" style={{ background: `${color}26` }}>
              {Ii(icon, 18, color)}
            </span>
            <div>
              <div className="om-obj-n">{kind}</div>
              <div className="om-obj-c">{sub}</div>
            </div>
          </div>
          <ul>
            {NAV_ROWS.map(([ic, lab]) => {
              const f = go[lab];
              const cur = lab === current;
              const bad =
                lab === "Properties"
                  ? propCount
                    ? String(propCount)
                    : "—"
                  : lab === "Security"
                    ? "New"
                    : "";
              return (
                <li key={lab}>
                  <button
                    type="button"
                    className="om-nav-i"
                    aria-current={cur ? "page" : undefined}
                    disabled={!f}
                    onClick={f}
                    title={
                      f
                        ? undefined
                        : cur
                          ? "This page"
                          : `${lab} is not part of this build`
                    }
                  >
                    {Ii(ic, 16, cur ? "#215db0" : "#404854")}
                    <span>{lab}</span>
                    {bad === "New" ? (
                      <em className="om-new">New</em>
                    ) : bad ? (
                      <em className="om-count">{bad}</em>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <div className="om-main">
          {notice ? (
            <div className="om-notice">
              {Ii("info-sign", 16, "#5f6b7c")}
              <span>{notice}</span>
              <span className="om-grow" />
              {noticeAction}
            </div>
          ) : null}
          <div className="om-scroll">
            <div className="om-col">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const Err = ({ msg }: { msg: string }): JSX.Element | null =>
  msg ? <p className="om-err">{msg}</p> : null;

export function D184({ nav }: { nav: Nav }): JSX.Element {
  const sc = useJson<Schema>("/api/ontology/schema");
  const si = useJson<unknown[]>("/api/situations");
  const [open, setOpen] = useState(true);
  const props = Object.keys(sc?.data?.kinds.situation ?? {});
  const n = si?.data?.length;
  return (
    <OmShell
      nav={nav}
      kind="Situation"
      icon="warning-sign"
      sub={n === undefined ? "—" : `${nf(n)} objects`}
      propCount={props.length}
      current="Capabilities"
    >
      <Err msg={join(why("Ontology schema", sc), why("Situations", si))} />
      <OmCard
        id="base"
        icon="hat"
        title="Base Types"
        desc=""
        open={open}
        onToggle={() => setOpen((v) => !v)}
      >
        <>
          <BaseRow
            name="Time Series"
            desc="each Object represents a series of values over time."
          />
          <BaseRow
            name="Event"
            desc="each Object represents a single interval of time, optionally with associated information."
          />
          <BaseRow
            name="Vertex"
            desc="each Object represents a node or edge in the Vertex Graph view."
          />
          <BaseRow
            name="Geospatial"
            desc="each Object represents a geospatial feature."
            on
          >
            <OmRow
              title="Altitude"
              desc="Numeric property specifying altitude/elevation of each Object in metres"
            >
              <PropPick label="Altitude" options={props} />
            </OmRow>
            {/* Radius is bound to the schema's radius_km (kilometres, hence the helper text) */}
            <OmRow
              title="Radius"
              desc="Numeric property specifying the radius in kilometres, to render object as circles - must also have a 'Geo' property indicating the center of the circle"
            >
              <PropPick
                label="Radius"
                options={props}
                bound={props.includes("radius_km") ? "radius_km" : undefined}
                tag="Active"
              />
            </OmRow>
            <OmRow
              title="H3 cell"
              desc="String property, or array of strings, containing H3 cell IDs."
              learn
            >
              <PropPick label="H3 cell" options={props} />
            </OmRow>
          </BaseRow>
        </>
      </OmCard>
    </OmShell>
  );
}

const Chip = ({
  color,
  icon,
  label,
}: {
  color: string;
  icon: string;
  label: string;
}): JSX.Element => (
  <span className="om-chip">
    <i style={{ background: color }}>{Ii(icon, 12, "#fff")}</i>
    {label}
  </span>
);

const INTENTS = ["primary", "success", "warning", "danger"];

export function D185({ nav }: { nav: Nav }): JSX.Element {
  const sc = useJson<Schema>("/api/ontology/schema");
  const st = useJson<Status>("/api/status");
  const [open, setOpen] = useState(true);
  const [intent, setIntent] = useState("primary");
  const [unit, setUnit] = useState("");
  const props = Object.keys(sc?.data?.kinds.aircraft ?? {});
  const nAc = st?.data?.aircraft_count;
  // the linked object is the schema relation designated_by (aircraft to org)
  const rel = sc?.data?.relations.designated_by;
  const has = (p: string): string | undefined =>
    props.includes(p) ? p : undefined;
  const saveWhy = "Nothing edited: capabilities are read from the live schema";
  return (
    <OmShell
      nav={nav}
      kind="Aircraft"
      icon="airplane"
      sub={nAc === undefined ? "—" : `${nf(nAc)} objects`}
      propCount={props.length}
      current="Capabilities"
      actions={
        <>
          <button type="button" className="om-btn" disabled title={saveWhy}>
            Discard
          </button>
          <button
            type="button"
            className="om-btn om-save"
            disabled
            title={saveWhy}
          >
            Save
          </button>
        </>
      }
    >
      <Err msg={join(why("Ontology schema", sc), why("Status", st))} />
      <OmCard
        id="base"
        icon="hat"
        title="Base Types"
        desc=""
        open={open}
        onToggle={() => setOpen((v) => !v)}
      >
        <>
          <BaseRow
            name="Time Series"
            desc="each Object represents a series of values over time."
          />
          <BaseRow
            name="Event"
            desc="each Object represents a single interval of time, optionally with associated information."
            on
          >
            <OmRow
              title="Event start time"
              desc="Time at which the event begins"
            >
              <PropPick
                label="Event start time"
                options={props}
                bound={has("seen_at")}
              />
            </OmRow>
            <OmRow title="Event end time" desc="Time at which the event ends">
              <PropPick label="Event end time" options={props} />
            </OmRow>
            <OmRow
              title="Linked object"
              desc="Associates events with another object type."
              learn
            >
              {rel ? (
                <span className="om-links">
                  <Chip
                    color={KIND_TILE.aircraft!}
                    icon="airplane"
                    label="Aircraft"
                  />
                  {Ii("link", 14, "#5f6b7c")}
                  <Chip
                    color={KIND_TILE.resource!}
                    icon="office"
                    label={cap(rel.dst_kinds[0] ?? "")}
                  />
                </span>
              ) : (
                <span className="om-none">{"—"}</span>
              )}
            </OmRow>
            <OmRow
              title="Linked series ID"
              desc="Associates events with Time Series."
              learn
            >
              <PropPick label="Linked series ID" options={props} />
            </OmRow>
            <OmRow title="Description" desc="Textual description of the event">
              <PropPick
                label="Description"
                options={props}
                bound={has("callsign")}
              />
            </OmRow>
            <OmRow title="Event intent" desc="Severity of the event">
              <OmSelect
                label="Event intent"
                value={intent}
                onChange={setIntent}
                options={INTENTS}
                clear
                placeholder="Choose an intent"
              />
            </OmRow>
            <OmRow title="Event value" desc="Numeric value of the event">
              <PropPick label="Event value" options={props} />
            </OmRow>
            <OmRow
              title="Event value unit"
              desc="Unit of measurement for numeric value of the event"
            >
              <input
                className="om-input"
                type="text"
                aria-label="Event value unit"
                placeholder="Type a value..."
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              />
            </OmRow>
          </BaseRow>
        </>
      </OmCard>
    </OmShell>
  );
}

export function D186({ nav }: { nav: Nav }): JSX.Element {
  const sc = useJson<Schema>("/api/ontology/schema");
  const dsR = useJson<Dataset[]>("/api/foundry/datasets");
  const [baseOpen, setBaseOpen] = useState(true);
  const [saOpen, setSaOpen] = useState(true);
  const [merge, setMerge] = useState(false);
  const ds = dsR?.data?.find((d) => d.name === "ref_country_osint_resources");
  const sch = ds?.schema.map((c) => c.name) ?? [];
  const rels = Object.entries(sc?.data?.relations ?? {});
  const inc = rels.find(([, v]) => v.dst_kinds.includes("resource"));
  const out = rels.find(([, v]) => v.src_kinds.includes("resource"));
  const links = (
    title: string,
    desc: string,
    rel: (typeof rels)[number] | undefined,
  ): JSX.Element => (
    <OmRow title={title} desc={desc} learn>
      <span className="om-links">
        {rel ? (
          <span className="om-rel">
            <span>
              {cap(rel[1].src_kinds[0] ?? "")} {"→"}{" "}
              {cap(rel[1].dst_kinds[0] ?? "")}
            </span>
            <code>{rel[0]}</code>
            <em className="om-active">Active</em>
          </span>
        ) : null}
        <button
          type="button"
          className="om-btn om-add"
          disabled
          title="Link merges come from the ontology schema; they are not added here"
        >
          {Ii("add", 16, "#215db0")}
          Add new entry
        </button>
      </span>
    </OmRow>
  );
  return (
    <OmShell
      nav={nav}
      kind="Resource"
      icon="link"
      sub={ds ? `${nf(ds.row_count)} rows` : "—"}
      propCount={sch.length}
      current="Capabilities"
    >
      <Err
        msg={join(
          why("Ontology schema", sc),
          why("Foundry datasets", dsR),
          dsR?.ok && !ds && "Dataset ref_country_osint_resources not found",
        )}
      />
      <OmCard
        id="base"
        icon="hat"
        title="Base Types"
        desc=""
        open={baseOpen}
        onToggle={() => setBaseOpen((v) => !v)}
      >
        <>
          <BaseRow
            name="Time Series"
            desc="each Object represents a series of values over time."
          />
          <BaseRow
            name="Event"
            desc="each Object represents a single interval of time, optionally with associated information."
          />
          <BaseRow
            name="Geospatial"
            desc="each Object represents a geospatial feature."
          />
        </>
      </OmCard>
      <OmCard
        id="sa"
        icon="search-around"
        title="Search Around"
        desc="Configure specific Search Around behavior for the Vertex and Map applications"
        open={saOpen}
        onToggle={() => setSaOpen((v) => !v)}
      >
        <>
          <OmRow
            title="Link merge always"
            desc="Treat this Object Type as a Relation: skip over it when link-traversing"
          >
            <div className="om-seg" role="group" aria-label="Link merge always">
              <button
                type="button"
                aria-pressed={!merge}
                onClick={() => setMerge(false)}
              >
                Off
              </button>
              <button
                type="button"
                aria-pressed={merge}
                onClick={() => setMerge(true)}
              >
                On
              </button>
            </div>
          </OmRow>
          {links(
            "Incoming links to merge",
            "Relations ending at this Object Type, to be skipped over when link-traversing.",
            inc,
          )}
          {links(
            "Outgoing links to merge",
            "Relations starting at this Object Type, to be skipped over when link-traversing.",
            out,
          )}
        </>
      </OmCard>
    </OmShell>
  );
}

const OBJ_PANELS = ["Overview", "Properties", "History", "Dossier"];

export function D187({ nav }: { nav: Nav }): JSX.Element {
  const sc = useJson<Schema>("/api/ontology/schema");
  const st = useJson<Status>("/api/status");
  const bR = useJson<Binding[]>("/api/foundry/bindings");
  const dR = useJson<Dataset[]>("/api/foundry/datasets");
  const [vertexOpen, setVertexOpen] = useState(true);
  const [offlineOpen, setOfflineOpen] = useState(true);
  const [offline, setOffline] = useState(false);
  const [panel, setPanel] = useState("");
  const [imgProp, setImgProp] = useState("");
  const [annProp, setAnnProp] = useState("");
  const props = Object.keys(sc?.data?.kinds.vessel ?? {});
  const bnd = bR?.data?.[0];
  const dsn = bnd ? dR?.data?.find((d) => d.id === bnd.dataset_id) : undefined;
  const nVes = st?.data?.vessel_count;
  const e = join(
    why("Ontology schema", sc),
    why("Status", st),
    why("Foundry datasets", dR),
  );
  const notice =
    bnd && dsn ? (
      <>
        This object type is bound to the Foundry dataset{" "}
        <span className="om-link">{dsn.name}</span> by binding {bnd.id}.
      </>
    ) : (
      (why("Foundry bindings", bR) ??
      (bR?.ok ? "This object type has no Foundry binding." : "—"))
    );
  return (
    <OmShell
      nav={nav}
      kind="Vessel"
      icon="ship"
      sub={nVes === undefined ? "—" : `${nf(nVes)} objects`}
      propCount={props.length}
      current="Capabilities"
      toProps={() => nav.go("d190")}
      notice={notice}
      noticeAction={
        <button
          type="button"
          className="om-btn"
          disabled={!dsn}
          title={dsn ? "Open the bound dataset" : "No bound dataset"}
          onClick={dsn ? () => nav.workbench("datasets") : undefined}
        >
          Open
          {Ii("th", 16, "#5f6b7c")}
        </button>
      }
    >
      <Err msg={e} />
      <section className="om-card">
        <div className="om-card-h">
          <div className="om-toggle">
            {Ii("globe", 16, "#5f6b7c")}
            <span>Each Object represents a geospatial feature.</span>
          </div>
          <Learn />
        </div>
      </section>
      <OmCard
        id="sa"
        icon="search-around"
        title="Search Around"
        desc="Configure specific Search Around behavior for the Vertex and Map applications"
      />
      <OmCard
        id="vertex"
        icon="graph"
        title="Vertex"
        desc="Each Object is the title object for a Vertex graph"
        open={vertexOpen}
        onToggle={() => setVertexOpen((v) => !v)}
      >
        <>
          <OmRow
            title="Default Object Selection Panel"
            desc="Sets the default panel to show in the object selection view"
          >
            <OmSelect
              label="Default Object Selection Panel"
              value={panel}
              onChange={setPanel}
              options={OBJ_PANELS}
              clear
            />
          </OmRow>
          <OmRow
            title="Key Measure"
            desc="Measures listed here will display on the Vertex home page."
          />
          <OmRow
            title="Vertex Promoted Graphs"
            desc="Graph RIDs listed here will display on the Vertex home page along with the associated object"
          />
          <OmRow
            title="Image reference property"
            desc="If specified: This media reference is used by default for media layers as the image shown on the node"
          >
            <OmSelect
              label="Image reference property"
              value={imgProp}
              onChange={setImgProp}
              options={props}
            />
          </OmRow>
          <OmRow
            title="Image annotation coordinate property"
            desc="If specified: This property is used by default to determine the image annotation placement relative to the parent image"
          >
            <OmSelect
              label="Image annotation coordinate property"
              value={annProp}
              onChange={setAnnProp}
              options={props}
            />
          </OmRow>
          <div className="om-sub">
            <b>Modeling and simulation</b>{" "}
            <span>
              configure series behavior in the Vertex modeling and simulation
              platform
            </span>
          </div>
        </>
      </OmCard>
      <OmCard
        id="offline"
        icon="feed"
        title="Offline App Sync"
        desc=""
        open={offlineOpen}
        onToggle={() => setOfflineOpen((v) => !v)}
      >
        <OmRow
          title="Enable offline app sync for this object type"
          desc="This setting enables offline syncing of this object type for embedded ontology apps"
        >
          <button
            type="button"
            role="switch"
            aria-checked={offline}
            aria-label="Enable offline app sync"
            className="om-switch"
            onClick={() => setOffline((v) => !v)}
          />
        </OmRow>
      </OmCard>
      <OmCard
        id="sched"
        icon="calendar"
        title="Dynamic Scheduling"
        desc="Create a dynamic scheduling workflow with your ontology object types."
      />
    </OmShell>
  );
}

const BASE_TYPE: Record<string, string> = {
  id: "Identifier",
  str: "String",
  num: "Number",
  ts: "Timestamp",
  bool: "Boolean",
  geo: "Geopoint",
};
const TABS = ["General", "Source", "Display", "Interaction", "Details"];
const RO = "Properties come from the ontology schema; they are not edited here";

const RoSwitch = ({
  label,
  on,
}: {
  label: string;
  on: boolean;
}): JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    className="om-switch"
    disabled
    title={RO}
  />
);

/** Property editor for the vessel `mmsi` property, read from the live schema. */
export function D190({ nav }: { nav: Nav }): JSX.Element {
  const sc = useJson<Schema>("/api/ontology/schema");
  const props = sc?.data?.kinds.vessel ?? {};
  const names = Object.keys(props);
  const ptype = props.mmsi;
  return (
    <OmShell
      nav={nav}
      kind="Vessel"
      icon="ship"
      sub="mmsi"
      propCount={names.length}
      current="Properties"
      toCaps={() => nav.go("d187")}
      notice={RO}
    >
      <Err msg={why("Ontology schema", sc) ?? ""} />
      <section className="om-card">
        <div className="om-card-h">
          <button
            type="button"
            className="om-btn"
            onClick={() => nav.go("d187")}
            title="Back to the Vessel object type"
          >
            {Ii("arrow-left", 16, "#404854")}
            Back
          </button>
          <span className="om-propid">
            {Ii("citation", 16, "#404854")}
            mmsi
          </span>
          <span className="om-grow" />
          <button
            type="button"
            className="om-btn om-danger"
            disabled
            title={RO}
          >
            {Ii("trash", 16, "#ac2f33")}
            Delete
          </button>
        </div>
        <div className="om-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === "General"}
              disabled={t !== "General"}
              title={
                t === "General" ? undefined : `${t} is not part of this build`
              }
            >
              {t}
            </button>
          ))}
        </div>
      </section>
      <section className="om-card" aria-label="Overview">
        <div className="om-card-h">
          <b className="om-h">Overview</b>
        </div>
        <div className="om-card-b">
          <OmRow title="Name">
            <input
              className="om-input"
              type="text"
              aria-label="Name"
              readOnly
              value={ptype ? "mmsi" : ""}
              placeholder="—"
              title={RO}
            />
          </OmRow>
          <OmRow title="Description">
            <textarea
              className="om-input om-area"
              aria-label="Description"
              disabled
              rows={3}
              title={RO}
            />
          </OmRow>
          <OmRow title="Base type">
            {/* the schema's own type token for mmsi ('id', the identifier type) */}
            <select
              className="om-input"
              aria-label="Base type"
              disabled
              title={RO}
            >
              <option>
                {ptype ? `${BASE_TYPE[ptype] ?? ptype} (${ptype})` : "—"}
              </option>
            </select>
          </OmRow>
          <OmRow title="Allow multiple">
            <RoSwitch label="Allow multiple" on={false} />
          </OmRow>
          <OmRow title="Value type">
            <select
              className="om-input"
              aria-label="Value type"
              disabled
              title={RO}
            >
              <option>No value type set</option>
            </select>
          </OmRow>
          <OmRow title="Status">
            <span className="om-none">Not exposed</span>
          </OmRow>
        </div>
      </section>
      <section className="om-card" aria-label="Configuration">
        <div className="om-card-h">
          <b className="om-h">Configuration</b>
        </div>
        <div className="om-card-b">
          <OmRow
            title="Title key"
            desc={`Current: ${props.name ? "name" : "—"}`}
          >
            <RoSwitch label="Title key" on={false} />
          </OmRow>
          {/* mmsi is the identity key of the vessel kind (schema type 'id') */}
          <OmRow title="Primary key" desc={`Current: ${ptype ? "mmsi" : "—"}`}>
            <RoSwitch label="Primary key" on={ptype === "id"} />
          </OmRow>
          <OmRow title="Required">
            <RoSwitch label="Required" on={false} />
          </OmRow>
        </div>
      </section>
    </OmShell>
  );
}
