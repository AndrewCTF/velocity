// AIP terminal: features A1-A6 (chat over the live feeds) and A13-A21 (a
// scenario run over the real SAR dark-vessel screen), ported frame for frame
// from gotham/aip/_build_features_a.py (aip_shell .. a21). No model prose is
// drawn anywhere: an answer is either the real tool output (the route data) or
// the real response of POST /api/ai/selection/brief, which is 409 while no
// chat model is loaded.
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../../transport/http.js";
import { CLIP, Hit, I, Ii, L, R, SVG, T, frag, spinner, type N } from "./ui.js";
import {
  KM_PER_SCENE_PX,
  conf,
  dmy,
  inHormuz,
  keepAtLeast,
  mon,
  runName,
  sancRows,
  sarRows,
  sarTitle,
  scenePx,
  stamp,
  topCls,
  unavailable,
  useJson,
  wrap,
  type Choke,
  type FC,
  type Res,
  type Sanc,
  type SancP,
  type Sar,
  type SarFC,
  type WarnP,
} from "./data.js";
// shortcut: reference-derived image kept out of the repo; the page draws without it. Ship a licensed asset to restore it.
const lightHormuz: string = "";

const SAR_PATH = "/api/intel/dark-vessels/sar?aoi=hormuz";

// ── live inputs ──────────────────────────────────────────────────────────────
interface Live {
  ts: Date | null;
  choke: Res<FC<Choke>> | null;
  ch: Map<string, Choke>;
  chxy: Map<string, number[]>;
  chokeFid: string;
  sanc: Sanc[];
  sancRes: Res<FC<SancP>> | null;
  sar: Sar[];
  sarRes: Res<SarFC> | null;
  warnRes: Res<FC<WarnP>> | null;
  hzWarn: { xy: number[]; p: WarnP }[];
  vessels: { lon: number; lat: number }[];
  modelOn: boolean;
}

function useLive(sarNonce: number): Live {
  const status = useJson<{ generated_at: number }>("/api/status");
  const choke = useJson<FC<Choke>>("/api/maritime/chokepoints");
  const sancRes = useJson<FC<SancP>>("/api/sanctions/vessels");
  const sarRes = useJson<SarFC>(SAR_PATH, sarNonce);
  const warnRes = useJson<FC<WarnP>>("/api/maritime/warnings");
  const ves = useJson<{ vessels: { lon: number; lat: number }[] }>(
    "/api/maritime/vessels?bbox=54.5,25.6,58.2,27.6",
  );
  const local = useJson<{ selection_enabled?: boolean }>("/api/ai/local");
  const ch = new Map<string, Choke>();
  const chxy = new Map<string, number[]>();
  let chokeFid = "";
  for (const f of choke?.data?.features ?? []) {
    ch.set(f.properties.name, f.properties);
    if (f.geometry) chxy.set(f.properties.name, f.geometry.coordinates);
    if (f.properties.name === "Strait of Hormuz") chokeFid = String(f.id);
  }
  const hzWarn = (warnRes?.data?.features ?? [])
    .filter(
      (f) => f.geometry?.type === "Point" && inHormuz(f.geometry.coordinates),
    )
    .map((f) => ({ xy: f.geometry!.coordinates, p: f.properties }));
  return {
    ts: status?.data ? new Date(status.data.generated_at * 1000) : null,
    choke,
    ch,
    chxy,
    chokeFid,
    sanc: sancRows(sancRes?.data ?? null),
    sancRes,
    sar: sarRows(sarRes?.data ?? null),
    sarRes,
    warnRes,
    hzWarn,
    vessels: ves?.data?.vessels ?? [],
    modelOn: local?.data?.selection_enabled === true,
  };
}

const hzSanc = (lv: Live): Sanc[] => lv.sanc.filter((s) => inHormuz(s.xy));
const hzWarnMsgs = (lv: Live): number =>
  new Set(lv.hzWarn.map((w) => `${w.p.msgYear}-${w.p.msgNumber}`)).size;
const stampOf = (lv: Live): string => (lv.ts ? stamp(lv.ts) : "loading");
/** A count from a route: "loading" in flight, "n/a" when the route failed. */
const cnt = (r: Res<unknown> | null, n: number): string =>
  r === null ? "loading" : r.ok ? String(n) : "n/a";

// ── shell ────────────────────────────────────────────────────────────────────
interface ShellHits {
  onLogo: () => void;
  onHub: () => void;
  onInvestigations: () => void;
  onProposals: () => void;
  sim?:
    | {
        name: string;
        onPropose: () => void;
        onNew: () => void;
        onExit: () => void;
      }
    | undefined;
}

function aipShell(composer = true, simName?: string): N[] {
  const s: N[] = [];
  s.push(R(282, 98, 1590, 916, "#f2f6f8"));
  s.push(R(282, 98, 1590, 54, "#fefefe"), L(282, 151, 1872, 151, "#e3e8ea"));
  s.push(R(282, 98, 61, 54, "#32363a"));
  s.push(I("lightning", 313, 125, 24, "#fff")); // the app mark on the logo tile
  s.push(T(369, 124, "AIP terminal", 17.5, "#2a2f33", 700));
  s.push(L(506, 102, 506, 150, "#e3e8ea"));
  s.push(
    T(526, 134, "Investigations", 15.5, "#38507e", 400),
    R(526, 149, 106, 2, "#3062a4"),
  );
  s.push(T(646, 134, "Proposals", 15.5, "#4a5358"));
  s.push(L(1698, 106, 1698, 140, "#e3e8ea"));
  s.push(
    I("person", 1730, 123, 20, "#4a5358"),
    T(1750, 124, "Share", 15, "#4a5358"),
    I("panel-stats", 1839, 124, 20, "#4a5358"),
  );
  if (simName) {
    s.push(
      R(282, 152, 1590, 57, "#f6f0fe"),
      L(282, 208, 1872, 208, "#c9c9dc", 2),
    );
    s.push(
      I("area-of-interest", 304, 181, 18, "#9b8bc8"),
      T(
        328,
        182,
        <>
          Simulation mode: <b>{simName}</b>
        </>,
        15.5,
        "#2e3438",
      ),
    );
    s.push(
      R(1323, 164, 227, 34, "#fff", "#c9ced4", "border-radius:2px"),
      I("git-branch", 1342, 181, 17, "#4a5358"),
      T(1362, 182, "Propose these changes", 15.5, "#2e3438"),
    );
    s.push(
      R(1563, 164, 215, 34, "#fff", "#c9ced4", "border-radius:2px"),
      I("add", 1583, 181, 20, "#4a5358"),
      T(1602, 182, "Run a new simulation", 15.5, "#2e3438"),
    );
    s.push(
      R(1805, 164, 54, 34, "#fff", "#c9ced4", "border-radius:2px"),
      T(1832, 182, "Exit", 15.5, "#2e3438", 400, "", "", "c"),
    );
  }
  if (composer) {
    s.push(
      R(282, 925, 1590, 89, "#f2f6f8", "", "border-top:1px solid #e9eef0"),
    );
    s.push(R(298, 940, 1471, 64, "#fff", "#e3e8ea"));
    s.push(R(1783, 938, 72, 68, "#2c64c2", "", "border-radius:1px"));
    s.push(I("send-message", 1819, 972, 28, "#fff"));
  }
  return s;
}

function shellHits(h: ShellHits): N[] {
  const s: N[] = [
    Hit(282, 98, 61, 54, "Open the Foundry workspace", h.onLogo),
    Hit(518, 116, 122, 34, "Investigations", h.onInvestigations),
    Hit(638, 116, 84, 34, "Proposals: run a simulation", h.onProposals),
    Hit(
      1824,
      109,
      30,
      30,
      "AI hub: watch officer, analyst agent, local models",
      h.onHub,
    ),
  ];
  if (h.sim)
    s.push(
      Hit(1323, 164, 227, 34, "Propose these changes", h.sim.onPropose),
      Hit(1563, 164, 215, 34, "Run a new simulation", h.sim.onNew),
      Hit(1805, 164, 54, 34, "Exit simulation mode", h.sim.onExit),
    );
  return s;
}

/** The composer: drawn placeholder (focused and resting states, as A1 and A2
 *  draw them) with a real input over it. */
function Composer({ onSend }: { onSend: (q: string) => void }): JSX.Element {
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const send = (): void => {
    const v = q.trim();
    if (!v) return;
    onSend(v);
    setQ("");
  };
  // fixed slots (null when hidden): a changed sibling count would remount the
  // input under the caret
  const s: N[] = [
    focus
      ? R(298, 940, 1471, 64, "#fff", "#2c64c2", "border-radius:1px")
      : null,
    focus && !q
      ? T(
          314,
          956,
          "Start typing something to explore with AIP...",
          16.5,
          "#6a7378",
        )
      : null,
    !focus && !q
      ? T(
          311,
          967,
          "Start typing something to explore with AIP...",
          16.5,
          "#8a9397",
        )
      : null,
  ];
  s.push(
    <input
      ref={ref}
      className="a sl-field"
      aria-label="Ask AIP"
      value={q}
      onChange={(e) => setQ(e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") send();
      }}
      style={{
        left: 311,
        top: focus ? 944 : 955,
        width: 1450,
        height: 24,
      }}
    />,
    Hit(1783, 938, 72, 68, "Send", q.trim() ? send : undefined),
  );
  return frag(s);
}

// ── chat pieces ──────────────────────────────────────────────────────────────
function avatar(
  x: number,
  y: number,
  init = "FH",
  you = true,
  grey = false,
): N[] {
  const c = grey ? "#d6dbde" : "#427298";
  const fc = grey ? "#6a7378" : "#fff";
  return [
    R(x - 16, y - 16, 32, 32, c, "", "border-radius:50%"),
    T(x, y, init, 12, fc, 700, "", "", "c"),
    you ? T(x + 23, y + 1, "(YOU)", 11.5, "#6a7378") : null,
  ];
}

function bubble(
  x: number,
  y: number,
  w: number,
  h: number,
  lines: string[],
  ly0?: number,
  pitch = 21,
  ex = "border-radius:2px",
): N[] {
  const s: N[] = [R(x, y, w, h, "#e6f0f6", "#a9bccd", ex)];
  const ly = ly0 ?? y + 21;
  lines.forEach((t, i) => s.push(T(x + 13, ly + i * pitch, t, 16, "#2a2f33")));
  return s;
}

const bubbleH = (n: number): number => 21 + 21 * n;

function assistant(x: number, y: number, label = "AIP Assistant"): N[] {
  return [
    R(x - 16, y - 16, 32, 32, "#d8dde0", "", "border-radius:50%"),
    I("chat", x, y, 17, "#59646a"),
    T(x + 23, y + 1, label, 11.5, "#6a7378"),
  ];
}

function dotsCard(x: number, y: number): N[] {
  return [
    R(x, y, 108, 38, "#f6fafa", "#e3e8ea"),
    ...[0, 1, 2].map((i) =>
      R(x + 38 + i * 14, y + 18, 4, 4, "#777", "", "border-radius:50%"),
    ),
  ];
}

export interface Reply {
  status: number;
  text?: string | undefined;
  detail?: string | undefined;
}

/** The real outcome of the model call: typing dots while it is in flight, the
 *  route's own refusal when it refuses, the model's text when it answers. */
function reply(x: number, y: number, r: Reply | null): N[] {
  if (r === null) return dotsCard(x, y);
  if (r.status === 200 && r.text)
    return [
      R(
        x,
        y,
        900,
        38,
        "#f6fafa",
        "#e3e8ea",
        "height:auto;min-height:38px;padding:9px 12px",
        <div
          className="sl-wrap"
          style={{ fontSize: 15, lineHeight: "20px", color: "#2a2f33" }}
        >
          {r.text}
        </div>,
      ),
    ];
  const msg =
    r.status === 409
      ? "No response: no chat model loaded (HTTP 409, selection inference disabled)"
      : r.status === 0
        ? "No response: the model route did not answer (network error)"
        : `No response (HTTP ${r.status}${r.detail ? `, ${r.detail.slice(0, 60)}` : ""})`;
  return [
    R(x, y, 560, 38, "#f6fafa", "#e3e8ea"),
    R(x + 12, y + 17, 5, 5, "#c0883a", "", "border-radius:50%"),
    T(x + 26, y + 20, msg, 13.5, "#59646a"),
  ];
}

async function askModel(
  lv: Live,
  question: string,
  subject?: { kind: string; id: string; props: Record<string, unknown> },
): Promise<Reply> {
  const hz = lv.ch.get("Strait of Hormuz");
  const body = subject ?? {
    kind: "chokepoint",
    id: lv.chokeFid || "chokepoint:strait-of-hormuz",
    props: { ...(hz ?? {}) },
  };
  try {
    const r = await apiFetch("/api/ai/selection/brief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, props: { ...body.props, question } }),
    });
    const j = (await r.json().catch(() => ({}))) as {
      text?: string;
      detail?: unknown;
    };
    return {
      status: r.status,
      text: j.text,
      detail: typeof j.detail === "string" ? j.detail : undefined,
    };
  } catch {
    return { status: 0 };
  }
}

function contextLine(lv: Live, y = 197): N {
  const pick = lv.hzWarn.find((w) => (w.p.text ?? "").trim()) ?? lv.hzWarn[0];
  if (!pick) {
    const why =
      lv.warnRes && !lv.warnRes.ok
        ? unavailable("NGA warnings", lv.warnRes)
        : lv.warnRes
          ? "no NGA warning inside the Hormuz box"
          : "NGA warnings loading";
    return T(
      1075,
      y,
      <>
        You are starting from <b style={{ color: "#222" }}>0 alerts</b>: {why}{" "}
        <span style={{ color: "#e98a2c", fontWeight: 700, fontSize: 12 }}>
          &#9679; NGA
        </span>{" "}
        feed
      </>,
      18,
      "#6a7378",
      400,
      "",
      "",
      "c",
    );
  }
  const label = `NGA warning ${pick.p.navArea}-${pick.p.msgNumber}/${String(pick.p.msgYear).slice(2)}`;
  return T(
    1075,
    y,
    <>
      You are starting from <b style={{ color: "#222" }}>1 alert</b> from the
      &nbsp;<span style={{ color: "#38507e" }}>{label}</span>{" "}
      <span style={{ color: "#e98a2c", fontWeight: 700, fontSize: 12 }}>
        &#9679; NGA
      </span>{" "}
      feed
    </>,
    18,
    "#6a7378",
    400,
    "",
    "",
    "c",
  );
}

const CONG: Record<string, [string, string, string, string]> = {
  high: ["Congested", "#c9302c", "#f8e2e4", "#d9777a"],
  elevated: ["Elevated", "#a8641a", "#fbefdc", "#d9a35a"],
  normal: ["Normal", "#2f7d44", "#e4f6ea", "#4a9a5a"],
};
function chip(
  x: number,
  y: number,
  w: number,
  text: string,
  fg: string,
  bg: string,
  bd: string,
  h = 24,
  size = 15,
): N[] {
  return [
    R(x, y - Math.floor(h / 2), w, h, bg, bd, "border-radius:2px"),
    T(x + w / 2, y + 1, text, size, fg, 400, "", "", "c"),
  ];
}

function lightmapDiv(
  x: number,
  y: number,
  w: number,
  h: number,
  cx: number,
  cy: number,
  k: number,
  fx: number,
  fy: number,
): N {
  return (
    <div
      className="a"
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        overflow: "hidden",
        background: "#f1f3ee",
      }}
    >
      <div
        className="a"
        style={{
          left: fx - cx * k,
          top: fy - cy * k,
          width: 1882 * k,
          height: 1242 * k,
          background: `${lightHormuz ? `url(${lightHormuz})` : "none"} 0 0/100% 100%`,
        }}
      />
    </div>
  );
}

const CHOKE_ORDER = [
  "Suez / Gulf of Suez",
  "Bosphorus",
  "Strait of Hormuz",
  "Bab-el-Mandeb",
  "Strait of Malacca",
  "Panama Canal",
  "Strait of Gibraltar",
  "Taiwan Strait",
];

function mapA3(lv: Live, x0: number, y0: number, x1: number, y1: number): N[] {
  const w = x1 - x0;
  const h = y1 - y0;
  const xy = lv.chxy.get("Strait of Hormuz") ?? [56.3, 26.6];
  const [sx, sy] = scenePx(xy[0]!, xy[1]!);
  const k = 0.46;
  const mx = x0 + w * 0.62;
  const my = y0 + h * 0.5;
  const s: N[] = [lightmapDiv(x0, y0, w, h, sx, sy, k, w * 0.62, h * 0.5)];
  // live AIS positions in the pane (the copy drew its scene's vessel labels)
  for (const v of lv.vessels) {
    const [px, py] = scenePx(v.lon, v.lat);
    const qx = mx + (px - sx) * k;
    const qy = my + (py - sy) * k;
    if (x0 + 3 < qx && qx < x1 - 3 && y0 + 3 < qy && qy < y1 - 3)
      s.push(
        R(
          Math.round(qx - 2),
          Math.round(qy - 1),
          5,
          3,
          "#9aa6ae",
          "",
          "border-radius:1px",
        ),
      );
  }
  s.push(
    T(
      x0 + w * 0.2,
      y0 + h * 0.34,
      "I R A N",
      12,
      "#9aa3a8",
      600,
      "letter-spacing:.35em",
    ),
  );
  s.push(
    T(
      x0 + w * 0.42,
      y0 + h * 0.8,
      "O M A N",
      11,
      "#9aa3a8",
      600,
      "letter-spacing:.3em",
    ),
  );
  s.push(
    R(
      mx - 11,
      my - 11,
      22,
      22,
      "rgba(76,127,212,.10)",
      "#4c7fd4",
      "border-radius:50%",
    ),
    R(mx - 3, my - 3, 6, 6, "#4c7fd4", "", "border-radius:50%"),
  );
  const px0 = mx + 14;
  const py0 = my + 5;
  s.push(
    R(
      px0,
      py0,
      140,
      56,
      "#fff",
      "#e3e8ea",
      "box-shadow:0 1px 5px rgba(0,0,0,.18);border-radius:2px",
    ),
  );
  s.push(
    R(px0 + 12, py0 + 17, 24, 24, "#2f6fd0", "", "border-radius:2px"),
    I("cube", px0 + 24, py0 + 29, 15, "#fff"),
  );
  s.push(
    T(px0 + 46, py0 + 22, "Strait of Hormuz", 11, "#2a2f33", 700),
    T(px0 + 46, py0 + 35, "Chokepoint", 10, "#6a7378"),
  );
  return s;
}

function a3Body(lv: Live, q: string[], dim = false): N[] {
  const s: N[] = [
    ...bubble(
      502,
      152,
      634,
      56,
      q.slice(-2),
      166,
      21,
      "border-radius:2px;border-top:0",
    ),
  ];
  s.push(...assistant(518, 246));
  s.push(R(502, 271, 1148, 612, "#fff", "#e3e8ea"));
  s.push(
    T(530, 312, "Chokepoints", 18, "#2a2f33", 700),
    T(1443, 312, "Hand-off Inspector", 15, "#38507e"),
    I("panel-stats", 1604, 313, 19, "#38507e"),
  );
  s.push(
    T(
      530,
      345,
      `Result of query: chokepoints by vessels inside, AIS snapshot ${stampOf(lv)}`,
      15,
      "#7a8388",
    ),
  );
  s.push(R(530, 375, 1093, 482, "#fff", "#e6eaec"));
  s.push(T(550, 403, "Chokepoints: worldwide", 16, "#2a2f33", 700));
  s.push(R(531, 432, 532, 56, "#f4f7f8"), L(531, 488, 1063, 488, "#e6eaec"));
  s.push(
    T(543, 460, "Name", 13, "#5a6368", 600),
    T(723, 460, "Status", 13, "#5a6368", 600),
    T(865, 460, "Last updated", 13, "#5a6368", 600),
  );
  const ys = [513, 559, 605, 651, 697, 743, 790, 836];
  if (!lv.choke?.ok)
    s.push(T(550, 513, unavailable("Chokepoints", lv.choke), 15, "#6a7378"));
  const names = [
    ...CHOKE_ORDER.filter((n) => lv.ch.has(n)),
    ...[...lv.ch.keys()].filter((n) => !CHOKE_ORDER.includes(n)),
  ].slice(0, 8);
  names.forEach((nm, i) => {
    const yy = ys[i]!;
    const p = lv.ch.get(nm)!;
    if (nm === "Strait of Hormuz")
      s.push(
        R(531, yy - 23, 532, 46, "#e8f0fa"),
        L(531, yy - 24, 1063, yy - 24, "#4676da", 2),
        L(531, yy + 22, 1063, yy + 22, "#4676da", 2),
      );
    else if (i > 0) s.push(L(531, yy - 23, 1063, yy - 23, "#e9edef"));
    const short = nm.length < 17 ? nm : nm.slice(0, 14) + "...";
    s.push(
      I("cube", 555, yy, 26, "#8e969c"),
      T(577, yy, short, 16.5, "#2a2f33"),
    );
    const [lab, fg, bg, bd] = CONG[p.congestion] ?? CONG.normal!;
    s.push(...chip(723, yy, lab === "Normal" ? 86 : 107, lab, fg, bg, bd));
    s.push(T(865, yy, lv.ts ? mon(lv.ts) : "n/a", 16, "#2a2f33"));
  });
  s.push(L(1063, 375, 1063, 857, "#e6eaec"));
  s.push(
    T(1085, 403, "Relevant objects", 16, "#2a2f33", 700),
    L(1064, 431, 1623, 431, "#e6eaec"),
  );
  const hz = lv.ch.get("Strait of Hormuz");
  const rel: [string, Res<unknown> | null, number | null][] = [
    ["Vessels inside", lv.choke, hz ? hz.vessels : null],
    ["Stationary", lv.choke, hz ? hz.stationary : null],
    [
      "SAR hulls, no AIS match",
      lv.sarRes,
      lv.sarRes?.ok ? lv.sar.length : null,
    ],
    ["NGA warnings inside", lv.warnRes, lv.warnRes?.ok ? hzWarnMsgs(lv) : null],
    [
      "Registry matches inside",
      lv.sancRes,
      lv.sancRes?.ok ? hzSanc(lv).length : null,
    ],
  ];
  const mx = Math.max(1, ...rel.map(([, , v]) => v ?? 0));
  rel.forEach(([lab, res, v], i) => {
    const yy = [460, 492, 525, 557, 589][i]!;
    s.push(
      T(1084, yy, lab, 16.5, "#2a2f33"),
      T(
        1527,
        yy,
        cnt(v === null && res?.ok ? { ...res, ok: false } : res, v ?? 0),
        16,
        "#2a2f33",
        400,
        "",
        "",
        "r",
      ),
    );
    s.push(
      R(1541, yy - 5, 65, 10, "#e1e7f3"),
      R(1541, yy - 5, Math.max(3, (65 * (v ?? 0)) / mx), 10, "#4674ca"),
    );
  });
  s.push(...mapA3(lv, 1064, 614, 1623, 857));
  if (dim) s.push(R(282, 98, 1176, 916, "rgba(30,34,38,.34)"));
  return s;
}

function handoff(lv: Live): [string, string | null, string, N][] {
  const hz = lv.ch.get("Strait of Hormuz");
  const n = lv.choke?.data?.features.length ?? 0;
  const hs = hzSanc(lv).length;
  return [
    [
      "I handed off to the ",
      "globe",
      "chokepoint feed",
      <>
        {" "}
        and received <b>{cnt(lv.choke, n)} chokepoints</b> from the snapshot of{" "}
        <b>{stampOf(lv)}</b>.
      </>,
    ],
    [
      "",
      null,
      "",
      hz ? (
        <>
          I identified that you were querying about <b>Strait of Hormuz</b>:{" "}
          <b>{hz.vessels} vessels</b> inside, <b>{hz.stationary}</b> stationary,
          congestion <b>{hz.congestion}</b>.
        </>
      ) : (
        <>{unavailable("Chokepoints", lv.choke)}.</>
      ),
    ],
    [
      "I handed off to the ",
      "shield",
      "sanctions registry",
      <>
        {" "}
        and kept the{" "}
        <b>
          {cnt(lv.sancRes, hs)} of {cnt(lv.sancRes, lv.sanc.length)}
        </b>{" "}
        matches inside the Hormuz box.
      </>,
    ],
    [
      "I generate a filter on ",
      "cube",
      "vessel",
      <>
        {" "}
        for <b>SAR hulls with no AIS match</b> in <b>aoi=hormuz</b>:{" "}
        <b>{cnt(lv.sarRes, lv.sar.length)}</b> dark candidates.
      </>,
    ],
    [
      "I placed this information in a ",
      "th",
      "card",
      " and use the ontology to render the most relevant fields / properties.",
    ],
  ];
}

function handCard(
  x: number,
  y: number,
  w: number,
  h: number,
  c: ReturnType<typeof handoff>[number],
): N[] {
  const [pre, ic, link, post] = c;
  return [
    R(x, y, w, h, "#fff", "#e8ecee"),
    <div
      className="a"
      style={{
        left: x + 19,
        top: y + 13,
        width: w - 36,
        fontSize: 16.5,
        lineHeight: "24px",
        color: "#2e3438",
      }}
    >
      {pre}
      {link ? (
        <span style={{ color: "#2f6fd0" }}>
          {ic ? <>{Ii(ic, "#2f6fd0")} </> : null}
          {link}
        </span>
      ) : null}
      {post}
    </div>,
  ];
}

function handoffPanel(lv: Live, onGraph: () => void, onClose: () => void): N[] {
  const s: N[] = [
    R(1458, 98, 414, 916, "#f6f8f9", "", "border-left:1px solid #d9dfe2"),
  ];
  s.push(T(1472, 124, "Hand-off inspector", 16.5, "#2a2f33", 700));
  s.push(
    R(1790, 106, 37, 36, "#fff", "#d9dfe2", "border-radius:2px"),
    I("graph", 1808, 124, 19, "#4a5358"),
    I("cross", 1851, 124, 17, "#3a4247"),
  );
  s.push(L(1459, 151, 1871, 151, "#e3e8ea"));
  const cards: [number, number][] = [
    [177, 101],
    [318, 94],
    [452, 126],
    [620, 122],
    [783, 125],
  ];
  const hc = handoff(lv);
  cards.forEach(([y, h], i) => {
    s.push(...handCard(1480, y, 374, h, hc[i]!));
    if (i < 4) s.push(I("arrow-down", 1666, y + h + 20, 17, "#4a5358"));
  });
  (lv.modelOn
    ? [
        "Trace written from the real requests behind the card.",
        "A local model is loaded; the card itself is still",
        "tool output, not model prose.",
      ]
    : [
        "Trace written from the real requests behind the card.",
        "The local model is off (HTTP 409), so no model-",
        "authored step is shown.",
      ]
  ).forEach((t, i) => s.push(T(1480, 944 + i * 15, t, 11.5, "#8a9397")));
  s.push(
    Hit(1790, 106, 37, 36, "Exploration and decision graph", onGraph),
    Hit(1838, 111, 26, 26, "Close the hand-off inspector", onClose),
  );
  return s;
}

function graphPanel(q: string, onTrace: () => void, onClose: () => void): N[] {
  const s: N[] = [
    R(1458, 98, 414, 916, "#fff", "", "border-left:1px solid #d9dfe2"),
  ];
  s.push(T(1472, 124, "Exploration and decision graph", 16.5, "#2a2f33", 700));
  s.push(
    R(1790, 106, 37, 36, "#fff", "#d9dfe2", "border-radius:2px"),
    I("search", 1808, 124, 19, "#4a5358"),
    I("cross", 1851, 124, 17, "#3a4247"),
  );
  s.push(L(1459, 151, 1871, 151, "#e3e8ea"));
  s.push(
    T(1472, 170, "Exploration", 16, "#2a2f33", 700),
    I("chevron-down", 1851, 170, 17, "#4a5358"),
    L(1459, 187, 1871, 187, "#e3e8ea"),
  );
  s.push(
    I("chevron-down", 1507, 208, 15, "#4a5358"),
    I("cube", 1553, 208, 20, "#2f6fd0"),
    T(1577, 208, "[Velocity] Chokepoint", 16, "#2a2f33", 700),
  );
  s.push(
    I("chevron-down", 1520, 240, 15, "#4a5358"),
    I("filter-list", 1567, 240, 20, "#4a5358"),
    T(1590, 240, q.length > 34 ? q.slice(0, 31) + "..." : q, 15.5, "#2a2f33"),
  );
  s.push(
    I("chevron-down", 1533, 272, 15, "#4a5358"),
    I("send-to-map", 1579, 272, 19, "#4a5358"),
    T(1603, 272, "Location: Strait of Hormuz", 15.5, "#2a2f33"),
  );
  s.push(
    I("chevron-down", 1533, 304, 15, "#4a5358"),
    I("map-marker", 1579, 304, 19, "#4a5358"),
    T(1603, 304, "chokepoint feed", 15.5, "#2a2f33"),
  );
  s.push(
    L(1459, 543, 1871, 543, "#e3e8ea"),
    T(1472, 561, "Decision Graph", 16, "#2a2f33", 700),
    I("chevron-down", 1851, 561, 17, "#4a5358"),
    L(1459, 578, 1871, 578, "#e3e8ea"),
  );
  s.push(R(1470, 591, 394, 416, "#fff", "#1e2a46", "border-width:2px"));
  s.push(L(1674, 662, 1674, 922, "#4a5358", 1));
  for (const [cy, ic] of [
    [659, "envelope"],
    [926, "globe"],
  ] as const)
    s.push(
      R(
        1657,
        cy - 17,
        35,
        35,
        "#fff",
        "#4a7fc8",
        "border-radius:50%;border-width:2px",
      ),
      I(ic, 1674, cy, 16, "#2f6fd0"),
    );
  s.push(
    Hit(1790, 106, 37, 36, "Hand-off inspector", onTrace),
    Hit(1838, 111, 26, 26, "Close the graph", onClose),
  );
  return s;
}

function bars(
  xAxis: number,
  yTop: number,
  yBot: number,
  ymax: number,
  step: number,
  labels: string[],
  vals: number[],
  sel: number,
  bw: number,
  xs: number[],
): N[] {
  const s: N[] = [
    L(xAxis, yTop - 3, xAxis, yBot, "#8a9397", 1),
    L(xAxis, yBot, xAxis + 480, yBot, "#8a9397", 1),
  ];
  for (let i = 0; i <= Math.floor(ymax / step); i++) {
    const v = i * step;
    const yy = yBot - ((yBot - yTop) * v) / ymax;
    s.push(
      T(xAxis - 18, yy, String(v), 12.5, "#4a5358", 400, "", "", "r"),
      L(xAxis - 4, yy, xAxis, yy, "#8a9397"),
    );
  }
  labels.forEach((lab, i) => {
    const cx = xs[i]!;
    const hh = ((yBot - yTop) * Math.min(vals[i]!, ymax)) / ymax;
    s.push(
      R(cx - bw / 2, yBot - hh, bw, hh, i === sel ? "#4a84e8" : "#9ebeee"),
    );
    s.push(T(cx, yBot + 19, lab, 9.5, "#4a5358", 400, "", "", "c"));
  });
  return s;
}

function a6Body(lv: Live, q: string[], onTrace: () => void): N[] {
  const s: N[] = [R(502, 152, 1148, 60, "#f2f6f8")];
  s.push(...avatar(518, 260), ...bubble(503, 286, 634, 42, q.slice(-1), 307));
  s.push(...assistant(518, 366));
  s.push(R(503, 392, 1146, 514, "#fff", "#4676da", "border-width:2px"));
  s.push(T(529, 432, "Vessels inside each chokepoint", 16, "#2a2f33", 700));
  s.push(
    R(1428, 414, 195, 36, "#cee0f4"),
    T(1442, 432, "Hand-off Inspector", 15, "#38507e"),
    I("panel-stats", 1603, 433, 19, "#38507e"),
  );
  s.push(
    T(
      529,
      471,
      <>
        Data was last refreshed on:{" "}
        <span style={{ color: "#2a2f33" }}>{stampOf(lv)}</span>
      </>,
      15,
      "#7a8388",
    ),
  );
  s.push(
    R(530, 495, 1092, 387, "#fff", "#e6eaec"),
    L(1076, 495, 1076, 882, "#e6eaec"),
    L(531, 551, 1622, 551, "#e6eaec"),
  );
  s.push(
    T(550, 523, "Vessels per chokepoint", 15, "#2a2f33", 700),
    T(1098, 523, "Stationary vessels per chokepoint", 15, "#2a2f33", 700),
  );
  const pick = [
    "Strait of Hormuz",
    "Suez / Gulf of Suez",
    "Bosphorus",
    "Panama Canal",
    "Strait of Gibraltar",
  ];
  const labs = ["Hormuz", "Suez", "Bosphorus", "Panama", "Gibraltar"];
  if (!lv.choke?.ok) {
    s.push(
      T(
        849,
        720,
        unavailable("Chokepoints", lv.choke),
        15,
        "#6a7378",
        400,
        "",
        "",
        "c",
      ),
    );
  } else {
    const v = pick.map((p) => lv.ch.get(p)?.vessels ?? 0);
    const st = pick.map((p) => lv.ch.get(p)?.stationary ?? 0);
    // the copy's axis is 0..400 by 100; a busier day widens it, never clips it
    const ymax = Math.max(400, Math.ceil(Math.max(...v) / 100) * 100);
    s.push(
      ...bars(
        590,
        598,
        842,
        ymax,
        100,
        labs,
        v,
        0,
        26,
        [668, 750, 832, 914, 996],
      ),
    );
    s.push(
      ...bars(
        1138,
        598,
        842,
        ymax,
        100,
        labs,
        st,
        0,
        26,
        [1216, 1298, 1380, 1462, 1544],
      ),
    );
  }
  s.push(Hit(1428, 414, 195, 36, "Hand-off Inspector", onTrace));
  return s;
}

// ── simulation (A13-A21) ─────────────────────────────────────────────────────
const CONF_TINT: Record<string, [string, string, string]> = {
  low: ["#f8eae2", "#a8641a", "Low"],
  medium: ["#e4f0e4", "#2f7d44", "Medium"],
  high: ["#f8e0e4", "#a02830", "High"],
};
const sarDate = (lv: Live): string =>
  lv.sarRes?.data
    ? dmy(new Date(lv.sarRes.data.summary.date + "T00:00:00Z"))
    : "n/a";
const byLen = (lv: Live): Sar[] =>
  [...lv.sar].sort((a, b) => b.lengthM - a.lengthM);

function modelBar(model: string, y = 232): N[] {
  return [
    R(304, y, 1545, 665, "#fff", "#e6eaec"),
    R(305, y + 1, 1543, 47, "#fff"),
    L(305, y + 47, 1848, y + 47, "#e6eaec"),
    T(
      317,
      y + 24,
      <>
        <b>Model:</b> <span style={{ color: "#38507e" }}>{model}</span>
      </>,
      16,
      "#2e3438",
    ),
    I("fullscreen", 1825, y + 24, 20, "#38507e"),
  ];
}

function a13(name: string): N[] {
  return [
    spinner(1076, 537),
    T(
      1075,
      603,
      <>
        Starting a simulation with{" "}
        <span style={{ color: "#38507e" }}>SAR dark-vessel screen</span> ·
      </>,
      17,
      "#59646a",
      400,
      "",
      "",
      "c",
    ),
    T(
      1075,
      637,
      <>
        Name your simulation{" "}
        <span style={{ color: "#38507e" }}>{name}</span>{" "}
      </>,
      17,
      "#59646a",
      400,
      "",
      "",
      "c",
    ),
    I("edit", 1318, 636, 17, "#38507e"),
  ];
}

function sarFail(lv: Live): N[] {
  return [
    T(
      1075,
      560,
      unavailable("SAR dark-vessel screen", lv.sarRes),
      17,
      "#59646a",
      400,
      "",
      "",
      "c",
    ),
  ];
}

function a14(lv: Live, onMap: () => void): N[] {
  const s: N[] = [...modelBar("SAR dark-vessel screen")];
  s.push(
    R(305, 281, 1543, 77, "#f2f6f6"),
    I("shopping-cart", 332, 328, 20, "#4a5358"),
    R(363, 316, 150, 29, "#e8ecec", "", "border-radius:2px"),
    T(438, 331, "Detections", 15.5, "#2e3438", 700, "", "", "c"),
  );
  s.push(
    R(1363, 312, 195, 34, "#c2feb6", "", "border-radius:2px"),
    T(
      1372,
      329,
      <>
        Dark candidates <b>{lv.sar.length}</b>
      </>,
      15.5,
      "#2a6a3a",
    ),
  );
  s.push(
    R(1580, 312, 253, 34, "#e2ecfa", "", "border-radius:2px"),
    I("map", 1600, 329, 17, "#38507e"),
    T(1619, 329, "View on map", 15.5, "#38507e"),
    I("arrow-right", 1810, 329, 17, "#38507e"),
  );
  s.push(R(305, 358, 1543, 59, "#f2f6f6"), L(305, 417, 1848, 417, "#e0e5e8"));
  const cols = [320, 647, 785, 956, 1095, 1321, 1464, 1703];
  const hdr = [
    ["Title"],
    ["Acquired"],
    ["Class", "candidate"],
    ["Class", "confidence"],
    ["AIS match"],
    ["Length (m)"],
    ["Source"],
    ["Heading"],
  ];
  cols.forEach((x, j) =>
    hdr[j]!.forEach((t, i) =>
      s.push(
        T(
          x,
          388 + (i - (hdr[j]!.length - 1) / 2) * 16,
          t,
          13.5,
          "#4a5358",
          700,
        ),
      ),
    ),
  );
  const rowh = [67, 67, 67, 66, 67, 67, 66];
  let y = 418;
  byLen(lv)
    .slice(0, 7)
    .forEach((sr, i) => {
      const h = rowh[i]!;
      const yc = y + h / 2;
      if (i === 1)
        s.push(
          R(305, y, 1543, h, "#f0f8fe"),
          L(305, y, 1848, y, "#a9c4e8"),
          L(305, y + h, 1848, y + h, "#a9c4e8"),
        );
      else s.push(L(305, y + h, 1848, y + h, "#e6eaec"));
      const [bg, fg, lab] = CONF_TINT[conf(sr)]!;
      s.push(
        R(941, y + (i !== 1 ? 1 : 0), 137, h - 1, bg),
        R(1079, y + 1, 225, h - 1, sr.aisMatch ? "#dcebe0" : "#e4e4e4"),
      );
      s.push(
        R(320, yc - 12, 28, 24, "#3f73d6", "", "border-radius:2px"),
        I("th", 334, yc, 15, "#fff"),
      );
      s.push(
        T(357, yc - 11, sarTitle(sr) + " (aoi hormuz)", 16, "#2e3438"),
        T(
          357,
          yc + 11,
          `${sr.lengthM.toFixed(0)} x ${sr.widthM.toFixed(0)} m hull, Sentinel-1`,
          16,
          "#2e3438",
        ),
      );
      s.push(T(647, yc, sarDate(lv), 16), T(785, yc, topCls(sr), 16));
      s.push(
        T(956, yc, lab, 16, fg),
        T(
          1095,
          yc,
          sr.aisMatch ? "AIS matched" : "No AIS match",
          16,
          "#2e3438",
        ),
      );
      s.push(
        T(1321, yc, sr.lengthM.toFixed(0), 16),
        T(1464, yc, "Sentinel-1", 16),
        T(1703, yc, `${sr.headingDeg.toFixed(0)}°`, 16),
      );
      y += h;
    });
  s.push(Hit(1580, 312, 253, 34, "View on map", onMap));
  return s;
}

interface HistTrack {
  id: string;
  points: number[][]; // [lon, lat, t, track]
}

function a15(
  lv: Live,
  hist: Res<{ tracks: HistTrack[] }> | null,
  onTable: () => void,
  onAnalysis: () => void,
): N[] {
  const s: N[] = [...modelBar("SAR dark-vessel screen")];
  const [LX0, LX1, PY0, PY1] = [305, 812, 360, 883];
  s.push(
    R(305, 298, 507, 62, "#e4e4e4"),
    I("history", 332, 329, 20, "#2a2f33"),
    T(362, 330, "Recorded AIS tracks", 16, "#2a2f33", 600),
    I("caret-left", 768, 329, 12, "#2a2f33"),
  );
  const [sx, sy] = scenePx(55.3, 25.78);
  const k = 1.12;
  s.push(
    lightmapDiv(
      LX0,
      PY0,
      LX1 - LX0,
      PY1 - PY0,
      sx,
      sy,
      k,
      (LX1 - LX0) / 2,
      (PY1 - PY0) / 2,
    ),
  );
  const proj = (lon: number, lat: number): [number, number] => {
    const [px, py] = scenePx(lon, lat);
    return [
      LX0 + (LX1 - LX0) / 2 + (px - sx) * k,
      PY0 + (PY1 - PY0) / 2 + (py - sy) * k,
    ];
  };
  const km = (a: number[], b: number[]): number =>
    6371 *
    Math.hypot(
      (((b[0]! - a[0]!) * Math.PI) / 180) * Math.cos((a[1]! * Math.PI) / 180),
      ((b[1]! - a[1]!) * Math.PI) / 180,
    );
  const trk = (hist?.data?.tracks ?? [])
    .filter((t) => t.points.length >= 10)
    .map((t) => ({
      t,
      path: t.points
        .slice(1)
        .reduce((acc, p, i) => acc + km(t.points[i]!, p), 0),
    }))
    .sort((a, b) => b.path - a.path)
    .slice(0, 8)
    .map((x) => x.t);
  const lines: N[] = [];
  const marks: N[] = [];
  for (const t of trk) {
    const pts = t.points.map((p) => proj(p[0]!, p[1]!));
    lines.push(
      <polyline
        points={pts
          .map(([a, b]) => `${a.toFixed(0)},${b.toFixed(0)}`)
          .join(" ")}
        fill="none"
        stroke="#111"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />,
    );
    // waypoints on the real fixes, coloured by the speed between fixes (the
    // history archive keeps position and time, not the reported sog)
    const step = Math.max(1, Math.floor(t.points.length / 3));
    for (let j = 0; j < t.points.length; j += step) {
      const p = t.points[j]!;
      const q = t.points[Math.min(j + 1, t.points.length - 1)]!;
      const dtH = Math.max((q[2]! - p[2]!) / 3600, 1e-6);
      const kn = j + 1 < t.points.length ? km(p, q) / dtH / 1.852 : 0;
      const c = kn >= 8 ? "#3aa655" : kn >= 3 ? "#e3b82d" : "#d64545";
      const [a, b] = proj(p[0]!, p[1]!);
      if (LX0 < a && a < LX1 && PY0 < b && b < PY1)
        marks.push(
          R(
            a - 8,
            b - 8,
            16,
            16,
            "#fff",
            c,
            "border-radius:50%;border-width:3px",
          ),
        );
    }
    const [a, b] = pts[pts.length - 1]!;
    if (LX0 + 10 < a && a < LX1 - 10 && PY0 + 10 < b && b < PY1 - 10)
      marks.push(
        R(
          a - 11,
          b - 11,
          22,
          22,
          "#3f73d6",
          "#fff",
          "border-radius:3px;border-width:2px",
        ),
        I("ship", a, b, 14, "#fff"),
      );
  }
  s.push(
    CLIP(LX0, PY0, LX1 - LX0, PY1 - PY0, [
      SVG(lines, 0, 0, 1920, 1080),
      ...marks,
    ]),
  );
  for (const [lab, lon, lat] of [
    ["Dubai", 55.27, 25.2],
    ["Sharjah", 55.4, 25.35],
    ["Das Island", 52.87, 25.15],
    ["Abu Dhabi", 54.37, 24.45],
  ] as const) {
    const [a, b] = proj(lon, lat);
    if (LX0 < a && a < LX1 && PY0 < b && b < PY1)
      s.push(T(a, b, lab, 15, "#59646a", 400, "", "", "c"));
  }
  const barKm = 20;
  s.push(
    R(
      369,
      855,
      (barKm / KM_PER_SCENE_PX) * k,
      12,
      "#fff",
      "#2a2f33",
      "border-top:0",
    ),
    T(375, 860, `${barKm} km`, 11, "#2a2f33"),
  );
  for (const [yy, ic] of [
    [680, "map"],
    [733, "zoom-to-fit"],
    [774, "zoom-in"],
    [810, "zoom-out"],
    [852, "compass"],
  ] as const)
    s.push(
      R(314, yy - 18, 40, 36, "#fff", "#cdd3d6", "border-radius:3px"),
      I(ic, 334, yy, 19, "#2a2f33"),
    );
  if (!trk.length) {
    const why =
      hist === null
        ? "Recorded AIS tracks loading"
        : !hist.ok
          ? unavailable("Recorded AIS tracks", hist)
          : "No recorded vessel track in this box";
    s.push(T(583, 857, why, 10.5, "#59646a"));
    if (hist?.ok)
      s.push(
        T(
          583,
          870,
          `GET /api/history/tracks returned ${hist.data?.tracks.length ?? 0} tracks`,
          10.5,
          "#59646a",
        ),
      );
  } else {
    const t0 = Math.min(...trk.map((t) => t.points[0]![2]!));
    const t1 = Math.max(...trk.map((t) => t.points[t.points.length - 1]![2]!));
    const d1 = new Date(t1 * 1000);
    s.push(
      T(
        583,
        857,
        `${trk.length} longest tracks, ${stamp(new Date(t0 * 1000)).slice(0, -4)} to ${String(d1.getUTCHours()).padStart(2, "0")}:${String(d1.getUTCMinutes()).padStart(2, "0")} UTC`,
        10.5,
        "#59646a",
      ),
    );
    s.push(
      T(
        583,
        870,
        "Waypoints: green >= 8 kn, yellow 3 to 8 kn, red < 3 kn (speed between fixes)",
        10.5,
        "#59646a",
      ),
    );
  }
  const [RX0, RX1] = [835, 1848];
  s.push(
    R(RX0, 298, RX1 - RX0, 62, "#e2ecfa"),
    I("predictive-analysis", 863, 329, 20, "#38507e"),
    T(893, 330, "SAR detections and registry matches", 16, "#38507e", 600),
  );
  s.push(
    R(1516, 311, 146, 36, "#2a2f33", "", "border-radius:2px"),
    I("caret-left", 1537, 329, 12, "#fff"),
    T(1553, 329, "View detections", 14.5, "#fff"),
  );
  s.push(
    R(1675, 311, 157, 36, "#2f6fd0", "", "border-radius:2px"),
    I("timeline-bar-chart", 1696, 329, 15, "#fff"),
    T(1714, 329, "View analysis", 14.5, "#fff"),
  );
  const [csx, csy] = scenePx(55.9, 26.3);
  const k2 = 0.58;
  s.push(
    lightmapDiv(
      RX0,
      PY0,
      RX1 - RX0,
      PY1 - PY0,
      csx,
      csy,
      k2,
      (RX1 - RX0) * 0.5,
      (PY1 - PY0) * 0.5,
    ),
  );
  const proj2 = (lon: number, lat: number): [number, number] => {
    const [px, py] = scenePx(lon, lat);
    return [
      RX0 + (RX1 - RX0) * 0.5 + (px - csx) * k2,
      PY0 + (PY1 - PY0) * 0.5 + (py - csy) * k2,
    ];
  };
  const mk: N[] = [];
  for (const sr of lv.sar) {
    const [a, b] = proj2(sr.xy[0], sr.xy[1]);
    if (!sr.aisMatch)
      mk.push(
        R(
          a - 7,
          b - 7,
          14,
          14,
          "#fff",
          "#e3b82d",
          "border-radius:50%;border-width:3px",
        ),
      );
  }
  const hs = hzSanc(lv);
  for (const sc of hs) {
    const [a, b] = proj2(sc.xy[0], sc.xy[1]);
    mk.push(
      R(
        a - 11,
        b - 11,
        22,
        22,
        "#3f73d6",
        "#fff",
        "border-radius:3px;border-width:2px",
      ),
      I("shield", a, b, 13, "#fff"),
    );
  }
  const hxy = lv.chxy.get("Strait of Hormuz") ?? [56.3, 26.6];
  const [ha, hb] = proj2(hxy[0]!, hxy[1]!);
  mk.push(
    R(
      ha - 16,
      hb - 16,
      32,
      32,
      "rgba(76,127,212,.10)",
      "#4c7fd4",
      "border-radius:50%;border-width:2px",
    ),
  );
  s.push(CLIP(RX0, PY0, RX1 - RX0, PY1 - PY0, mk));
  for (const [yy, ic] of [
    [680, "map"],
    [733, "zoom-to-fit"],
    [774, "zoom-in"],
    [810, "zoom-out"],
    [852, "compass"],
  ] as const)
    s.push(
      R(849, yy - 18, 40, 36, "#fff", "#cdd3d6", "border-radius:3px"),
      I(ic, 869, yy, 19, "#2a2f33"),
    );
  const hz = lv.ch.get("Strait of Hormuz");
  s.push(
    T(
      1120,
      870,
      `Yellow rings: ${lv.sar.length} SAR dark candidates. Blue squares: ${hs.length} registry matches. Ring: Strait of Hormuz (${hz ? hz.vessels : "n/a"} vessels).`,
      10.5,
      "#59646a",
    ),
  );
  s.push(
    Hit(1516, 311, 146, 36, "View detections", onTable),
    Hit(1675, 311, 157, 36, "View analysis", onAnalysis),
  );
  return s;
}

function kpi(
  x: number,
  y: number,
  w: number,
  h: number,
  bg: string,
  label: string,
  value: string,
): N[] {
  return [
    R(x, y, w, h, bg),
    T(x + 20, y + 29, label, 15, "#4a5358"),
    T(x + 20, y + 60, value, 16, "#2a2f33"),
  ];
}

function a16(lv: Live, onClose: () => void): N[] {
  const s: N[] = [...modelBar("SAR dark-vessel screen")];
  s.push(
    R(304, 279, 1415, 622, "#fff", "#e6eaec"),
    R(1720, 279, 129, 622, "#38424a"),
  );
  s.push(
    I("timeline-bar-chart", 317, 301, 22, "#4a5358"),
    T(343, 302, "Screen analysis", 21, "#2a2f33", 700),
    I("cross", 1693, 301, 17, "#2a2f33"),
    L(305, 326, 1718, 326, "#e0e5e8"),
  );
  s.push(
    R(304, 345, 1394, 156, "#f6f8f9"),
    T(320, 374, "CHANGES", 13, "#4a5358", 600),
    T(1009, 374, "IMPACT", 13, "#4a5358", 600),
  );
  const dark = lv.sar.filter((x) => x.darkCandidate).length;
  const ais = lv.sar.filter((x) => x.aisMatch).length;
  s.push(
    ...kpi(
      321,
      394,
      334,
      86,
      "#e4e4e4",
      "Detections screened",
      String(lv.sar.length),
    ),
  );
  s.push(...kpi(655, 394, 333, 86, "#e4e4e4", "Dark candidates", String(dark)));
  s.push(
    ...kpi(1009, 394, 333, 86, "#c0feb2", "AIS-matched hulls", String(ais)),
  );
  s.push(
    ...kpi(
      1342,
      394,
      333,
      86,
      "#b4d6fc",
      "Registry matches inside",
      String(hzSanc(lv).length),
    ),
  );
  s.push(R(304, 520, 1394, 363, "#fff", "#e6eaec"));
  s.push(
    T(
      354,
      690,
      "Detections",
      15,
      "#4a5358",
      400,
      "transform:translate(-50%,-52%) rotate(-90deg)",
    ),
  );
  const [xa, y0, y1] = [406, 558, 794];
  s.push(L(xa, y0, xa, y1, "#4a5358"), L(xa, y1, 1658, y1, "#4a5358"));
  const n = { low: 0, medium: 0, high: 0 };
  for (const x of lv.sar) n[conf(x)]++;
  // the copy's axis is 0..8 by 2; more hulls widen it, never clip a bar
  const ymax = Math.max(
    8,
    Math.ceil(Math.max(n.low, n.medium, n.high) / 2) * 2,
  );
  for (let v = 0; v <= ymax; v += 2) {
    const yy = y1 - ((y1 - y0) * v) / ymax;
    s.push(
      T(xa - 12, yy, String(v), 12.5, "#4a5358", 400, "", "", "r"),
      L(xa - 4, yy, xa, yy, "#4a5358"),
    );
    if (v) s.push(L(xa, yy, 1658, yy, "#dfe4e7"));
  }
  (
    [
      ["Low", n.low, "#c24856", 614],
      ["Medium", n.medium, "#469460", 1031],
      ["High", n.high, "#4a78c6", 1448],
    ] as const
  ).forEach(([lab, v, col, cx]) => {
    const hh = ((y1 - y0) * v) / ymax;
    s.push(
      R(cx - 145, y1 - hh, 290, hh, col),
      T(cx, y1 - hh - 10, String(v), 12.5, "#2a2f33", 400, "", "", "c"),
    );
    if (v)
      s.push(T(cx, y1 - hh / 2, String(v), 12.5, "#fff", 400, "", "", "c"));
    s.push(T(cx, y1 + 15, lab, 13, "#4a5358", 400, "", "", "c"));
  });
  s.push(T(1031, 835, "Class confidence", 15.5, "#2a2f33", 400, "", "", "c"));
  s.push(Hit(1680, 288, 26, 26, "Close the analysis", onClose));
  return s;
}

function a17(
  turn: { q: string; r: Reply | null } | null,
  onEdit: () => void,
): N[] {
  const s: N[] = [R(304, 209, 1545, 466, "#fff", "#e6eaec")];
  s.push(
    R(1056, 254, 15, 36, "#f1f3f5", "#dfe3e6", "border-radius:3px"),
    R(1080, 254, 17, 36, "#f1f3f5", "#dfe3e6", "border-radius:3px"),
  );
  s.push(T(1076, 338, "Model run paused", 24, "#59646a", 700, "", "", "c"));
  s.push(
    R(990, 386, 172, 34, "#fff", "#4a7fc8", "border-radius:2px"),
    I("settings", 1009, 403, 18, "#2f6fd0"),
    T(1089, 404, "Edit parameters", 15.5, "#2f6fd0", 400, "", "", "c"),
  );
  if (turn) {
    const ln = wrap(turn.q, 82).slice(0, 2);
    s.push(
      ...avatar(517, 732, "FH", true, true),
      ...bubble(502, 758, 722, bubbleH(ln.length), ln, 779),
    );
    s.push(
      ...assistant(517, 838 + 21 * (ln.length - 1), "AIP Assistant"),
      ...reply(502, 864 + 21 * (ln.length - 1), turn.r),
    );
  }
  s.push(Hit(990, 386, 172, 34, "Edit parameters", onEdit));
  return s;
}

const THS = [30, 50, 80];

function a18(lv: Live, sel: number, onPick: (i: number) => void): N[] {
  const s: N[] = [
    R(304, 233, 1545, 667, "#f2f6f8", "#e6eaec"),
    R(305, 252, 1543, 66, "#e4ecf6"),
    T(
      317,
      257,
      <>
        <b>Model:</b>{" "}
        <span style={{ color: "#38507e" }}>SAR hull-length threshold</span>
      </>,
      15,
      "#2e3438",
    ),
  ];
  s.push(
    I("fullscreen", 1825, 257, 20, "#38507e"),
    T(331, 285, "Hull-length scenario", 17, "#2f6fd0", 700),
    T(
      1280,
      285,
      "Impact of a minimum hull length on the list",
      16.5,
      "#2e3438",
    ),
  );
  s.push(
    R(1680, 268, 168, 34, "#fff"),
    T(1688, 285, "Results Generated", 15.5, "#2e3438"),
  );
  THS.forEach((thv, i) => {
    const { n, pct } = keepAtLeast(lv.sar, thv);
    const y = [356, 520, 677][i]!;
    const on = i === sel;
    s.push(R(307, y, 1538, 117, "#fff", "#e6eaec"));
    if (on) s.push(R(307, y - 8, 1538, 6, "#4676da"));
    const cy = y + 58;
    s.push(
      R(
        330,
        y + 20,
        191,
        76,
        on ? "#96cafc" : "#d4d4d4",
        on ? "#7fb4ea" : "#a9b3bb",
      ),
      T(352, cy, `≥ ${thv} m`, 28, on ? "#2f6fd0" : "#2a2f33", 400),
      I("arrow-up", 470, cy, 22, on ? "#2f6fd0" : "#2a2f33"),
    );
    s.push(
      R(684, y + 20, 569, 76, "#fff", "#dfe4e7"),
      T(704, cy, `${pct}%`, 28, "#2a2f33"),
      T(776, cy, "Detections kept", 15, "#4a5358", 600),
    );
    s.push(
      R(1253, y + 20, 569, 76, "#fff", "#dfe4e7"),
      T(1274, cy, String(n), 28, "#2a2f33"),
      T(1330, cy, "Dark candidates left", 15, "#4a5358", 600),
    );
    s.push(
      Hit(307, y, 1538, 117, `Run the ${thv} m threshold`, () => onPick(i)),
    );
  });
  return s;
}

function resultsHead(lv: Live, th: number): N[] {
  return [
    R(304, 233, 1545, 667, "#f2f6f8", "#e6eaec"),
    R(304, 233, 104, 667, "rgba(30,34,38,.72)"),
    R(431, 252, 1418, 78, "#e4ecf6"),
    R(454, 275, 42, 36, "#2f6fd0", "", "border-radius:2px"),
    I("shopping-cart", 475, 293, 20, "#fff"),
    R(518, 274, 54, 38, "#c6dff7", "", "border-radius:2px"),
    T(545, 293, `${th} m`, 15.5, "#2a2f33", 700, "", "", "c"),
    R(583, 276, 322, 34, "#dfe3e8", "", "border-radius:2px"),
    T(591, 293, "Detections kept above the threshold", 15.5, "#2a2f33", 700),
    R(1499, 276, 350, 34, "#dfe3e8"),
    T(
      1507,
      293,
      <>
        Dark candidates kept <b>{lv.sarRes ? keepAtLeast(lv.sar, th).n : ""}</b>
      </>,
      15.5,
      "#2a2f33",
    ),
    R(431, 352, 1418, 531, "#fff", "#e6eaec"),
    R(431, 352, 1418, 63, "#f6f8f9"),
    L(431, 415, 1849, 415, "#e0e5e8"),
  ];
}

function a19(lv: Live, th: number): N[] {
  const s = resultsHead(lv, th);
  const xs = [446, 738, 1029, 1321, 1612];
  for (let i = 0; i < 5; i++)
    s.push(
      R(
        xs[i]!,
        378,
        [66, 117, 92, 197, 91][i]!,
        11,
        "#dde0e3",
        "",
        "border-radius:2px",
      ),
    );
  const rows = [
    [184, 98, 170, 113, 142],
    [170, 112, 142, 184, 99],
    [142, 99, 184, 99, 113],
    [99, 170, 113, 142, 184],
    [113, 141, 184, 99, 170],
    [184, 99, 142, 113, 184],
    [170, 112, 99, 184, 99],
  ];
  [448, 519, 589, 659, 728, 798, 868].forEach((y, r) => {
    s.push(L(431, y + 35, 1849, y + 35, "#e6eaec"));
    for (let c = 0; c < 5; c++)
      s.push(
        R(
          xs[c]! + 7,
          y - 15,
          rows[r]![c]!,
          30,
          "#e4e6e8",
          "",
          "border-radius:3px",
        ),
      );
  });
  return s;
}

function a20(lv: Live, th: number, onBack: () => void): N[] {
  const s = resultsHead(lv, th);
  const xs = [454, 796, 964, 1143, 1319, 1487, 1736];
  const hdr = [
    ["Title"],
    ["Acquired"],
    ["Class", "candidate"],
    ["Class", "confidence"],
    ["Length (m)"],
    ["Source"],
    ["Heading"],
  ];
  xs.forEach((x, j) =>
    hdr[j]!.forEach((t, i) =>
      s.push(
        T(
          x,
          383 + (i - (hdr[j]!.length - 1) / 2) * 16,
          t,
          13.5,
          "#4a5358",
          700,
        ),
      ),
    ),
  );
  s.push(I("sort-desc", 1440, 383, 15, "#4a5358"));
  let y = 416;
  byLen(lv)
    .filter((x) => x.lengthM >= th)
    .slice(0, 6)
    .forEach((sr, i) => {
      const h = 70;
      const yc = y + h / 2;
      if (i === 2)
        s.push(
          R(431, y, 1418, h, "#f0f8fe"),
          L(431, y, 1849, y, "#a9c4e8"),
          L(431, y + h, 1849, y + h, "#a9c4e8"),
        );
      else s.push(L(431, y + h, 1849, y + h, "#e6eaec"));
      const [bg, fg, lab] = CONF_TINT[conf(sr)]!;
      s.push(
        R(1129, y + 1, 174, h - 1, bg),
        R(454, yc - 12, 28, 24, "#3f73d6", "", "border-radius:2px"),
        I("th", 468, yc, 15, "#fff"),
      );
      s.push(
        T(492, yc - 11, sarTitle(sr) + " (aoi hormuz)", 16),
        T(
          492,
          yc + 11,
          `${sr.lengthM.toFixed(0)} x ${sr.widthM.toFixed(0)} m hull, Sentinel-1`,
          16,
        ),
        T(796, yc, sarDate(lv), 16),
        T(964, yc, topCls(sr), 16),
      );
      s.push(
        T(1143, yc, lab, 16, fg),
        T(1319, yc, sr.lengthM.toFixed(0), 16),
        T(1487, yc, "Sentinel-1", 16),
        T(1736, yc, `${sr.headingDeg.toFixed(0)}°`, 16),
      );
      y += h;
    });
  s.push(Hit(304, 233, 104, 667, "Back to the scenario rows", onBack));
  return s;
}

function metricRow(
  x: number,
  y: number,
  col: string,
  glyph: string,
  bold: string,
  text: string,
): N[] {
  return [
    I("git-commit", x, y, 17, "#4a5358"),
    R(x + 31, y - 10, 20, 20, col, "", "border-radius:2px"),
    I(glyph, x + 41, y, 12, "#fff"),
    T(
      x + 56,
      y,
      <>
        <b>{bold}</b> {text}
      </>,
      15.5,
      "#2a2f33",
    ),
  ];
}

function a21(lv: Live, name: string, th: number, onClose: () => void): N[] {
  const s: N[] = [
    R(304, 233, 716, 667, "#f2f6f8"),
    R(282, 98, 738, 916, "rgba(30,34,38,.34)"),
  ];
  s.push(
    R(1020, 98, 852, 916, "#f2f6f8", "", "border-left:1px solid #d9dfe2"),
    R(1020, 98, 852, 58, "#fff"),
    L(1020, 156, 1872, 156, "#e3e8ea"),
  );
  s.push(
    T(1039, 127, `proposal-changes-${name.slice(11)}`, 20, "#2a2f33", 600),
    I("edit", 1460, 125, 17, "#4a5358"),
  );
  s.push(
    R(1683, 108, 168, 35, "#2252a0", "", "border-radius:2px"),
    T(1767, 126, "Propose 2 changes", 15.5, "#fff", 400, "", "", "c"),
  );
  s.push(R(1057, 180, 780, 276, "#fff", "#e3e8ea"));
  s.push(
    R(1070, 192, 32, 28, "#e6e8ea", "", "border-radius:50%"),
    T(1086, 206, "VL", 11, "#59646a", 700, "", "", "c"),
    T(1114, 206, `Simulation 1: ${name}`, 15.5, "#2a2f33", 700),
  );
  const owner = (
    <>
      Owner: <span style={{ color: "#38507e" }}>Local principal</span>
    </>
  );
  s.push(
    T(1118, 241, "Model: SAR dark-vessel screen", 15.5, "#4a5358"),
    T(1118, 268, owner, 15.5, "#4a5358"),
    L(1075, 296, 1818, 296, "#e3e8ea"),
  );
  const dark = lv.sar.filter((x) => x.darkCandidate).length;
  const hs = hzSanc(lv).length;
  s.push(
    ...metricRow(
      1096,
      328,
      "#8cae36",
      "dot",
      String(lv.sar.length),
      "Detections screened (total)",
    ),
  );
  s.push(
    ...metricRow(1096, 373, "#4aa38a", "th", String(dark), "Dark candidates"),
  );
  s.push(
    ...metricRow(
      1096,
      418,
      "#a22856",
      "shield",
      String(hs),
      "Registry matches inside the area",
    ),
  );
  s.push(R(1057, 475, 780, 310, "#fff", "#e3e8ea"));
  s.push(
    R(1070, 487, 32, 28, "#e6e8ea", "", "border-radius:50%"),
    T(1086, 501, "VL", 11, "#59646a", 700, "", "", "c"),
    T(1114, 501, `Simulation 2: ${name}`, 15.5, "#2a2f33", 700),
  );
  s.push(
    T(1118, 537, "Model: SAR dark-vessel screen", 15.5, "#4a5358"),
    T(1118, 564, owner, 15.5, "#4a5358"),
  );
  s.push(
    L(1447, 520, 1447, 580, "#e3e8ea"),
    T(1460, 537, "Model: SAR hull-length threshold", 15.5, "#4a5358"),
    T(1460, 564, owner, 15.5, "#4a5358"),
    L(1075, 592, 1818, 592, "#e3e8ea"),
  );
  const { n, pct } = keepAtLeast(lv.sar, th);
  s.push(
    ...metricRow(
      1096,
      624,
      "#8cae36",
      "dot",
      String(n),
      `Detections kept at ${th} m or more`,
    ),
  );
  s.push(
    ...metricRow(1096, 669, "#4aa38a", "th", `${pct}%`, "Of detections kept"),
  );
  s.push(
    ...metricRow(
      1096,
      714,
      "#4aa38a",
      "th",
      "n/a",
      "Hulls reviewed (no review log)",
    ),
  );
  s.push(
    ...metricRow(
      1096,
      759,
      "#a22856",
      "shield",
      "0",
      "Objects changed in the ontology",
    ),
  );
  s.push(
    Hit(282, 98, 738, 916, "Close the proposal", onClose),
    Hit(
      1683,
      108,
      168,
      35,
      "Propose 2 changes",
      undefined,
      "A scenario run changes no ontology object, so there is nothing to propose on this box",
    ),
  );
  return s;
}

// ── the terminal ─────────────────────────────────────────────────────────────
type Route = "a3" | "a6" | "none";
/** Which real tool query a prompt maps to; anything else needs the model. */
export function routeOf(q: string): Route {
  if (/stationary|each chokepoint|per chokepoint/i.test(q)) return "a6";
  if (/hormuz|chokepoint|congest|strait/i.test(q)) return "a3";
  return "none";
}

type Stage =
  "table" | "map" | "analysis" | "paused" | "scen" | "results" | "proposal";

export function Terminal({
  onFoundry,
  onHub,
  onInvestigate,
}: {
  onFoundry: () => void;
  onHub: () => void;
  /** Investigations tab: the investigation workspace (features/pdf). */
  onInvestigate?: () => void;
}): JSX.Element {
  const [turn, setTurn] = useState<{
    q: string;
    route: Route;
    r: Reply | null;
  } | null>(null);
  const [panel, setPanel] = useState<null | "handoff" | "graph">(null);
  const [sim, setSim] = useState<{
    name: string;
    stage: Stage;
    th: number;
  } | null>(null);
  const [turn2, setTurn2] = useState<{ q: string; r: Reply | null } | null>(
    null,
  );
  const [sarNonce, setSarNonce] = useState(0);
  const lv = useLive(sarNonce);
  const hist = useJson<{ tracks: HistTrack[] }>(
    sim?.stage === "map"
      ? "/api/history/tracks?kind=vessel&min_lon=54.9&min_lat=25.38&max_lon=55.7&max_lat=26.18&limit_ids=500"
      : null,
  );
  const lvRef = useRef(lv);
  lvRef.current = lv;

  useEffect(() => setPanel(null), [turn, sim]);

  const startSim = (): void => {
    setSim({ name: runName(new Date()), stage: "table", th: 50 });
    setTurn2(null);
    setSarNonce((n) => n + 1);
  };
  const go = (stage: Stage): void => setSim((s) => (s ? { ...s, stage } : s));

  const send = (q: string): void => {
    if (sim) {
      setTurn2({ q, r: null });
      if (sim.stage !== "paused") go("paused");
      const first = lvRef.current.sar[0];
      void askModel(
        lvRef.current,
        q,
        first
          ? {
              kind: "vessel",
              id: first.id,
              props: { lengthM: first.lengthM, widthM: first.widthM },
            }
          : undefined,
      ).then((r) => setTurn2((t) => (t && t.q === q ? { ...t, r } : t)));
      return;
    }
    const route = routeOf(q);
    setTurn({ q, route, r: null });
    if (route === "none")
      void askModel(lvRef.current, q).then((r) =>
        setTurn((t) => (t && t.q === q ? { ...t, r } : t)),
      );
  };

  const hits: ShellHits = {
    onLogo: onFoundry,
    onHub,
    onInvestigations: () => (sim ? setSim(null) : onInvestigate?.()),
    onProposals: startSim,
    sim: sim
      ? {
          name: sim.name,
          onPropose: () => go("proposal"),
          onNew: startSim,
          onExit: () => setSim(null),
        }
      : undefined,
  };

  const s: N[] = [];
  if (sim) {
    s.push(...aipShell(true, sim.name), ...shellHits(hits));
    const loading = lv.sarRes === null;
    const failed = lv.sarRes !== null && !lv.sarRes.ok;
    switch (sim.stage) {
      case "table":
        s.push(
          ...(loading
            ? a13(sim.name)
            : failed
              ? sarFail(lv)
              : a14(lv, () => go("map"))),
        );
        break;
      case "map":
        s.push(
          ...a15(
            lv,
            hist,
            () => go("table"),
            () => go("analysis"),
          ),
        );
        break;
      case "analysis":
        s.push(...a16(lv, () => go("paused")));
        break;
      case "paused":
        s.push(...a17(turn2, () => go("scen")));
        break;
      case "scen":
        s.push(
          ...a18(lv, THS.indexOf(sim.th), (i) => {
            setSim({ ...sim, th: THS[i]!, stage: "results" });
            setSarNonce((n) => n + 1);
          }),
        );
        break;
      case "results":
        s.push(
          ...(loading ? a19(lv, sim.th) : a20(lv, sim.th, () => go("scen"))),
        );
        break;
      case "proposal":
        s.push(...a21(lv, sim.name, sim.th, () => go("results")));
        break;
    }
  } else {
    s.push(...aipShell(true), ...shellHits(hits));
    const lines = turn ? wrap(turn.q) : [];
    if (!turn) s.push(contextLine(lv));
    else if (turn.route === "a3")
      s.push(
        ...a3Body(lv, lines, panel !== null),
        Hit(1436, 298, 182, 30, "Hand-off Inspector", () =>
          setPanel("handoff"),
        ),
      );
    else if (turn.route === "a6")
      s.push(
        ...a6Body(lv, lines, () => setPanel("handoff")),
        ...(panel ? [R(282, 98, 1176, 916, "rgba(30,34,38,.34)")] : []),
      );
    else {
      const ln = lines.slice(0, 3);
      const dy = 21 * (ln.length - 2);
      s.push(
        contextLine(lv),
        ...avatar(517, 253),
        ...bubble(502, 280, 634, bubbleH(ln.length), ln, 301, 21),
      );
      s.push(...assistant(517, 381 + dy), ...reply(502, 406 + dy, turn.r));
    }
    if (panel === "handoff")
      s.push(
        ...handoffPanel(
          lv,
          () => setPanel("graph"),
          () => setPanel(null),
        ),
      );
    if (panel === "graph")
      s.push(
        ...graphPanel(
          turn?.q ?? "",
          () => setPanel("handoff"),
          () => setPanel(null),
        ),
      );
  }
  // two fixed children, so the frame's changing element count never remounts
  // the composer (and its typed text)
  return (
    <>
      {frag(s)}
      <Composer onSend={send} />
    </>
  );
}
