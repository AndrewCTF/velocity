// TITAN ground-station console: features A44-A53 and A65 as a native layout
// over this box: feeds (/api/status), upstream hosts (/api/status/sources),
// the AIS pipeline store, and the host's own devices and listening processes
// (/api/status/host; the Rx rate is two of its pulls one second apart, as the
// builder read /proc/net/dev twice).
import { useEffect, useState, type ReactNode } from "react";
import { Chip, Ico, type FoundryNav } from "./pg.js";
import { DkPage } from "./dk.js";
import {
  comma,
  dmy,
  fetchJson,
  unavailable,
  useJson,
  type Res,
} from "./data.js";
import {
  AIS_KEYS,
  FAMS,
  age,
  clock,
  cpuName,
  devices,
  groups,
  gstate,
  hostRec,
  lastOk,
  nicNames,
  nodash,
  tC,
  type Dev,
  type Engines,
  type Feed,
  type Group,
  type Host,
  type Src,
  type Status,
} from "./dataB.js";
import plateGlobe from "./plateGlobe.jpg";

export type TitanTab =
  | "Overview"
  | "Data connections"
  | "Power management"
  | "Hardware management"
  | "Software management";
const TABS: [TitanTab, string][] = [
  ["Overview", "timeline-bar-chart"],
  ["Data connections", "data-connection"],
  ["Power management", "power"],
  ["Hardware management", "wrench"],
  ["Software management", "floppy-disk"],
];
const NAMES: [string, string][] = [
  ["shipxplorer", "ShipXplorer"],
  ["vesselfinder", "VesselFinder"],
  ["openwaters", "OpenWaters"],
  ["meri.digitraffic", "Digitraffic"],
  ["kystdatahuset", "Kystdatahuset"],
];
const SVC_ICON = {
  healthy: ["tick-circle", "ok"],
  warning: ["warning-sign", "warn"],
  failed: ["error", "bad"],
  offline: ["power", "mut"],
} as const;
type SK = keyof typeof SVC_ICON;

interface Ctx {
  st: Res<Status> | null;
  src: Res<{ sources: Src[] }> | null;
  feeds: Feed[];
  srcs: Src[];
  host: Host | null;
  hostRes: Res<Host> | null;
  rx: number | null;
  nic: string | null;
  devs: Dev[];
  grps: Group[];
  pipe: {
    store: { vessels: number; ageMedianS: number; lastMergeAgeS?: number };
  } | null;
}

// ── shared bits ──────────────────────────────────────────────────────────────
function Card({
  title,
  right,
  cls = "",
  children,
}: {
  title: string;
  right?: ReactNode;
  cls?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`pg-card tt-card ${cls}`} aria-label={title}>
      <h3>
        {title}
        <span className="pg-fill" />
        {right}
      </h3>
      <div className="pg-pad pg-col" style={{ gap: 8 }}>
        {children}
      </div>
    </section>
  );
}
function Tile({
  kind,
  icon,
  text,
}: {
  kind: "g" | "r" | "n";
  icon: string;
  text: string;
}): JSX.Element {
  return (
    <div className={`tt-tile ${kind}`}>
      <Ico n={icon} size={18} />
      {text}
    </div>
  );
}
const Link = ({
  text,
  onClick,
}: {
  text: string;
  onClick: () => void;
}): JSX.Element => (
  <button type="button" className="pg-btn flat" onClick={onClick}>
    {text}
  </button>
);
const Bar = ({ f }: { f: number }): JSX.Element => (
  <span className="tt-bar" aria-hidden>
    <span
      className={f < 0.6 ? "ok" : "warn"}
      style={{ width: `${Math.max(2, Math.min(100, f * 100))}%` }}
    />
  </span>
);
const Pair = ({ k, v }: { k: string; v: ReactNode }): JSX.Element => (
  <div style={{ display: "contents" }}>
    <dt>{k}</dt>
    <dd>{v}</dd>
  </div>
);

// ── A44, A45 ─────────────────────────────────────────────────────────────────
function Overview({
  c,
  go,
  refresh,
}: {
  c: Ctx;
  go: (t: TitanTab) => void;
  refresh: () => void;
}): JSX.Element {
  const sOk = !!c.st?.data;
  const gOk = c.feeds.filter((f) => f.status === "green").length;
  const iOk = c.src?.data
    ? c.srcs.filter((x) => x.state === "ok").length
    : null;
  const nOff = c.devs.filter((d) => d.st !== "Healthy").length;
  const swBad = c.grps.filter((g) => g.bad).length;
  const swUnk = c.grps.filter((g) => g.unknown).length;
  const gen = c.st?.data ? new Date(c.st.data.generated_at * 1000) : null;
  const hhmm = gen
    ? `${String(gen.getUTCHours()).padStart(2, "0")}:${String(gen.getUTCMinutes()).padStart(2, "0")}`
    : "—";
  const tasks: [string, string, (() => void) | undefined, string][] = [
    ["refresh", "Refresh the feed snapshot", refresh, ""],
    [
      "database",
      "Back up the Foundry stores",
      undefined,
      "No backup route on this box",
    ],
    [
      "globe",
      "Configure upstream connections",
      () => go("Data connections"),
      "",
    ],
    [
      "map",
      "Configure map layers",
      undefined,
      "Map layers are configured in the map app",
    ],
  ];
  return (
    <div className="tt-grid">
      <Card
        title="Data connections summary"
        right={<Link text="View more" onClick={() => go("Data connections")} />}
      >
        <b>
          {sOk
            ? `${c.feeds.length} total connections`
            : unavailable("Status", c.st)}
        </b>
        {sOk && (
          <div className="tt-tiles">
            <Tile kind="g" icon="tick-circle" text={`${gOk} healthy`} />
            {c.feeds.length > gOk && (
              <Tile
                kind="n"
                icon="warning-sign"
                text={`${c.feeds.length - gOk} degraded or idle`}
              />
            )}
          </div>
        )}
        <b>
          {c.src?.data
            ? `${c.srcs.length} total integrations`
            : unavailable("Upstream sources", c.src)}
        </b>
        {iOk !== null && (
          <div className="tt-tiles">
            <Tile kind="g" icon="tick-circle" text={`${iOk} healthy`} />
            <Tile
              kind="r"
              icon="error"
              text={`${c.srcs.length - iOk} failing`}
            />
          </div>
        )}
      </Card>
      <Card title="Common maintainer tasks">
        {tasks.map(([ic, lab, fn, why]) => (
          <button
            key={lab}
            type="button"
            className="pg-btn"
            disabled={!fn}
            title={fn ? undefined : why}
            onClick={fn}
          >
            <Ico n={ic} /> {lab}
          </button>
        ))}
      </Card>
      <Card title="Clock and coordinates">
        <div className="tt-clock">
          <span className="tt-big">{hhmm}</span> UTC
        </div>
        <div className="pg-mut pg-sm">Coordinates</div>
        <div>Not available</div>
      </Card>
      <section className="tt-plate" aria-label="Live picture">
        <img src={plateGlobe} alt="" />
        <b>
          {c.st?.data
            ? `Live: ${comma(c.st.data.aircraft_count)} aircraft, ${comma(c.st.data.vessel_count)} vessels`
            : unavailable("Status", c.st)}
        </b>
      </section>
      <Card
        title="Hardware summary"
        right={
          <Link text="View more" onClick={() => go("Hardware management")} />
        }
      >
        <b>
          {c.host
            ? `${c.devs.length} total devices`
            : unavailable("Host readings", c.hostRes)}
        </b>
        {c.host && (
          <div className="tt-tiles">
            <Tile
              kind="g"
              icon="tick-circle"
              text={`${c.devs.length - nOff} healthy`}
            />
            <Tile kind="n" icon="offline" text={`${nOff} offline`} />
          </div>
        )}
      </Card>
      <Card
        title="Software summary"
        right={
          <Link text="Troubleshoot" onClick={() => go("Software management")} />
        }
      >
        <b>{c.grps.length} total software groups</b>
        <div className="tt-tiles">
          <Tile
            kind="g"
            icon="tick-circle"
            text={`${c.grps.length - swBad - swUnk} healthy`}
          />
          <Tile kind="r" icon="error" text={`${swBad} failing`} />
        </div>
      </Card>
    </div>
  );
}

// ── A46, A47, A65 ────────────────────────────────────────────────────────────
const devOrder = (devs: Dev[]): Dev[] => [
  ...devs.filter((d) => d.st === "Healthy"),
  ...devs.filter((d) => d.st !== "Healthy"),
];

function DetailPanel({
  c,
  onBack,
}: {
  c: Ctx;
  onBack: () => void;
}): JSX.Element {
  const h = c.host!;
  const nic = c.devs.filter((d) => d.grp === "Network");
  const name = cpuName(h);
  const threads = h.cpu.threads ?? 0;
  const t = h.hwmon.find((x) => x.chip === "k10temp")?.temps.Tctl;
  const fr: [string, number | null][] = [
    ["CPU", h.loadavg && threads ? h.loadavg[0]! / threads : null],
    ["RAM", h.mem_mb.total ? h.mem_mb.used / h.mem_mb.total : null],
    ["Storage", h.root ? h.root.used / h.root.size : null],
  ];
  const nSto = c.devs.filter((d) => d.grp === "Storage").length;
  const ccds = Object.keys(
    h.hwmon.find((x) => x.chip === "k10temp")?.temps ?? {},
  ).filter((k) => k.startsWith("Tccd")).length;
  return (
    <section className="pg-card tt-card" aria-label={`${name} details`}>
      <h3>
        <button
          type="button"
          className="pg-btn flat"
          aria-label="Back to device locations"
          onClick={onBack}
        >
          <Ico n="chevron-left" /> Back
        </button>
        {name}
        <Chip>Threads: {threads}</Chip>
        <Chip>Compute</Chip>
      </h3>
      <div className="pg-pad pg-col" style={{ gap: 16 }}>
        <dl className="pg-kv">
          <Pair
            k="General health"
            v={
              <span className="tt-ok">
                <Ico n="tick-circle" /> Healthy
              </span>
            }
          />
          <Pair k="Internal temperature" v={t === undefined ? "—" : tC(t)} />
          {fr.map(([k, f]) => (
            <Pair
              key={k}
              k={k}
              v={
                f === null ? (
                  "—"
                ) : (
                  <span className="tt-meter">
                    {Math.round(f * 100)}% <Bar f={f} />
                  </span>
                )
              }
            />
          ))}
          <Pair
            k="Network"
            v={c.rx === null ? "—" : `${c.rx.toFixed(3)} Mbps`}
          />
        </dl>
        <div>
          <b>{name} subcomponents</b>
          <dl className="pg-kv" style={{ marginTop: 8 }}>
            <Pair k={`Core complexes (${ccds})`} v="Healthy" />
            <Pair k={`Physical disks (${nSto})`} v="Healthy" />
            <Pair k={`Network cards (${nic.length})`} v="Healthy" />
            {nic.slice(0, 5).map((d) => (
              <Pair
                key={d.name}
                k={d.name}
                v={d.st === "Healthy" ? "Pass" : "Link down"}
              />
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
function Locations({ c }: { c: Ctx }): JSX.Element {
  const h = c.host!;
  const disks = [...h.disks].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const gw = h.gpu?.power_w;
  const gl = h.gpu?.power_limit_w;
  const cols: [string, string[]][] = [
    ["Compute", [cpuName(h), ...(h.gpu ? [h.gpu.name] : []), "System memory"]],
    ["Storage", disks.map((d) => d.name)],
    [
      "Network",
      c.devs
        .filter((d) => d.grp === "Network")
        .map((d) => `${d.name}${d.st === "Offline" ? " (offline)" : ""}`),
    ],
    [
      "Power",
      [
        gw != null && gl != null
          ? `GPU ${Math.round(gw)} W of ${Math.round(gl)} W`
          : "GPU power —",
      ],
    ],
  ];
  return (
    <section className="pg-card tt-card" aria-label="Device locations">
      <h3>Device locations</h3>
      <div className="pg-pad tt-loc">
        {cols.map(([k, v]) => (
          <div key={k}>
            <b className="pg-sm pg-mut">{k}</b>
            <ul>
              {v.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
function Hardware({
  c,
  dev,
  setDev,
}: {
  c: Ctx;
  dev: number | null;
  setDev: (i: number | null) => void;
}): JSX.Element {
  if (!c.host)
    return <p className="pg-note">{unavailable("Host readings", c.hostRes)}</p>;
  const nOff = c.devs.filter((d) => d.st !== "Healthy").length;
  const ordered = devOrder(c.devs);
  return (
    <div className="pg-col">
      <div className="pg-row" aria-label="Status and device counts">
        <Chip>All ({c.devs.length})</Chip>
        <Chip tone="ok">Healthy ({c.devs.length - nOff})</Chip>
        <Chip tone="bad">Failed (0)</Chip>
        <Chip>Offline ({nOff})</Chip>
        <span className="pg-mut">|</span>
        {["Compute", "Graphics", "Storage", "Network"].map((g) => (
          <Chip key={g}>
            {g} ({c.devs.filter((d) => d.grp === g).length})
          </Chip>
        ))}
      </div>
      <div className="tt-hw">
        <div className="tt-devs">
          {ordered.map((d, i) => {
            const off = d.st === "Offline";
            return (
              <button
                key={d.name}
                type="button"
                className={`tt-dev ${off ? "off" : ""}`}
                aria-label={`${d.name} details`}
                aria-pressed={i === dev}
                disabled={i !== 0}
                title={
                  i === 0 ? undefined : "Detail page exists for the CPU only"
                }
                onClick={() => setDev(i)}
              >
                <span
                  className="pg-row"
                  style={{
                    justifyContent: "space-between",
                    flexWrap: "nowrap",
                  }}
                >
                  <b>{d.name.replace("NVIDIA ", "")}</b>
                  <Chip>{d.grp}</Chip>
                </span>
                <span
                  className="pg-row"
                  style={{
                    justifyContent: "space-between",
                    flexWrap: "nowrap",
                  }}
                >
                  <span className={off ? "" : "tt-ok"}>
                    <Ico n={off ? "power" : "tick-circle"} />{" "}
                    {off ? "Offline" : "Healthy"}
                  </span>
                  <span className="pg-sm pg-mut">{d.extra}</span>
                </span>
              </button>
            );
          })}
        </div>
        {dev === null ? (
          <Locations c={c} />
        ) : (
          <DetailPanel c={c} onBack={() => setDev(null)} />
        )}
      </div>
    </div>
  );
}

// ── A48, A49 ─────────────────────────────────────────────────────────────────
function Software({
  c,
  sel,
  setSel,
}: {
  c: Ctx;
  sel: string | null;
  setSel: (n: string) => void;
}): JSX.Element {
  const gs = c.grps;
  const g = gs.find((x) => x.name === sel) ?? gs[0]!;
  const items: Record<SK, number> = {
    healthy: 0,
    warning: 0,
    failed: 0,
    offline: 0,
  };
  for (const x of gs) {
    if (x.unknown) continue;
    items.healthy += x.tot - x.bad;
    if (x.bad && x.badkind) items[x.badkind] += x.bad;
  }
  const procs = gs.slice(0, 5);
  const pc: Record<SK, number> = {
    healthy: procs.filter((x) => !x.bad && !x.unknown).length,
    warning: 0,
    failed: 0,
    offline: procs.filter((x) => x.bad).length,
  };
  const api = c.host?.listening["8000"];
  const ais = hostRec(c.srcs, AIS_KEYS);
  const nOk = ais.filter((x) => x.state === "ok").length;
  return (
    <div className="pg-col">
      <div className="pg-row">
        <Chip>All ({gs.length})</Chip>
        <b className="pg-sm pg-mut">Process</b>
        {(Object.keys(SVC_ICON) as SK[]).map((k) => (
          <Chip key={`p${k}`}>
            {k[0]!.toUpperCase() + k.slice(1)} ({pc[k]})
          </Chip>
        ))}
        <b className="pg-sm pg-mut">Service</b>
        {(Object.keys(SVC_ICON) as SK[]).map((k) => (
          <Chip key={`s${k}`}>
            {k[0]!.toUpperCase() + k.slice(1)} ({items[k]})
          </Chip>
        ))}
        <span className="pg-fill" />
        <button
          type="button"
          className="pg-btn"
          aria-label="Open /api/status"
          onClick={() => void window.open("/api/status", "_blank", "noopener")}
        >
          API status page <Ico n="arrow-top-right" />
        </button>
        <button
          type="button"
          className="pg-btn"
          disabled
          title="No doctor report route on this box"
        >
          Doctor report
        </button>
      </div>
      <div className="tt-sw">
        <div className="tt-rows">
          {gs.map((x) => {
            const st = gstate(x);
            const [ic, tone] = x.unknown
              ? (["warning-sign", "mut"] as const)
              : SVC_ICON[st];
            const txt = x.unknown
              ? "State unknown"
              : st === "healthy"
                ? "All services healthy"
                : `${x.bad} of ${x.tot} services ${st === "offline" ? "offline" : st === "failed" ? "failed" : "warning"}`;
            return (
              <button
                key={x.name}
                type="button"
                className="tt-row"
                aria-pressed={x.name === g.name}
                onClick={() => setSel(x.name)}
              >
                <Ico n={x.icon} size={18} />
                <span className="tt-grow">
                  <b>{x.name}</b>
                  <span className="pg-sm pg-mut">{x.desc}</span>
                </span>
                <span className="tt-col2">
                  <span className={`tt-${tone}`}>
                    <Ico n={ic} /> {txt}
                  </span>
                  <span className="pg-sm pg-mut">{x.sub}</span>
                </span>
                <span className="tt-col2">
                  <span className={x.unknown ? "tt-mut" : "tt-ok"}>
                    <Ico n={x.unknown ? "warning-sign" : "tick-circle"} />{" "}
                    {x.ps}
                  </span>
                  <span className="pg-sm pg-mut">{x.pss}</span>
                </span>
              </button>
            );
          })}
        </div>
        <section className="pg-card tt-card" aria-label={g.name}>
          <h3>{g.name}</h3>
          <div className="pg-pad pg-col" style={{ gap: 8 }}>
            <span className="pg-mut">{g.desc}</span>
            <b>Processes and hosted services</b>
            <div className="pg-row">
              <Chip>PID</Chip>
              {api ? (
                <>
                  <span>uvicorn {api.pid}</span>
                  <span className="tt-ok">
                    <Ico n="tick-circle" /> Healthy
                  </span>
                </>
              ) : (
                <span>{unavailable("Host readings", c.hostRes)}</span>
              )}
            </div>
            <b className="pg-sm">
              {ais.length} Hosted Services · {nOk} of {ais.length} healthy
            </b>
            <ul className="tt-ul">
              {ais.slice(0, 6).map((x) => (
                <li key={x.host}>
                  <span>{nodash(x.host.replace("www.", ""))}</span>
                  <span className={x.state === "ok" ? "tt-ok" : "tt-bad"}>
                    <Ico n={x.state === "ok" ? "tick-circle" : "error"} />{" "}
                    {x.state === "ok" ? "Healthy" : "Failing"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}

// ── A50 to A53 ───────────────────────────────────────────────────────────────
function Pill({ hs }: { hs: Src[] }): JSX.Element {
  const bad = hs.filter((h) => h.state === "failing").length;
  if (!hs.length) return <Chip>0 integrations</Chip>;
  return (
    <Chip tone={bad ? "bad" : "ok"}>
      {hs.length} integrations · {bad ? `${bad} failing` : "All healthy"}
    </Chip>
  );
}
function ConnList({ c, onOpen }: { c: Ctx; onOpen: () => void }): JSX.Element {
  const n = FAMS.reduce((a, [, it]) => a + it.length, 0);
  const gen = c.st?.data?.generated_at ?? Date.now() / 1000;
  return (
    <div className="pg-col">
      <b>Active ({n})</b>
      {FAMS.map(([fam, its]) => (
        <section key={fam} className="pg-card tt-card" aria-label={fam}>
          <h3>
            {fam} ({its.length})
          </h3>
          {its.map(([nm, sub, keys, ic]) => {
            const hs = hostRec(c.srcs, keys);
            const la = lastOk(hs);
            const ok = hs.some((h) => h.state === "ok");
            const ais = nm === "AIS keyless";
            return (
              <div key={nm} className="tt-conn">
                <Ico n={ic} size={18} />
                <span className="tt-grow">
                  <button
                    type="button"
                    className="pg-link"
                    aria-label={`Open ${nm}`}
                    disabled={!ais}
                    title={
                      ais
                        ? undefined
                        : "Detail page exists for AIS keyless only"
                    }
                    onClick={onOpen}
                  >
                    {nm}
                  </button>
                  <span className="pg-sm pg-mut">{sub}</span>
                </span>
                <span className="tt-col2">
                  <span className="pg-sm pg-mut">Last success</span>
                  <span>
                    {la === null ? "—" : dmy(new Date((gen - la) * 1000))}
                  </span>
                </span>
                <span className="tt-col2">
                  {hs.length ? (
                    <>
                      <span className={ok ? "tt-ok" : "tt-bad"}>
                        <Ico n={ok ? "tick-circle" : "error"} />{" "}
                        {ok
                          ? "Connection currently active"
                          : "Connection failing"}
                      </span>
                      <span className="pg-sm pg-mut">
                        {la === null
                          ? "No success recorded"
                          : `Last success ${age(la)} ago`}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="pg-mut">No upstream host recorded</span>
                      <span className="pg-sm pg-mut">
                        Configured as a feed, not an HTTP poll
                      </span>
                    </>
                  )}
                </span>
                <Pill hs={hs} />
                <button
                  type="button"
                  className="pg-btn"
                  aria-label={`${nm} configuration`}
                  disabled={!ais}
                  title={
                    ais ? undefined : "Detail page exists for AIS keyless only"
                  }
                  onClick={onOpen}
                >
                  Configuration
                </button>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
function ConnCards({ c }: { c: Ctx }): JSX.Element {
  const hs = hostRec(c.srcs, AIS_KEYS);
  const gen = c.st?.data?.generated_at ?? Date.now() / 1000;
  const st = c.pipe?.store;
  return (
    <div className="tt-grid">
      <Card title="Connection">
        <dl className="pg-kv">
          <Pair k="Sources" v={hs.length} />
          <Pair k="Vessels in store" v={st ? comma(st.vessels) : "—"} />
          <Pair
            k="Median fix age"
            v={st ? `${Math.round(st.ageMedianS)} s` : "—"}
          />
          <Pair
            k="Last merge"
            v={
              st?.lastMergeAgeS != null
                ? `${Math.round(st.lastMergeAgeS)} s ago`
                : "—"
            }
          />
        </dl>
      </Card>
      {hs.map((h) => (
        <Card key={h.host} title={nodash(h.host)}>
          <dl className="pg-kv">
            <Pair k="State" v={h.state.toUpperCase()} />
            <Pair k="Last status" v={h.last_status ?? "—"} />
            <Pair
              k="Latency"
              v={h.latency_ms ? `${Math.round(h.latency_ms)} ms` : "—"}
            />
            <Pair k="Requests ok" v={comma(h.ok)} />
            <Pair k="Requests failed" v={comma(h.fail)} />
            <Pair
              k="Last success"
              v={
                h.success_age_s !== null
                  ? new Date((gen - h.success_age_s) * 1000)
                      .toISOString()
                      .slice(0, 10)
                  : "—"
              }
            />
            <Pair
              k="Last error"
              v={nodash(h.last_error || "none").slice(0, 40)}
            />
          </dl>
        </Card>
      ))}
    </div>
  );
}
function ConnDetail({
  c,
  show,
  onToggle,
}: {
  c: Ctx;
  show: boolean;
  onToggle: () => void;
}): JSX.Element {
  const hs = hostRec(c.srcs, AIS_KEYS);
  const up = c.host?.listening["8000"]?.etimes;
  const ok = hs.some((x) => x.state === "ok");
  const h0 = hs[0];
  const nicSp = c.nic ? c.host?.net[c.nic]?.speed_mbps : null;
  return (
    <div className="pg-col">
      <Card title="AIS keyless">
        <dl className="pg-kv tt-sum">
          <Pair k="Connection type" v="Vessels" />
          <Pair
            k="Connection status"
            v={
              <span className={ok ? "tt-ok" : "tt-bad"}>
                <Ico n={ok ? "tick-circle" : "error"} />{" "}
                {ok ? "Healthy" : "Failing"}
              </span>
            }
          />
          <Pair k="Link type" v="HTTPS poll" />
          <Pair
            k="Vessels in store"
            v={c.pipe ? comma(c.pipe.store.vessels) : "—"}
          />
          <Pair k="API uptime" v={up === undefined ? "—" : clock(up)} />
        </dl>
      </Card>
      <div className="pg-row">
        <button
          type="button"
          className="pg-btn"
          aria-expanded={show}
          aria-label={
            show ? "Hide connection details" : "Show connection details"
          }
          onClick={onToggle}
        >
          Connection details <Ico n={show ? "chevron-up" : "chevron-down"} />
        </button>
      </div>
      {show && (
        <div className="tt-grid">
          <Card title="Transport">
            <dl className="pg-kv">
              <Pair k="Protocol" v="HTTPS" />
              <Pair k="Encryption" v="TLS" />
              <Pair k="Last status" v={h0?.last_status ?? "—"} />
              <Pair
                k="Latency"
                v={h0?.latency_ms ? `${Math.round(h0.latency_ms)} ms` : "—"}
              />
            </dl>
          </Card>
          <Card title="Link details">
            <dl className="pg-kv">
              {hs.slice(0, 4).map((x) => (
                <Pair
                  key={x.host}
                  k={nodash(x.host).replace("www.", "")}
                  v={x.state === "ok" ? "Healthy" : "Failing"}
                />
              ))}
            </dl>
          </Card>
          <Card title="Network details">
            <dl className="pg-kv">
              <Pair
                k="Rx bit rate"
                v={
                  c.rx === null
                    ? unavailable("Host readings", c.hostRes)
                    : `${c.rx.toFixed(2)} Mbps`
                }
              />
              <Pair
                k="Rx utilization"
                v={
                  c.rx !== null && nicSp
                    ? `${((100 * c.rx) / nicSp).toFixed(1)}%`
                    : "—"
                }
              />
            </dl>
          </Card>
        </div>
      )}
      <section
        className="pg-card tt-card"
        aria-label="Active and available data integrations"
      >
        <h3>Active & available data integrations</h3>
        <div className="tt-scroll">
          <table className="pg-tbl">
            <thead>
              <tr>
                {[
                  "Integration name",
                  "Data type",
                  "Source name",
                  "Source status",
                  "Integration status",
                  "Requests ok",
                  "Latency",
                  "Success rate",
                  "Failed requests",
                ].map((t) => (
                  <th key={t}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hs.map((x) => {
                const good = x.state === "ok";
                const tot = x.ok + x.fail;
                return (
                  <tr key={x.host}>
                    <td>
                      {NAMES.find(([k]) => x.host.includes(k))?.[1] ?? x.host}
                    </td>
                    <td>AIS</td>
                    <td className="mono">{nodash(x.host)}</td>
                    <td className={good ? "tt-ok" : "tt-bad"}>
                      {good ? "Online" : "Failing"}
                    </td>
                    <td className={good ? "tt-ok" : "tt-bad"}>
                      {good ? "Healthy" : "Failing"}
                    </td>
                    <td className="num">{comma(x.ok)}</td>
                    <td className="num">
                      {x.latency_ms ? `${Math.round(x.latency_ms)} ms` : "—"}
                    </td>
                    <td className="num">
                      {tot ? `${((100 * x.ok) / tot).toFixed(1)}%` : "—"}
                    </td>
                    <td className="num">{comma(x.fail)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function useHost(nonce: number): {
  res: Res<Host> | null;
  rx: number | null;
  nic: string | null;
} {
  const [out, setOut] = useState<{
    res: Res<Host> | null;
    rx: number | null;
    nic: string | null;
  }>({ res: null, rx: null, nic: null });
  useEffect(() => {
    let live = true;
    void (async () => {
      const a = await fetchJson<Host>("/api/status/host", nonce > 0);
      if (!live) return;
      setOut({ res: a, rx: null, nic: null });
      if (!a.data) return;
      await new Promise((r) => setTimeout(r, 1000));
      const b = await fetchJson<Host>("/api/status/host", true);
      if (!live || !b.data) return;
      // the first link that is up with a reported speed (the builder's enp8s0)
      const nic =
        nicNames(b.data).find(
          (n) => b.data!.net[n]!.oper === "up" && b.data!.net[n]!.speed_mbps,
        ) ?? null;
      const ra = nic ? a.data.net[nic]?.rx_bytes : null;
      const rb = nic ? b.data.net[nic]?.rx_bytes : null;
      const dt = b.data.taken - a.data.taken;
      setOut({
        res: b,
        rx:
          ra != null && rb != null && dt > 0
            ? ((rb - ra) * 8) / 1e6 / dt
            : null,
        nic,
      });
    })();
    return () => {
      live = false;
    };
  }, [nonce]);
  return out;
}

type ConnView = "list" | "detail" | "cards";
export function TitanView({
  nav,
}: {
  nav: (v: FoundryNav) => void;
}): JSX.Element {
  const [nonce, setNonce] = useState(0);
  const [tab, setTab] = useState<TitanTab>("Overview");
  const [conn, setConn] = useState<ConnView>("list");
  const [show, setShow] = useState(true);
  const [dev, setDev] = useState<number | null>(null);
  const [sw, setSw] = useState<string | null>(null);
  const st = useJson<Status>("/api/status", nonce);
  const src = useJson<{ sources: Src[] }>("/api/status/sources", nonce);
  const models = useJson<{ engines: Engines }>("/api/ai/models", nonce);
  const local = useJson<{ ollama_up: boolean }>("/api/ai/local", nonce);
  const ver = useJson<{ git_sha: string; stores: Record<string, number> }>(
    "/api/status/version",
    nonce,
  );
  const pipe = useJson<Ctx["pipe"] & object>(
    "/api/maritime/pipeline/stats",
    nonce,
  );
  const hostR = useHost(nonce);
  const host =
    hostR.res?.data && !("error" in hostR.res.data) ? hostR.res.data : null;
  const feeds = (st?.data?.feeds ?? []).map((f) => ({
    ...f,
    name: nodash(f.name),
  }));
  const srcs = src?.data?.sources ?? [];
  const c: Ctx = {
    st,
    src,
    feeds,
    srcs,
    host,
    hostRes: hostR.res,
    rx: hostR.rx,
    nic: hostR.nic,
    devs: host ? devices(host) : [],
    grps: groups(
      host,
      feeds,
      srcs,
      models?.data?.engines ?? null,
      local?.data?.ollama_up ?? null,
      ver?.data ?? null,
    ),
    pipe: pipe?.data ?? null,
  };
  const go = (t: TitanTab): void => {
    setTab(t);
    setConn("list");
    setDev(null);
  };
  return (
    <DkPage here="titan" nav={nav} cls="tt">
      <div className="dk-tabs" role="tablist" aria-label="Ground station">
        {TABS.map(([lab, ic]) => (
          <button
            key={lab}
            type="button"
            role="tab"
            aria-selected={lab === tab}
            disabled={lab === "Power management"}
            title={
              lab === "Power management"
                ? "No power-management readings on this box beyond GPU draw"
                : undefined
            }
            onClick={() => go(lab)}
          >
            <Ico n={ic} /> {lab}
          </button>
        ))}
        {tab === "Data connections" && conn !== "list" && (
          <>
            <span className="pg-fill" />
            <button
              type="button"
              className="pg-btn"
              aria-label="Back to data connections"
              onClick={() => setConn("list")}
            >
              <Ico n="chevron-left" /> Data connections
            </button>
            <button
              type="button"
              className="pg-btn"
              aria-label="Open /api/status"
              onClick={() =>
                void window.open("/api/status", "_blank", "noopener")
              }
            >
              Open /api/status <Ico n="arrow-top-right" />
            </button>
            {conn === "detail" && (
              <button
                type="button"
                className="pg-btn"
                aria-label="Health checks: one card per upstream host"
                onClick={() => setConn("cards")}
              >
                <Ico n="pulse" /> Health checks
              </button>
            )}
          </>
        )}
      </div>
      <div className="pg-body">
        <div className="pg-scroll">
          {tab === "Overview" && (
            <Overview c={c} go={go} refresh={() => setNonce((n) => n + 1)} />
          )}
          {tab === "Hardware management" && (
            <Hardware c={c} dev={dev} setDev={setDev} />
          )}
          {tab === "Software management" && (
            <Software c={c} sel={sw} setSel={setSw} />
          )}
          {tab === "Data connections" && (
            <>
              {!src?.ok && src && (
                <p className="pg-err">{unavailable("Upstream sources", src)}</p>
              )}
              {conn === "list" ? (
                <ConnList c={c} onOpen={() => setConn("detail")} />
              ) : conn === "cards" ? (
                <ConnCards c={c} />
              ) : (
                <ConnDetail
                  c={c}
                  show={show}
                  onToggle={() => setShow((s) => !s)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </DkPage>
  );
}
