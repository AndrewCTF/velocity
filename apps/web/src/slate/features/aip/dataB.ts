// Live data for the AIP copy, part B (gotham/aip/features-b.html, A34-A65).
// The builder (gotham/aip/_build_features_b.py) baked a snapshot of :8000 plus
// this box's /proc, /sys, nvidia-smi, lsblk, ss and ps; here the same values
// come from the routes (host readings from /api/status/host) and the builder's
// derivations are ported as pure functions (tested in dataB.test.ts).
import { mgrs as mgrsSpaced } from "../maven/geo.js";
import type { FC, SarFC, SancP } from "./data.js";

// ── formatting ───────────────────────────────────────────────────────────────
/** Upstream names carry real em dashes; the copy never prints one. */
export const nodash = (s: unknown): string => String(s).replace(/[—–]/g, "-");

const u = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
/** The builder's age(): seconds, minutes, hours (to 48 h), days. */
export function age(sec: number): string {
  const s = Math.trunc(Math.max(0, sec));
  return s < 60
    ? u(s, "second")
    : s < 3600
      ? u(Math.trunc(s / 60), "minute")
      : s < 172800
        ? u(Math.trunc(s / 3600), "hour")
        : u(Math.trunc(s / 86400), "day");
}
/** The builder's dur(): "1 day 3 hours 4 minutes". */
export function dur(sec: number): string {
  const s = Math.trunc(sec);
  const d = Math.trunc(s / 86400);
  const h = Math.trunc((s % 86400) / 3600);
  const m = Math.trunc((s % 3600) / 60);
  return (
    (d ? `${u(d, "day")} ` : "") +
    (h || d ? `${u(h, "hour")} ` : "") +
    u(m, "minute")
  );
}
/** "HH:MM:SS" of a duration (the copy's ticking connection clock). */
export const clock = (sec: number): string => {
  const s = Math.trunc(sec);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(Math.trunc(s / 3600))}:${p(Math.trunc((s % 3600) / 60))}:${p(s % 60)}`;
};
/** The builder's MGRS string ("40RDQ 12345 67890"); same series as maven/geo. */
export const mgrs = (lat: number, lon: number): string =>
  mgrsSpaced(lat, lon).replace(" ", "");
export const tC = (c: number): string =>
  `${c.toFixed(1)} °C | ${Math.round((c * 9) / 5 + 32)} °F`;

// ── route shapes ─────────────────────────────────────────────────────────────
export interface Src {
  host: string;
  ok: number;
  fail: number;
  state: "ok" | "failing" | "unknown";
  last_status: number | null;
  latency_ms: number | null;
  success_age_s: number | null;
  last_error: string | null;
}
export interface Feed {
  name: string;
  status: "green" | "degraded" | "unknown" | string;
  detail?: string;
  count?: number;
}
export interface Status {
  generated_at: number;
  aircraft_count: number;
  vessel_count: number;
  feeds: Feed[];
}
export interface Host {
  taken: number;
  uptime_s: number;
  cpu: { model: string | null; threads: number | null };
  loadavg: number[] | null;
  mem_mb: { total: number; used: number };
  root: { size: number; used: number } | null;
  hwmon: { chip: string | null; temps: Record<string, number> }[];
  gpu: {
    name: string;
    temp_c: number | null;
    power_w: number | null;
    power_limit_w: number | null;
  } | null;
  disks: { name: string; bytes: number | null; model: string | null }[];
  net: Record<
    string,
    {
      oper: string | null;
      speed_mbps: number | null;
      rx_bytes: number | null;
      tx_bytes: number | null;
    }
  >;
  listening: Record<
    string,
    { pid: number; etimes: number; rss_mb: number | null }
  >;
}
export interface Engines {
  llamacpp: { installed: boolean; version: string | null; running: boolean };
  vllm: { installed: boolean; version: string | null; running: boolean };
  ollama: { installed: boolean; version: string | null; running: boolean };
}
export interface CatEntry {
  tier: string;
  repo_id: string;
  license: string;
  recommended_quant: string;
  quants: { q: string; size_gb: number }[];
}
export interface Models {
  engines: Engines;
  catalog: CatEntry[];
  installed: unknown[];
}
export interface Hardware {
  recommendation: { repo_id: string; quant: string };
}
export interface Rule {
  id: string;
  label: string;
  lat: number;
  lon: number;
  radius_nm: number;
  kinds: string[];
  min_severity: number;
  channel: string;
}
export interface GuardB {
  clearance: number;
  compartments: string[];
  tools: string[];
  action_tools: string[];
  control_tools: string[];
  operator_only_actions: string[];
  action_approval: boolean;
  action_auto_threshold: number;
  citations_required: boolean;
}
export interface Call {
  ts: string;
  model_id: string;
}

export const catName = (c: { repo_id: string }): string =>
  (c.repo_id.split("/")[1] ?? c.repo_id).replace("-GGUF", "");

// ── usage chart (usage_chart's axis rule) ────────────────────────────────────
export function axis(mx: number): { step: number; top: number } {
  const m = Math.max(1, mx);
  let step = 10 ** Math.trunc(Math.log10(m));
  step *= m / step <= 4 ? 1 : m / step <= 8 ? 2 : 5;
  return { step, top: Math.ceil(m / step) * step };
}
export const busiest = (src: Src[], n = 16): Src[] =>
  [...src].sort((a, b) => b.ok + b.fail - (a.ok + a.fail)).slice(0, n);

// ── hardware: the builder's DEVS rule over /api/status/host ──────────────────
export interface Dev {
  name: string;
  grp: "Compute" | "Graphics" | "Storage" | "Network";
  st: "Healthy" | "Offline";
  extra: string;
  t: number | null;
}
const temp = (h: Host, chip: string, label: string, nth = 0): number | null =>
  h.hwmon.filter((x) => x.chip === chip)[nth]?.temps[label] ?? null;
export const cpuName = (h: Host): string =>
  (h.cpu.model ?? "CPU").replace(/\s+\d+-Core Processor$/, "").trim();
/** Interfaces the copy draws: every NIC except loopback, bridges, veths and the VPN leak guard. */
export const nicNames = (h: Host): string[] => {
  const all = Object.keys(h.net).filter(
    (n) => !/^(lo$|br-|veth|ipv6leak)/.test(n),
  );
  const down = (n: string): boolean => h.net[n]!.oper === "down";
  return [...all.filter((n) => !down(n)).sort(), ...all.filter(down).sort()];
};
export function devices(h: Host): Dev[] {
  const out: Dev[] = [];
  const tctl = temp(h, "k10temp", "Tctl");
  out.push({
    name: cpuName(h),
    grp: "Compute",
    st: "Healthy",
    extra: tctl === null ? "" : `${tctl.toFixed(1)} °C`,
    t: tctl,
  });
  if (h.gpu)
    out.push({
      name: h.gpu.name,
      grp: "Graphics",
      st: "Healthy",
      extra: h.gpu.power_w === null ? "" : `${Math.round(h.gpu.power_w)} W`,
      t: h.gpu.temp_c,
    });
  out.push({
    name: "System memory",
    grp: "Compute",
    st: "Healthy",
    extra: `${Math.round(h.mem_mb.total / 1024)} GB`,
    t: temp(h, "spd5118", "temp1_input"),
  });
  let nv = 0;
  for (const d of h.disks) {
    const b = d.bytes ?? 0;
    const t = d.name.startsWith("nvme")
      ? temp(h, "nvme", "Composite", nv++)
      : null;
    out.push({
      name: d.name,
      grp: "Storage",
      st: "Healthy",
      extra:
        b > 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`,
      t,
    });
  }
  for (const n of nicNames(h)) {
    const s = h.net[n]!;
    const down = s.oper === "down";
    out.push({
      name: n,
      grp: "Network",
      st: down ? "Offline" : "Healthy",
      extra: down
        ? "link down"
        : s.speed_mbps
          ? `${s.speed_mbps / 1000} Gb/s`
          : "",
      t: null,
    });
  }
  return out;
}

// ── software groups: the builder's GROUPS over the live listeners ────────────
export interface Group {
  name: string;
  desc: string;
  icon: string;
  tot: number;
  bad: number;
  badkind: "offline" | "warning" | "failed" | "";
  sub: string;
  ps: string;
  pss: string;
  /** no host readings: the state cannot be measured, so it is not called healthy */
  unknown?: boolean;
}
export function groups(
  h: Host | null,
  feeds: Feed[],
  src: Src[],
  eng: Engines | null,
  ollamaUp: boolean | null,
  ver: { git_sha: string; stores: Record<string, number> } | null,
): Group[] {
  const L = h?.listening ?? {};
  const na = "n/a: host readings unavailable";
  const side = (
    port: number,
    name: string,
    desc: string,
    icon: string,
  ): Group => {
    const p = L[String(port)];
    return {
      name,
      desc,
      icon,
      tot: 1,
      bad: h && !p ? 1 : 0,
      badkind: "offline",
      unknown: !h,
      sub: !h
        ? na
        : p
          ? `Serving on :${port}, ${(p.rss_mb ?? 0).toLocaleString("en-US")} MB`
          : `Nothing listening on :${port}`,
      ps: !h ? na : p ? "Process healthy" : "Process offline",
      pss: p ? `Online for ${dur(p.etimes)}` : "",
    };
  };
  const tile = L["8001"];
  const api = L["8000"];
  const nf = (k: string): number => feeds.filter((f) => f.status === k).length;
  const nFail = src.filter((x) => x.state === "failing").length;
  const llama = eng?.llamacpp.running ?? false;
  return [
    {
      name: "API and ingest",
      desc: "FastAPI backend on :8000, ingest loops, intel routes and the snapshot cache",
      icon: "cloud",
      tot: 2,
      bad: h ? (api ? 0 : 1) + (tile ? 0 : 1) : 0,
      badkind: "offline",
      unknown: !h,
      sub: !h
        ? na
        : tile
          ? "Tile process :8001 listening"
          : "Tile process :8001 is not listening",
      ps: !h
        ? na
        : api && tile
          ? "All processes healthy"
          : `${(api ? 0 : 1) + (tile ? 0 : 1)} process offline`,
      pss: api ? `API online for ${dur(api.etimes)}` : "",
    },
    side(
      8090,
      "ADS-B sidecar",
      "Node feeder on :8090 that holds the live aircraft tier",
      "globe",
    ),
    side(8093, "AIS sidecar", "Node MyShipTracking feeder on :8093", "globe"),
    side(
      5173,
      "Web console",
      "Vite dev server on :5173 for the console",
      "applications",
    ),
    {
      name: "Local inference",
      desc: "Ollama on :11434 and the llama.cpp engine",
      icon: "cube",
      tot: 2,
      bad: (llama ? 0 : 1) + (ollamaUp === false ? 1 : 0),
      badkind: "offline",
      sub: llama
        ? "llama.cpp is running"
        : "llama.cpp is installed but not running",
      ps: ollamaUp ? "Ollama process healthy" : "Ollama not answering",
      pss: "Ollama listening on :11434",
    },
    {
      name: "Data stores",
      desc: "SQLite stores for the ontology, Foundry, audit log and entity resolution",
      icon: "database",
      tot: ver ? Object.keys(ver.stores).length : 0,
      bad: 0,
      badkind: "",
      sub: "All services healthy",
      ps: "Stores opened by the API",
      pss: ver
        ? `Schema version ${ver.stores.ontology ?? "n/a"}, build ${ver.git_sha}`
        : "",
    },
    {
      name: "Feeds",
      desc: "Live feed families reported by /api/status",
      icon: "pulse",
      tot: feeds.length,
      bad: nf("degraded") + nf("unknown"),
      badkind: "warning",
      sub: `${nf("degraded")} degraded, ${nf("unknown")} not yet fetched`,
      ps: "Reported by the API",
      pss: `${nf("green")} of ${feeds.length} green`,
    },
    {
      name: "Upstream hosts",
      desc: "Hosts the API has called since boot",
      icon: "globe-network",
      tot: src.length,
      bad: nFail,
      badkind: "failed",
      sub: `${nFail} of ${src.length} hosts failing`,
      ps: "Measured by the API",
      pss: `${src.reduce((a, x) => a + x.ok, 0).toLocaleString("en-US")} requests succeeded`,
    },
  ];
}
export const gstate = (
  g: Group,
): "healthy" | "offline" | "warning" | "failed" =>
  g.bad === 0 ? "healthy" : g.badkind || "warning";

// ── connections (FAMS) ───────────────────────────────────────────────────────
export const AIS_KEYS = [
  "shipxplorer",
  "vesselfinder",
  "openwaters",
  "meri.digitraffic",
  "kystdatahuset",
];
export const hostRec = (src: Src[], keys: string[]): Src[] =>
  src.filter((x) => keys.some((k) => x.host.includes(k)));
export const FAMS: [string, [string, string, string[], string][]][] = [
  [
    "Aircraft connections",
    [
      [
        "ADS-B aircraft",
        "Aircraft grid",
        ["adsb.lol", "adsb.fi", "airplanes.live", "opensky"],
        "airplane",
      ],
      ["GPS jamming (derived)", "Derived from NACp", [], "satellite"],
    ],
  ],
  [
    "Vessel connections",
    [
      ["AIS keyless", "Worldwide, MMSI-deduped", AIS_KEYS, "ship"],
      ["AISStream", "BYOK, on-demand", [], "ship"],
      ["MarineTraffic", "Paid, dormant", [], "ship"],
    ],
  ],
  [
    "Hazard connections",
    [
      [
        "USGS earthquakes",
        "Earthquakes",
        ["earthquake.usgs", "seismicportal"],
        "pulse",
      ],
    ],
  ],
  [
    "Imagery connections",
    [
      [
        "Sentinel-1 SAR",
        "Dark-vessel screen",
        ["dataspace.copernicus"],
        "satellite",
      ],
      ["NASA FIRMS fires", "Key configured", [], "flame"],
    ],
  ],
];
export const lastOk = (hs: Src[]): number | null => {
  const v = hs
    .map((x) => x.success_age_s)
    .filter((x): x is number => x !== null);
  return v.length ? Math.min(...v) : null;
};

// ── 2-sigma covariance ellipse of a track's fixes (the builder's ell) ────────
export function ell(
  pts: [number, number][],
): [number, number, number, number, number] {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  const k = Math.cos((my * Math.PI) / 180);
  const xs = pts.map((p) => (p[0] - mx) * 111.32 * k);
  const ys = pts.map((p) => (p[1] - my) * 111.32);
  const sxx = xs.reduce((a, x) => a + x * x, 0) / n;
  const syy = ys.reduce((a, y) => a + y * y, 0) / n;
  const sxy = xs.reduce((a, x, i) => a + x * ys[i]!, 0) / n;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const d = Math.sqrt(Math.max((tr * tr) / 4 - det, 0));
  const l1 = tr / 2 + d;
  const l2 = Math.max(tr / 2 - d, 0);
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return [
    mx,
    my,
    2 * Math.sqrt(l1) + 0.15,
    2 * Math.sqrt(l2) + 0.15,
    (th * 180) / Math.PI,
  ];
}
export const km = (a: number[], b: number[]): number =>
  6371 *
  Math.hypot(
    (((b[0]! - a[0]!) * Math.PI) / 180) * Math.cos((a[1]! * Math.PI) / 180),
    ((b[1]! - a[1]!) * Math.PI) / 180,
  );

// ── watch items (gotham/_kit/watch_items.py over the live routes) ────────────
export interface WItem {
  kind: "sar" | "choke" | "jam" | "quake" | "nga" | "ofac";
  id: string;
  title: string;
  link: string;
  icon: string;
  shape: "c" | "dia";
  color: string;
  t: number;
  ll: [number, number];
  ref: string;
}
export const inReg = (lon: number, lat: number): boolean =>
  lon >= 32 && lon <= 62 && lat >= 10 && lat <= 31;
const isoT = (s: string): number => Date.parse(s.slice(0, 19) + "Z") / 1000;
/** stable 4-digit id for a name (watch_items.py used Python's per-process hash) */
const hash4 = (s: string): string => {
  let h = 5381;
  for (const c of s) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return String(h % 10000).padStart(4, "0");
};
const capFirst = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
interface WarnP2 {
  msgNumber?: number;
  msgYear?: number;
  text?: string;
}
interface Geo {
  type: string;
  coordinates: unknown;
}
interface F<P> {
  id?: string;
  geometry: Geo | null;
  properties: P;
}
export interface WatchSrc {
  sar: (SarFC & { summary: { date: string; label: string } } & {
    features: F<{
      darkCandidate?: boolean | null;
      plausibleVessel?: boolean;
      lengthM: number;
    }>[];
  })[];
  choke: {
    features: F<{
      name: string;
      vessels: number;
      stationary: number;
      congestion: string;
    }>[];
  } | null;
  jam: { features: F<{ percent_bad?: number }>[] } | null;
  quake: {
    features: F<{
      mag: number;
      place: string;
      time: string;
      source_id: string;
    }>[];
  } | null;
  warn: { features: F<WarnP2>[] } | null;
  sanc: FC<SancP> | null;
  now: number;
}
const first = (c: unknown): number[] => {
  let x = c as unknown[];
  while (Array.isArray(x[0])) x = x[0] as unknown[];
  return x as number[];
};
export function watchItems(w: WatchSrc): WItem[] {
  const items: WItem[] = [];
  const add = (
    kind: WItem["kind"],
    id: string,
    title: string,
    link: string,
    icon: string,
    shape: WItem["shape"],
    color: string,
    t: number,
    ll: number[],
    ref = "",
  ): void => {
    items.push({
      kind,
      id,
      title,
      link,
      icon,
      shape,
      color,
      t,
      ll: [ll[0]!, ll[1]!],
      ref,
    });
  };
  for (const d of w.sar) {
    const day = isoT(d.summary.date + "T00:00:00");
    for (const f of d.features) {
      const p = f.properties;
      if (p.darkCandidate && p.plausibleVessel && f.geometry)
        add(
          "sar",
          "SR" +
            String(f.id ?? "")
              .split(":")
              .pop()!
              .slice(-4)
              .padStart(4, "0"),
          `SAR hull ${Math.round(p.lengthM)} m, no AIS`,
          `Sentinel-1 · ${d.summary.label}`,
          "ship",
          "c",
          "#14b8a6",
          day,
          first(f.geometry.coordinates),
          String(f.id),
        );
    }
  }
  for (const f of w.choke?.features ?? []) {
    const p = f.properties;
    const c = f.geometry ? first(f.geometry.coordinates) : null;
    if (
      c &&
      (p.congestion === "high" || p.congestion === "medium") &&
      inReg(c[0]!, c[1]!)
    )
      add(
        "choke",
        "CP" + hash4(p.name),
        `${p.name}: ${p.stationary} of ${p.vessels} stationary`,
        "Chokepoints",
        "ship",
        "dia",
        "#14b8a6",
        w.now - 600,
        c,
      );
  }
  const jam = (w.jam?.features ?? []).filter((f) => {
    const c = f.geometry ? first(f.geometry.coordinates) : null;
    return c && inReg(c[0]!, c[1]!) && (f.properties.percent_bad ?? 0) >= 10;
  });
  for (const f of jam
    .sort(
      (a, b) =>
        (b.properties.percent_bad ?? 0) - (a.properties.percent_bad ?? 0),
    )
    .slice(0, 4)) {
    const id = String(f.id ?? "");
    add(
      "jam",
      "GJ" +
        id
          .slice(id.indexOf(":") + 1)
          .replace(/:/g, "")
          .slice(-4)
          .replace(/-/g, "0"),
      `GPS jamming, ${Math.round(f.properties.percent_bad ?? 0)}% bad NACp`,
      "Jamming · NACp",
      "antenna",
      "dia",
      "#ef4444",
      w.now - 900,
      first(f.geometry!.coordinates),
    );
  }
  for (const f of w.quake?.features ?? []) {
    const p = f.properties;
    const c = f.geometry ? first(f.geometry.coordinates) : null;
    if (c && inReg(c[0]!, c[1]!))
      add(
        "quake",
        "EQ" + p.source_id.slice(-4),
        `M${p.mag.toFixed(1)} quake, ${p.place.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())}`,
        "EMSC seismic",
        "warning-sign",
        "c",
        "#ef4444",
        isoT(p.time),
        c,
      );
  }
  const seen = new Set<string>();
  const warns = [...(w.warn?.features ?? [])].sort(
    (a, b) =>
      (b.properties.msgYear ?? 0) - (a.properties.msgYear ?? 0) ||
      (b.properties.msgNumber ?? 0) - (a.properties.msgNumber ?? 0),
  );
  for (const f of warns) {
    const p = f.properties;
    const c = f.geometry ? first(f.geometry.coordinates) : null;
    const key = `${p.msgNumber}/${p.msgYear}`;
    if (
      !c ||
      seen.has(key) ||
      !inReg(c[0]!, c[1]!) ||
      (p.msgYear ?? 0) < 2023 ||
      seen.size >= 6
    )
      continue;
    seen.add(key);
    const lines = (p.text ?? "").split("\n").map((l) =>
      l
        .trim()
        .replace(/^[ .]+|[ .]+$/g, "")
        .replace(/^[0-9. ]+/, ""),
    );
    const what = (
      lines.find((l) => l.length > 12 && !l.startsWith("DNC")) ?? "Warning"
    )
      .split(",")[0]!
      .split(" IN ")[0]!
      .split(" 0")[0]!;
    add(
      "nga",
      `NW${String(p.msgNumber ?? 0).padStart(4, "0")}`,
      `${capFirst(what).slice(0, 28)}, NGA ${p.msgNumber}/${String(p.msgYear).slice(2)}`,
      "NGA warnings",
      "document",
      "c",
      "#e5e8eb",
      isoT(`${p.msgYear}-01-01T00:00:00`),
      c,
    );
  }
  for (const f of w.sanc?.features ?? []) {
    const p = f.properties;
    const c = f.geometry?.coordinates;
    if (!c || !inReg(c[0]!, c[1]!)) continue;
    const st = p.shipType;
    const kw =
      typeof st === "number" && st >= 80 && st <= 89
        ? "tanker"
        : typeof st === "number" && st >= 70 && st <= 79
          ? "cargo hull"
          : "hull";
    add(
      "ofac",
      `OF${String(Number(p.mmsi) % 9973).padStart(4, "0")}`,
      `Registry-listed ${kw} ` + ((p.sog ?? 0) > 1 ? "under way" : "at anchor"),
      "OFAC SDN registry",
      "ship",
      "c",
      "#d97706",
      p.t || w.now,
      c,
      `vessel:${p.mmsi}`,
    );
  }
  return items.sort((a, b) => b.t - a.t);
}
export const KIND_GROUP: Record<WItem["kind"], string> = {
  sar: "SAR dark candidates",
  jam: "GPS jamming",
  choke: "Chokepoints",
  ofac: "Registry matches",
  nga: "NGA warnings",
  quake: "Earthquakes",
};
/** recorded rule: detector output stays at CONFIRM; items carrying a second source sit at ATTACH INTEL */
export const STAGE_OF: Record<WItem["kind"], 0 | 1> = {
  sar: 0,
  jam: 0,
  choke: 0,
  ofac: 1,
  nga: 1,
  quake: 1,
};
export const SAR_AOIS = [
  "hormuz",
  "bab-el-mandeb",
  "gulf-of-aden",
  "suez-gulf-approach",
];
