// AIP terminal: features A1-A6 (chat over the live feeds) and A13-A21 (a
// scenario run over the real SAR dark-vessel screen), from
// gotham/aip/_build_features_a.py. Rebuilt as a native reflowing layout (tab
// row, centred conversation column, right drawer, pinned composer) instead of a
// cropped 1920x1080 frame. No model prose is drawn anywhere: an answer is
// either the real tool output (the route data) or the real response of POST
// /api/ai/selection/brief, which is 409 while no chat model is loaded. A value
// a route did not report renders as "—".
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "../../../transport/http.js";
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
  type Choke,
  type FC,
  type Res,
  type Sanc,
  type SancP,
  type Sar,
  type SarFC,
  type WarnP,
} from "./data.js";
import lightHormuz from "./lightHormuz.png";
import "./terminal.css";

const SAR_PATH = "/api/intel/dark-vessels/sar?aoi=hormuz";
const SPRITE = `${import.meta.env.BASE_URL}bp-sprite.svg#bp-`;

function Ico({ n, size = 16 }: { n: string; size?: number }): JSX.Element {
  return (
    <svg className="at-ico" aria-hidden width={size} height={size}>
      <use href={SPRITE + n} />
    </svg>
  );
}

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
/** A count from a route: "loading" in flight, "—" when the route failed. */
const cnt = (r: Res<unknown> | null, n: number): string =>
  r === null ? "loading" : r.ok ? String(n) : "—";

// ── composer ─────────────────────────────────────────────────────────────────
/** Owns the typed text, so a re-render of the page never drops it. */
function Composer({ onSend }: { onSend: (q: string) => void }): JSX.Element {
  const [q, setQ] = useState("");
  const send = (): void => {
    const v = q.trim();
    if (!v) return;
    onSend(v);
    setQ("");
  };
  return (
    <div className="at-comp">
      <div>
        <input
          aria-label="Ask AIP"
          placeholder="Start typing something to explore with AIP..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button
          type="button"
          className="at-btn pri"
          aria-label="Send"
          disabled={!q.trim()}
          onClick={send}
        >
          <Ico n="send-message" size={18} />
          Send
        </button>
      </div>
    </div>
  );
}

// ── chat pieces ──────────────────────────────────────────────────────────────
function Who({ you, grey }: { you?: boolean; grey?: boolean }): JSX.Element {
  return (
    <div className="at-who">
      <span className={`at-av ${you ? (grey ? "grey" : "") : "ai"}`}>
        <Ico n={you ? "person" : "chat"} size={16} />
      </span>
      <span>{you ? "(YOU)" : "AIP Assistant"}</span>
    </div>
  );
}

function Prompt({ q, grey }: { q: string; grey?: boolean }): JSX.Element {
  return (
    <div>
      <Who you {...(grey ? { grey } : {})} />
      <div className="at-bubble">{q}</div>
    </div>
  );
}

export interface Reply {
  status: number;
  text?: string | undefined;
  detail?: string | undefined;
}

/** The real outcome of the model call: typing dots while it is in flight, the
 *  route's own refusal when it refuses, the model's text when it answers. */
function ReplyView({ r }: { r: Reply | null }): JSX.Element {
  if (r === null)
    return (
      <span
        className="at-typing"
        role="status"
        aria-label="Waiting for a response"
      >
        <i />
        <i />
        <i />
      </span>
    );
  if (r.status === 200 && r.text)
    return <div className="at-reply">{r.text}</div>;
  const msg =
    r.status === 409
      ? "No response: no chat model loaded (HTTP 409, selection inference disabled)"
      : r.status === 0
        ? "No response: the model route did not answer (network error)"
        : `No response (HTTP ${r.status}${r.detail ? `, ${r.detail.slice(0, 60)}` : ""})`;
  return (
    <div className="at-reply mut">
      <i />
      {msg}
    </div>
  );
}

function Answer({ r }: { r: Reply | null }): JSX.Element {
  return (
    <div>
      <Who />
      <ReplyView r={r} />
    </div>
  );
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

function ContextLine({ lv }: { lv: Live }): JSX.Element {
  const pick = lv.hzWarn.find((w) => (w.p.text ?? "").trim()) ?? lv.hzWarn[0];
  if (!pick) {
    const why =
      lv.warnRes && !lv.warnRes.ok
        ? unavailable("NGA warnings", lv.warnRes)
        : lv.warnRes
          ? "no NGA warning inside the Hormuz box"
          : "NGA warnings loading";
    return (
      <p className="at-ctx">
        You are starting from <b>0 alerts</b>: {why}{" "}
        <span className="at-dot">&#9679;</span> NGA feed
      </p>
    );
  }
  const label = `NGA warning ${pick.p.navArea}-${pick.p.msgNumber}/${String(pick.p.msgYear).slice(2)}`;
  return (
    <p className="at-ctx">
      You are starting from <b>1 alert</b> from the{" "}
      <span style={{ color: "var(--lnk)" }}>{label}</span>{" "}
      <span className="at-dot">&#9679;</span> NGA feed
    </p>
  );
}

// text colours are AA on their own tint
const CONG: Record<string, [string, string, string, string]> = {
  high: ["Congested", "#a02830", "#f8e2e4", "#d9777a"],
  elevated: ["Elevated", "#7a4608", "#fbefdc", "#d9a35a"],
  normal: ["Normal", "#1f5a2f", "#e4f6ea", "#4a9a5a"],
};

// ── map plates: one SVG, so image, tracks and markers scale together ─────────
function MapPlate({
  w,
  h,
  sx,
  sy,
  k,
  fx,
  fy,
  label,
  children,
}: {
  w: number;
  h: number;
  /** scene px of the point that sits at (fx, fy) in the plate */
  sx: number;
  sy: number;
  k: number;
  fx: number;
  fy: number;
  label: string;
  children?: ReactNode;
}): JSX.Element {
  const id = useId().replace(/:/g, "");
  return (
    <div
      className="at-plate"
      style={{ aspectRatio: `${w} / ${h}` }}
      role="img"
      aria-label={label}
    >
      <svg viewBox={`0 0 ${w} ${h}`}>
        <defs>
          <clipPath id={id}>
            <rect width={w} height={h} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id})`}>
          <image
            href={lightHormuz}
            x={fx - sx * k}
            y={fy - sy * k}
            width={1882 * k}
            height={1242 * k}
            preserveAspectRatio="none"
          />
          {children}
        </g>
      </svg>
    </div>
  );
}

const Glyph = ({
  n,
  x,
  y,
  s,
}: {
  n: string;
  x: number;
  y: number;
  s: number;
}): JSX.Element => (
  <g style={{ color: "#fff", fill: "currentColor" }}>
    <use href={SPRITE + n} x={x - s / 2} y={y - s / 2} width={s} height={s} />
  </g>
);

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

function MapA3({ lv }: { lv: Live }): JSX.Element {
  const [w, h] = [560, 260];
  const xy = lv.chxy.get("Strait of Hormuz") ?? [56.3, 26.6];
  const [sx, sy] = scenePx(xy[0]!, xy[1]!);
  const k = 0.46;
  const [mx, my] = [w * 0.62, h * 0.5];
  return (
    <MapPlate
      w={w}
      h={h}
      sx={sx}
      sy={sy}
      k={k}
      fx={mx}
      fy={my}
      label="Strait of Hormuz and live AIS positions"
    >
      {lv.vessels.map((v, i) => {
        const [px, py] = scenePx(v.lon, v.lat);
        const qx = mx + (px - sx) * k;
        const qy = my + (py - sy) * k;
        return 3 < qx && qx < w - 3 && 3 < qy && qy < h - 3 ? (
          <rect
            key={i}
            x={Math.round(qx - 2)}
            y={Math.round(qy - 1)}
            width={5}
            height={3}
            rx={1}
            fill="#7d8a93"
          />
        ) : null;
      })}
      <text
        x={w * 0.2}
        y={h * 0.34}
        fontSize={12}
        fontWeight={600}
        letterSpacing={4}
        fill="#667077"
      >
        I R A N
      </text>
      <text
        x={w * 0.42}
        y={h * 0.8}
        fontSize={11}
        fontWeight={600}
        letterSpacing={3.5}
        fill="#667077"
      >
        O M A N
      </text>
      <circle
        cx={mx}
        cy={my}
        r={11}
        fill="rgba(76,127,212,.10)"
        stroke="#4c7fd4"
      />
      <circle cx={mx} cy={my} r={3} fill="#4c7fd4" />
      <rect
        x={mx + 14}
        y={my + 5}
        width={140}
        height={44}
        rx={2}
        fill="#fff"
        stroke="#e4e8ea"
      />
      <rect
        x={mx + 26}
        y={my + 15}
        width={24}
        height={24}
        rx={2}
        fill="#2f6fd0"
      />
      <Glyph n="cube" x={mx + 38} y={my + 27} s={15} />
      <text
        x={mx + 58}
        y={my + 24}
        fontSize={11}
        fontWeight={700}
        fill="#2a2f33"
      >
        Strait of Hormuz
      </text>
      <text x={mx + 58} y={my + 37} fontSize={10} fill="#566067">
        Chokepoint
      </text>
    </MapPlate>
  );
}

function A3({
  lv,
  onHandoff,
}: {
  lv: Live;
  onHandoff: () => void;
}): JSX.Element {
  const names = [
    ...CHOKE_ORDER.filter((n) => lv.ch.has(n)),
    ...[...lv.ch.keys()].filter((n) => !CHOKE_ORDER.includes(n)),
  ].slice(0, 8);
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
  return (
    <section className="at-card" aria-label="Chokepoints">
      <div className="at-ch">
        <h2>Chokepoints</h2>
        <button
          type="button"
          className="at-btn flat"
          aria-label="Hand-off Inspector"
          onClick={onHandoff}
        >
          Hand-off Inspector
          <Ico n="panel-stats" size={18} />
        </button>
      </div>
      <div className="at-cb">
        <div className="at-sub">
          Result of query: chokepoints by vessels inside, AIS snapshot{" "}
          {stampOf(lv)}
        </div>
        <div className="at-grid2">
          <div className="at-pane">
            <h3>Chokepoints: worldwide</h3>
            <div className="at-scrollx">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Last updated</th>
                  </tr>
                </thead>
                <tbody>
                  {!lv.choke?.ok ? (
                    <tr>
                      <td colSpan={3}>
                        {unavailable("Chokepoints", lv.choke)}
                      </td>
                    </tr>
                  ) : null}
                  {names.map((nm) => {
                    const p = lv.ch.get(nm)!;
                    const [lab, fg, bg, bd] =
                      CONG[p.congestion] ?? CONG.normal!;
                    return (
                      <tr
                        key={nm}
                        className={nm === "Strait of Hormuz" ? "hot" : ""}
                      >
                        <td>
                          <Ico n="cube" size={16} /> {nm}
                        </td>
                        <td>
                          <span
                            className="at-chip"
                            style={{
                              color: fg,
                              background: bg,
                              borderColor: bd,
                            }}
                          >
                            {lab}
                          </span>
                        </td>
                        <td className="nw">{lv.ts ? mon(lv.ts) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="at-pane">
            <h3>Relevant objects</h3>
            <div>
              {rel.map(([lab, res, v]) => (
                <div className="at-rel" key={lab}>
                  <span>{lab}</span>
                  <b>
                    {v === null
                      ? res === null
                        ? "loading"
                        : "—"
                      : cnt(res, v)}
                  </b>
                  <span className="at-meter">
                    <i
                      style={{
                        width: `${Math.max(3, (100 * (v ?? 0)) / mx)}%`,
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
            <MapA3 lv={lv} />
          </div>
        </div>
      </div>
    </section>
  );
}

// ── hand-off + graph drawers ─────────────────────────────────────────────────
function handoff(lv: Live): [string, string | null, string, ReactNode][] {
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

function Drawer({
  title,
  onClose,
  closeLabel,
  wide,
  head,
  children,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  wide?: boolean;
  head?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <>
      <div className="at-scrim" onClick={onClose} aria-hidden />
      <aside className={`at-drawer${wide ? " wide" : ""}`} aria-label={title}>
        <div className="at-dh">
          <h2>{title}</h2>
          {head}
          <button
            type="button"
            className="at-btn flat"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <Ico n="cross" size={16} />
          </button>
        </div>
        <div className="at-db">{children}</div>
      </aside>
    </>
  );
}

function HandoffPanel({
  lv,
  onGraph,
  onClose,
}: {
  lv: Live;
  onGraph: () => void;
  onClose: () => void;
}): JSX.Element {
  const hc = handoff(lv);
  return (
    <Drawer
      title="Hand-off inspector"
      onClose={onClose}
      closeLabel="Close the hand-off inspector"
      head={
        <button
          type="button"
          className="at-btn"
          aria-label="Exploration and decision graph"
          onClick={onGraph}
        >
          <Ico n="graph" size={16} />
        </button>
      }
    >
      {hc.map(([pre, ic, link, post], i) => (
        <div key={i}>
          <div className="at-hc">
            {pre}
            {link ? (
              <span className="lk">
                {ic ? <Ico n={ic} /> : null} {link}
              </span>
            ) : null}
            {post}
          </div>
          {i < hc.length - 1 ? (
            <div className="at-arrow">
              <Ico n="arrow-down" size={16} />
            </div>
          ) : null}
        </div>
      ))}
      <p className="at-sub" style={{ marginTop: 16 }}>
        Trace written from the real requests behind the card.{" "}
        {lv.modelOn
          ? "A local model is loaded; the card itself is still tool output, not model prose."
          : "The local model is off (HTTP 409), so no model-authored step is shown."}
      </p>
    </Drawer>
  );
}

function GraphPanel({
  q,
  onTrace,
  onClose,
}: {
  q: string;
  onTrace: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Drawer
      title="Exploration and decision graph"
      onClose={onClose}
      closeLabel="Close the graph"
      head={
        <button
          type="button"
          className="at-btn"
          aria-label="Hand-off inspector"
          onClick={onTrace}
        >
          <Ico n="search" size={16} />
        </button>
      }
    >
      <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Exploration</h3>
      <ul className="at-tree">
        <li>
          <Ico n="cube" size={18} />
          <b>[Velocity] Chokepoint</b>
        </li>
        <li style={{ paddingLeft: 16 }}>
          <Ico n="filter-list" size={18} />
          <span title={q}>{q}</span>
        </li>
        <li style={{ paddingLeft: 32 }}>
          <Ico n="send-to-map" size={18} />
          <span>Location: Strait of Hormuz</span>
        </li>
        <li style={{ paddingLeft: 32 }}>
          <Ico n="map-marker" size={18} />
          <span>chokepoint feed</span>
        </li>
      </ul>
      <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Decision Graph</h3>
      <div className="at-dg">
        <span className="at-node">
          <Ico n="envelope" size={16} />
        </span>
        <i />
        <span className="at-node">
          <Ico n="globe" size={16} />
        </span>
      </div>
    </Drawer>
  );
}

// ── column chart (A6) ────────────────────────────────────────────────────────
function Columns({
  labels,
  vals,
  ymax,
  step,
  colors,
  title,
}: {
  labels: string[];
  vals: number[];
  ymax: number;
  step: number;
  colors: string[];
  title: string;
}): JSX.Element {
  const ticks: number[] = [];
  for (let v = 0; v <= ymax; v += step) ticks.push(v);
  return (
    <div
      className="at-chart"
      role="img"
      aria-label={`${title}: ${labels.map((l, i) => `${l} ${vals[i]}`).join(", ")}`}
    >
      <div className="at-yax">
        {ticks.map((t) => (
          <span key={t} style={{ bottom: `${(100 * t) / ymax}%` }}>
            {t}
          </span>
        ))}
      </div>
      <div className="at-plot">
        {ticks.slice(1).map((t) => (
          <i key={t} style={{ bottom: `${(100 * t) / ymax}%` }} />
        ))}
        {labels.map((l, i) => (
          <div
            key={l}
            className="at-bar"
            style={{
              height: `${(100 * Math.min(vals[i]!, ymax)) / ymax}%`,
              background: colors[i],
            }}
          >
            <b>{vals[i]}</b>
          </div>
        ))}
      </div>
      <div className="at-xlab">
        {labels.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
    </div>
  );
}

function A6({
  lv,
  onHandoff,
}: {
  lv: Live;
  onHandoff: () => void;
}): JSX.Element {
  const pick = [
    "Strait of Hormuz",
    "Suez / Gulf of Suez",
    "Bosphorus",
    "Panama Canal",
    "Strait of Gibraltar",
  ];
  const labs = ["Hormuz", "Suez", "Bosphorus", "Panama", "Gibraltar"];
  const v = pick.map((p) => lv.ch.get(p)?.vessels ?? 0);
  const st = pick.map((p) => lv.ch.get(p)?.stationary ?? 0);
  // the copy's axis is 0..400 by 100; a busier day widens it, never clips it
  const ymax = Math.max(400, Math.ceil(Math.max(...v, ...st) / 100) * 100);
  const cols = ["#4a84e8", "#9ebeee", "#9ebeee", "#9ebeee", "#9ebeee"];
  return (
    <section
      className="at-card sel"
      aria-label="Vessels inside each chokepoint"
    >
      <div className="at-ch">
        <h2>Vessels inside each chokepoint</h2>
        <button
          type="button"
          className="at-btn flat"
          aria-label="Hand-off Inspector"
          onClick={onHandoff}
        >
          Hand-off Inspector
          <Ico n="panel-stats" size={18} />
        </button>
      </div>
      <div className="at-cb">
        <div className="at-sub">
          Data was last refreshed on:{" "}
          <span style={{ color: "var(--ink)" }}>{stampOf(lv)}</span>
        </div>
        {!lv.choke?.ok ? (
          <div className="at-center">
            {unavailable("Chokepoints", lv.choke)}
          </div>
        ) : (
          <div className="at-grid2">
            <div className="at-pane">
              <h3>Vessels per chokepoint</h3>
              <Columns
                labels={labs}
                vals={v}
                ymax={ymax}
                step={100}
                colors={cols}
                title="Vessels per chokepoint"
              />
            </div>
            <div className="at-pane">
              <h3>Stationary vessels per chokepoint</h3>
              <Columns
                labels={labs}
                vals={st}
                ymax={ymax}
                step={100}
                colors={cols}
                title="Stationary vessels per chokepoint"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ── simulation (A13-A21) ─────────────────────────────────────────────────────
// text colours are AA on their own tint
const CONF_TINT: Record<string, [string, string, string]> = {
  low: ["#f8eae2", "#7a4608", "Low"],
  medium: ["#e4f0e4", "#1f5a2f", "Medium"],
  high: ["#f8e0e4", "#a02830", "High"],
};
const sarDate = (lv: Live): string =>
  lv.sarRes?.data
    ? dmy(new Date(lv.sarRes.data.summary.date + "T00:00:00Z"))
    : "—";
const byLen = (lv: Live): Sar[] =>
  [...lv.sar].sort((a, b) => b.lengthM - a.lengthM);

function ModelBar({ model }: { model: string }): JSX.Element {
  return (
    <div className="at-model">
      <b>Model:</b> <span>{model}</span>
    </div>
  );
}

function Loading({ name }: { name: string }): JSX.Element {
  return (
    <div className="at-center" role="status">
      <div className="at-spin" />
      <div>
        Starting a simulation with{" "}
        <span style={{ color: "var(--lnk)" }}>SAR dark-vessel screen</span> ·
      </div>
      <div>
        Name your simulation <span style={{ color: "var(--lnk)" }}>{name}</span>
      </div>
    </div>
  );
}

function SarTable({
  lv,
  rows,
  ais,
}: {
  lv: Live;
  rows: Sar[];
  ais: boolean;
}): JSX.Element {
  return (
    <div className="at-scrollx">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Acquired</th>
            <th>Class candidate</th>
            <th>Class confidence</th>
            {ais ? <th>AIS match</th> : null}
            <th>Length (m)</th>
            <th>Source</th>
            <th>Heading</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((sr) => {
            const [bg, fg, lab] = CONF_TINT[conf(sr)]!;
            return (
              <tr key={sr.id}>
                <td>
                  <div>{sarTitle(sr)} (aoi hormuz)</div>
                  <div className="at-sub">
                    {sr.lengthM.toFixed(0)} x {sr.widthM.toFixed(0)} m hull,
                    Sentinel-1
                  </div>
                </td>
                <td className="nw">{sarDate(lv)}</td>
                <td className="nw">{topCls(sr)}</td>
                <td className="nw" style={{ background: bg, color: fg }}>
                  {lab}
                </td>
                {ais ? (
                  <td
                    className="nw"
                    style={{ background: sr.aisMatch ? "#dcebe0" : "#e4e4e4" }}
                  >
                    {sr.aisMatch ? "AIS matched" : "No AIS match"}
                  </td>
                ) : null}
                <td className="nw">{sr.lengthM.toFixed(0)}</td>
                <td className="nw">Sentinel-1</td>
                <td className="nw">{sr.headingDeg.toFixed(0)}°</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function A14({ lv, onMap }: { lv: Live; onMap: () => void }): JSX.Element {
  return (
    <section className="at-card" aria-label="Detections">
      <ModelBar model="SAR dark-vessel screen" />
      <div className="at-bar2">
        <span className="at-tag">Detections</span>
        <span className="at-grow" />
        <span className="at-tag ok">
          Dark candidates <b>{lv.sar.length}</b>
        </span>
        <button
          type="button"
          className="at-btn"
          aria-label="View on map"
          onClick={onMap}
        >
          <Ico n="map" size={16} />
          View on map
        </button>
      </div>
      <SarTable lv={lv} rows={byLen(lv).slice(0, 7)} ais />
    </section>
  );
}

interface HistTrack {
  id: string;
  points: number[][]; // [lon, lat, t, track]
}

const kmBetween = (a: number[], b: number[]): number =>
  6371 *
  Math.hypot(
    (((b[0]! - a[0]!) * Math.PI) / 180) * Math.cos((a[1]! * Math.PI) / 180),
    ((b[1]! - a[1]!) * Math.PI) / 180,
  );

/** The eight longest recorded tracks of at least ten fixes. */
function longestTracks(hist: Res<{ tracks: HistTrack[] }> | null): HistTrack[] {
  return (hist?.data?.tracks ?? [])
    .filter((t) => t.points.length >= 10)
    .map((t) => ({
      t,
      path: t.points
        .slice(1)
        .reduce((acc, p, i) => acc + kmBetween(t.points[i]!, p), 0),
    }))
    .sort((a, b) => b.path - a.path)
    .slice(0, 8)
    .map((x) => x.t);
}

const HEAD_PLATE = { w: 600, h: 420 };

function A15({
  lv,
  hist,
  onTable,
  onAnalysis,
}: {
  lv: Live;
  hist: Res<{ tracks: HistTrack[] }> | null;
  onTable: () => void;
  onAnalysis: () => void;
}): JSX.Element {
  const { w, h } = HEAD_PLATE;
  const trk = longestTracks(hist);
  const [sx, sy] = scenePx(55.3, 25.78);
  const k = 1.12;
  const proj = (lon: number, lat: number): [number, number] => {
    const [px, py] = scenePx(lon, lat);
    return [w / 2 + (px - sx) * k, h / 2 + (py - sy) * k];
  };
  const inside = (a: number, b: number, m = 0): boolean =>
    m < a && a < w - m && m < b && b < h - m;
  const barKm = 20;
  let caption: ReactNode;
  if (!trk.length) {
    const why =
      hist === null
        ? "Recorded AIS tracks loading"
        : !hist.ok
          ? unavailable("Recorded AIS tracks", hist)
          : "No recorded vessel track in this box";
    caption = (
      <>
        {why}
        {hist?.ok ? <br /> : null}
        {hist?.ok
          ? `GET /api/history/tracks returned ${hist.data?.tracks.length ?? 0} tracks`
          : null}
      </>
    );
  } else {
    const t0 = Math.min(...trk.map((t) => t.points[0]![2]!));
    const t1 = Math.max(...trk.map((t) => t.points[t.points.length - 1]![2]!));
    const d1 = new Date(t1 * 1000);
    caption = (
      <>
        {trk.length} longest tracks, {stamp(new Date(t0 * 1000)).slice(0, -4)}{" "}
        to {String(d1.getUTCHours()).padStart(2, "0")}:
        {String(d1.getUTCMinutes()).padStart(2, "0")} UTC
        <br />
        Waypoints: green &gt;= 8 kn, yellow 3 to 8 kn, red &lt; 3 kn (speed
        between fixes)
      </>
    );
  }

  const [csx, csy] = scenePx(55.9, 26.3);
  const k2 = 0.36;
  const proj2 = (lon: number, lat: number): [number, number] => {
    const [px, py] = scenePx(lon, lat);
    return [w * 0.5 + (px - csx) * k2, h * 0.5 + (py - csy) * k2];
  };
  const hs = hzSanc(lv);
  const hxy = lv.chxy.get("Strait of Hormuz") ?? [56.3, 26.6];
  const [ha, hb] = proj2(hxy[0]!, hxy[1]!);
  const hz = lv.ch.get("Strait of Hormuz");

  return (
    <section
      className="at-card"
      aria-label="Recorded AIS tracks and detections"
    >
      <ModelBar model="SAR dark-vessel screen" />
      <div className="at-cb">
        <div className="at-grid2">
          <div className="at-pane">
            <h3>
              <Ico n="history" /> Recorded AIS tracks
            </h3>
            <MapPlate
              w={w}
              h={h}
              sx={sx}
              sy={sy}
              k={k}
              fx={w / 2}
              fy={h / 2}
              label="Recorded AIS tracks over the Dubai coast"
            >
              {trk.map((t) => (
                <polyline
                  key={t.id}
                  points={t.points
                    .map((p) =>
                      proj(p[0]!, p[1]!)
                        .map((n) => n.toFixed(0))
                        .join(","),
                    )
                    .join(" ")}
                  fill="none"
                  stroke="#111"
                  strokeWidth={2.4}
                  strokeLinejoin="round"
                />
              ))}
              {trk.flatMap((t) => {
                // waypoints on the real fixes, coloured by the speed between fixes
                // (the history archive keeps position and time, not the reported sog)
                const step = Math.max(1, Math.floor(t.points.length / 3));
                const out: ReactNode[] = [];
                for (let j = 0; j < t.points.length; j += step) {
                  const p = t.points[j]!;
                  const q = t.points[Math.min(j + 1, t.points.length - 1)]!;
                  const dtH = Math.max((q[2]! - p[2]!) / 3600, 1e-6);
                  const kn =
                    j + 1 < t.points.length ? kmBetween(p, q) / dtH / 1.852 : 0;
                  const c =
                    kn >= 8 ? "#3aa655" : kn >= 3 ? "#e3b82d" : "#d64545";
                  const [a, b] = proj(p[0]!, p[1]!);
                  if (inside(a, b))
                    out.push(
                      <circle
                        key={`${t.id}-${j}`}
                        cx={a}
                        cy={b}
                        r={7}
                        fill="#fff"
                        stroke={c}
                        strokeWidth={3}
                      />,
                    );
                }
                const last = t.points[t.points.length - 1]!;
                const [a, b] = proj(last[0]!, last[1]!);
                if (inside(a, b, 10))
                  out.push(
                    <g key={`${t.id}-end`}>
                      <rect
                        x={a - 11}
                        y={b - 11}
                        width={22}
                        height={22}
                        rx={3}
                        fill="#3f73d6"
                        stroke="#fff"
                        strokeWidth={2}
                      />
                      <Glyph n="ship" x={a} y={b} s={14} />
                    </g>,
                  );
                return out;
              })}
              {(
                [
                  ["Dubai", 55.27, 25.2],
                  ["Sharjah", 55.4, 25.35],
                  ["Das Island", 52.87, 25.15],
                  ["Abu Dhabi", 54.37, 24.45],
                ] as const
              ).map(([lab, lon, lat]) => {
                const [a, b] = proj(lon, lat);
                return inside(a, b) ? (
                  <text
                    key={lab}
                    x={a}
                    y={b}
                    fontSize={15}
                    textAnchor="middle"
                    fill="#3f494f"
                  >
                    {lab}
                  </text>
                ) : null;
              })}
              <rect
                x={16}
                y={h - 28}
                width={(barKm / KM_PER_SCENE_PX) * k}
                height={10}
                fill="#fff"
                stroke="#2a2f33"
              />
              <text x={16} y={h - 34} fontSize={12} fill="#2a2f33">
                {barKm} km
              </text>
            </MapPlate>
            <div className="at-cap">{caption}</div>
          </div>
          <div className="at-pane">
            <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1 }}>
                <Ico n="predictive-analysis" /> SAR detections and registry
                matches
              </span>
              <button
                type="button"
                className="at-btn"
                aria-label="View detections"
                onClick={onTable}
              >
                <Ico n="caret-left" size={12} />
                View detections
              </button>
              <button
                type="button"
                className="at-btn pri"
                aria-label="View analysis"
                onClick={onAnalysis}
              >
                <Ico n="timeline-bar-chart" size={16} />
                View analysis
              </button>
            </h3>
            <MapPlate
              w={w}
              h={h}
              sx={csx}
              sy={csy}
              k={k2}
              fx={w * 0.5}
              fy={h * 0.5}
              label="SAR dark candidates and registry matches"
            >
              {lv.sar
                .filter((sr) => !sr.aisMatch)
                .map((sr) => {
                  const [a, b] = proj2(sr.xy[0], sr.xy[1]);
                  return (
                    <circle
                      key={sr.id}
                      cx={a}
                      cy={b}
                      r={7}
                      fill="#fff"
                      stroke="#e3b82d"
                      strokeWidth={3}
                    />
                  );
                })}
              {hs.map((sc) => {
                const [a, b] = proj2(sc.xy[0], sc.xy[1]);
                return (
                  <g key={sc.mmsi}>
                    <rect
                      x={a - 11}
                      y={b - 11}
                      width={22}
                      height={22}
                      rx={3}
                      fill="#3f73d6"
                      stroke="#fff"
                      strokeWidth={2}
                    />
                    <Glyph n="shield" x={a} y={b} s={13} />
                  </g>
                );
              })}
              <circle
                cx={ha}
                cy={hb}
                r={16}
                fill="rgba(76,127,212,.10)"
                stroke="#4c7fd4"
                strokeWidth={2}
              />
            </MapPlate>
            <div className="at-cap">
              Yellow rings: {lv.sar.length} SAR dark candidates. Blue squares:{" "}
              {hs.length} registry matches. Ring: Strait of Hormuz (
              {hz ? hz.vessels : "—"} vessels).
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function A16({ lv, onClose }: { lv: Live; onClose: () => void }): JSX.Element {
  const dark = lv.sar.filter((x) => x.darkCandidate).length;
  const ais = lv.sar.filter((x) => x.aisMatch).length;
  const n = { low: 0, medium: 0, high: 0 };
  for (const x of lv.sar) n[conf(x)]++;
  // the copy's axis is 0..8 by 2; more hulls widen it, never clip a bar
  const ymax = Math.max(
    8,
    Math.ceil(Math.max(n.low, n.medium, n.high) / 2) * 2,
  );
  const kpis: [string, number, string][] = [
    ["Detections screened", lv.sar.length, ""],
    ["Dark candidates", dark, ""],
    ["AIS-matched hulls", ais, "g"],
    ["Registry matches inside", hzSanc(lv).length, "b"],
  ];
  return (
    <section className="at-card" aria-label="Screen analysis">
      <ModelBar model="SAR dark-vessel screen" />
      <div className="at-ch">
        <h2>
          <Ico n="timeline-bar-chart" size={20} /> Screen analysis
        </h2>
        <button
          type="button"
          className="at-btn flat"
          aria-label="Close the analysis"
          onClick={onClose}
        >
          <Ico n="cross" size={16} />
        </button>
      </div>
      <div className="at-cb">
        <div className="at-kpis">
          {kpis.map(([lab, v, c]) => (
            <div key={lab} className={`at-kpi ${c}`}>
              <span>{lab}</span>
              <b>{v}</b>
            </div>
          ))}
        </div>
        <div className="at-pane">
          <h3>Class confidence</h3>
          <Columns
            labels={["Low", "Medium", "High"]}
            vals={[n.low, n.medium, n.high]}
            ymax={ymax}
            step={2}
            colors={["#c24856", "#469460", "#4a78c6"]}
            title="Detections by class confidence"
          />
        </div>
      </div>
    </section>
  );
}

function A17({
  turn,
  onEdit,
}: {
  turn: { q: string; r: Reply | null } | null;
  onEdit: () => void;
}): JSX.Element {
  return (
    <>
      <section className="at-card" aria-label="Model run paused">
        <div className="at-center">
          <h2 style={{ margin: 0, fontSize: 24 }}>Model run paused</h2>
          <button
            type="button"
            className="at-btn"
            aria-label="Edit parameters"
            onClick={onEdit}
          >
            <Ico n="settings" size={16} />
            Edit parameters
          </button>
        </div>
      </section>
      {turn ? (
        <>
          <Prompt q={turn.q} grey />
          <Answer r={turn.r} />
        </>
      ) : null}
    </>
  );
}

const THS = [30, 50, 80];

function A18({
  lv,
  sel,
  onPick,
}: {
  lv: Live;
  sel: number;
  onPick: (i: number) => void;
}): JSX.Element {
  return (
    <section className="at-card" aria-label="Hull-length scenario">
      <ModelBar model="SAR hull-length threshold" />
      <div className="at-ch">
        <h2 style={{ color: "var(--pri)" }}>Hull-length scenario</h2>
        <span>Impact of a minimum hull length on the list</span>
        <span className="at-sub">Results Generated</span>
      </div>
      <div className="at-cb">
        {THS.map((thv, i) => {
          const { n, pct } = keepAtLeast(lv.sar, thv);
          return (
            <button
              key={thv}
              type="button"
              className={`at-th${i === sel ? " on" : ""}`}
              aria-label={`Run the ${thv} m threshold`}
              onClick={() => onPick(i)}
            >
              <div>{`≥ ${thv} m`}</div>
              <div>
                <b>{pct}%</b>
                <span>Detections kept</span>
              </div>
              <div>
                <b>{n}</b>
                <span>Dark candidates left</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function A20({
  lv,
  th,
  loading,
  onBack,
}: {
  lv: Live;
  th: number;
  loading: boolean;
  onBack: () => void;
}): JSX.Element {
  return (
    <section className="at-card" aria-label="Scenario results">
      <div className="at-bar2" style={{ background: "#e4ecf6" }}>
        <button
          type="button"
          className="at-btn"
          aria-label="Back to the scenario rows"
          onClick={onBack}
        >
          <Ico n="caret-left" size={12} />
          Back
        </button>
        <span className="at-tag" style={{ background: "#c6dff7" }}>
          {th} m
        </span>
        <span className="at-tag" style={{ background: "#dfe3e8" }}>
          Detections kept above the threshold
        </span>
        <span className="at-grow" />
        <span
          className="at-tag ok"
          style={{ background: "#dfe3e8", color: "var(--ink)" }}
        >
          Dark candidates kept{" "}
          <b>{lv.sarRes ? keepAtLeast(lv.sar, th).n : "…"}</b>
        </span>
      </div>
      {loading ? (
        <div className="at-center" role="status">
          <div className="at-spin" />
          Loading results
        </div>
      ) : (
        <SarTable
          lv={lv}
          rows={byLen(lv)
            .filter((x) => x.lengthM >= th)
            .slice(0, 6)}
          ais={false}
        />
      )}
    </section>
  );
}

function Metric({
  icon,
  value,
  text,
}: {
  icon: string;
  value: string;
  text: string;
}): JSX.Element {
  return (
    <div className="at-mrow">
      <Ico n={icon} size={16} />
      <span>
        <b>{value}</b> {text}
      </span>
    </div>
  );
}

function A21({
  lv,
  name,
  th,
  onClose,
}: {
  lv: Live;
  name: string;
  th: number;
  onClose: () => void;
}): JSX.Element {
  const dark = lv.sar.filter((x) => x.darkCandidate).length;
  const hs = hzSanc(lv).length;
  const { n, pct } = keepAtLeast(lv.sar, th);
  return (
    <Drawer
      title={`proposal-changes-${name.slice(11)}`}
      onClose={onClose}
      closeLabel="Close the proposal"
      wide
      head={
        <button
          type="button"
          className="at-btn pri"
          disabled
          title="A scenario run changes no ontology object, so there is nothing to propose on this box"
        >
          Propose changes
        </button>
      }
    >
      <div className="at-card" style={{ padding: 16, marginBottom: 16 }}>
        <h3>Simulation 1: {name}</h3>
        <div className="at-sub" style={{ margin: "4px 0 8px" }}>
          Model: SAR dark-vessel screen · Owner: —
        </div>
        <Metric
          icon="dot"
          value={String(lv.sar.length)}
          text="Detections screened (total)"
        />
        <Metric icon="th" value={String(dark)} text="Dark candidates" />
        <Metric
          icon="shield"
          value={String(hs)}
          text="Registry matches inside the area"
        />
      </div>
      <div className="at-card" style={{ padding: 16 }}>
        <h3>Simulation 2: {name}</h3>
        <div className="at-sub" style={{ margin: "4px 0 8px" }}>
          Model: SAR dark-vessel screen · Model: SAR hull-length threshold ·
          Owner: —
        </div>
        <Metric
          icon="dot"
          value={String(n)}
          text={`Detections kept at ${th} m or more`}
        />
        <Metric icon="th" value={`${pct}%`} text="Of detections kept" />
        <Metric icon="th" value="—" text="Hulls reviewed (no review log)" />
        <Metric
          icon="shield"
          value="0"
          text="Objects changed in the ontology"
        />
      </div>
    </Drawer>
  );
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

  let content: ReactNode;
  if (sim) {
    const loading = lv.sarRes === null;
    const failed = lv.sarRes !== null && !lv.sarRes.ok;
    // the proposal drawer opens over the results it was proposed from
    const stage = sim.stage === "proposal" ? "results" : sim.stage;
    switch (stage) {
      case "table":
        content = loading ? (
          <Loading name={sim.name} />
        ) : failed ? (
          <div className="at-center">
            {unavailable("SAR dark-vessel screen", lv.sarRes)}
          </div>
        ) : (
          <A14 lv={lv} onMap={() => go("map")} />
        );
        break;
      case "map":
        content = (
          <A15
            lv={lv}
            hist={hist}
            onTable={() => go("table")}
            onAnalysis={() => go("analysis")}
          />
        );
        break;
      case "analysis":
        content = <A16 lv={lv} onClose={() => go("paused")} />;
        break;
      case "paused":
        content = <A17 turn={turn2} onEdit={() => go("scen")} />;
        break;
      case "scen":
        content = (
          <A18
            lv={lv}
            sel={THS.indexOf(sim.th)}
            onPick={(i) => {
              setSim({ ...sim, th: THS[i]!, stage: "results" });
              setSarNonce((n) => n + 1);
            }}
          />
        );
        break;
      default:
        content = (
          <A20
            lv={lv}
            th={sim.th}
            loading={loading}
            onBack={() => go("scen")}
          />
        );
    }
  } else if (!turn) {
    content = <ContextLine lv={lv} />;
  } else if (turn.route === "a3") {
    content = (
      <>
        <Prompt q={turn.q} />
        <div>
          <Who />
          <A3 lv={lv} onHandoff={() => setPanel("handoff")} />
        </div>
      </>
    );
  } else if (turn.route === "a6") {
    content = (
      <>
        <Prompt q={turn.q} />
        <div>
          <Who />
          <A6 lv={lv} onHandoff={() => setPanel("handoff")} />
        </div>
      </>
    );
  } else {
    content = (
      <>
        <ContextLine lv={lv} />
        <Prompt q={turn.q} />
        <Answer r={turn.r} />
      </>
    );
  }

  return (
    <div className="aip-term">
      <div className="at-tabs">
        <button
          type="button"
          className="at-tab"
          aria-current={sim ? undefined : "page"}
          onClick={() => (sim ? setSim(null) : onInvestigate?.())}
        >
          Investigations
        </button>
        <button
          type="button"
          className="at-tab"
          aria-label="Proposals: run a simulation"
          aria-current={sim ? "page" : undefined}
          onClick={startSim}
        >
          Proposals
        </button>
        {sim ? (
          <>
            <span className="at-sep" />
            <span className="at-sim" title={sim.name}>
              <Ico n="area-of-interest" size={16} />
              <span>
                Simulation mode: <b>{sim.name}</b>
              </span>
            </span>
            <button
              type="button"
              className="at-btn"
              onClick={() => go("proposal")}
            >
              <Ico n="git-branch" size={16} />
              Propose these changes
            </button>
            <button type="button" className="at-btn" onClick={startSim}>
              <Ico n="add" size={16} />
              Run a new simulation
            </button>
            <button
              type="button"
              className="at-btn"
              aria-label="Exit simulation mode"
              onClick={() => setSim(null)}
            >
              Exit
            </button>
          </>
        ) : null}
        <span className="at-fill" />
        <button
          type="button"
          className="at-btn flat"
          aria-label="Open the Foundry workspace"
          onClick={onFoundry}
        >
          <Ico n="cube" size={16} />
          Foundry
        </button>
        <button
          type="button"
          className="at-btn flat"
          aria-label="AI hub: watch officer, analyst agent, local models"
          onClick={onHub}
        >
          <Ico n="panel-stats" size={16} />
          AI hub
        </button>
      </div>
      <div className="at-body">
        <div className="at-scroll">
          <div className="at-col">{content}</div>
        </div>
        {sim?.stage === "proposal" ? (
          <A21
            lv={lv}
            name={sim.name}
            th={sim.th}
            onClose={() => go("results")}
          />
        ) : null}
        {!sim && panel === "handoff" ? (
          <HandoffPanel
            lv={lv}
            onGraph={() => setPanel("graph")}
            onClose={() => setPanel(null)}
          />
        ) : null}
        {!sim && panel === "graph" ? (
          <GraphPanel
            q={turn?.q ?? ""}
            onTrace={() => setPanel("handoff")}
            onClose={() => setPanel(null)}
          />
        ) : null}
      </div>
      <Composer onSend={send} />
    </div>
  );
}
