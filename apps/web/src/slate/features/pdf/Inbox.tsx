// Inbox (gotham-009-041, D21 D22 D23 D24): sec_inbox() of _build_gotham_a.py
// in the 1163 x 615 figure's pixels. The object feed is the selected track; a
// "change" is a new AIS fix (archive plus this session's box pulls).
import { useState } from "react";
import { A, Hit, N_MEDIA, I, T, frag, sceneBg, toPx, type N } from "./kit.js";
import { TRK, hhmm, mdy, series, unavailable } from "./data.js";
import type { Ctx } from "./model.js";

const MONTH = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const p2 = (n: number): string => String(n).padStart(2, "0");
/** "October 22, 2026 9:51 UTC" (the builder's %B %d, %Y %H:%M with " 0" dropped). */
const longUtc = (t: number): string => {
  const d = new Date(t * 1000);
  return `${MONTH[d.getUTCMonth()]} ${p2(d.getUTCDate())}, ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`.replace(
    / 0/g,
    " ",
  );
};
const mdyhm = (t: number): string => {
  const d = new Date(t * 1000);
  return `${mdy(t)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
};

export function Inbox({ c }: { c: Ctx }): JSX.Element {
  const [q, setQ] = useState("");
  const W = 1163,
    H = 615;
  const BG2 = "#242832";
  const SELR = c.sel;
  const CORR = (c.watch?.changes.new ?? []).slice(0, 7).map((n) => {
    const [x, y] = n.key.split(":");
    return `${x}E ${y}N`;
  });
  const near = c.res.find((r) => r !== SELR) ?? null;
  const nch = (m: number): number =>
    Math.max(0, (m === SELR?.mmsi ? c.fixes : series(m)).length - 1);
  const o: N[] = [A(0, 0, W, H, `background:${BG2}`)];
  o.push(A(0, 0, 191, H, `background:${BG2};border-right:1px solid #333a46`));
  o.push(
    A(
      12,
      6,
      139,
      23,
      "background:#1e222a;border:1px solid #3d4552;border-radius:2px",
    ),
    I("search", 24, 17, 12, "#dfe5e7"),
    T(36, 17, "Search for feeds...", "#aab4bc", 10),
    I("cog", 171, 17, 13, "#c3ccd2"),
  );
  o.push(
    Hit(12, 6, 139, 23, "Search for feeds: the Browser", () => c.go("browser")),
    Hit(
      163,
      9,
      16,
      16,
      "Feed settings",
      undefined,
      "Feeds are derived from the selection, not saved subscriptions",
    ),
  );
  o.push(
    A(0, 37, 190, 29, "background:#3a4252"),
    T(8, 51, "All messages", "#8abcfe", 10),
  );
  for (const [yc, t_] of [
    [79, "Requests"],
    [107, "High priority topics"],
    [135, "Shared with me"],
  ] as const) {
    o.push(T(20, yc, t_, "#e5e8eb", 10));
    o.push(
      Hit(
        4,
        yc - 10,
        180,
        20,
        t_,
        undefined,
        "No request, topic or sharing store exists",
      ),
    );
  }
  o.push(
    I("chevron-down", 10, 167, 9, "#e5e8eb"),
    T(20, 167, "Object feeds", "#e5e8eb", 10),
    A(161, 159, 17, 17, "background:#4a5260;border-radius:9px"),
    T(169.5, 167, SELR ? "1" : "0", "#e5e8eb", 8.5, 20, "", false, true),
  );
  if (SELR) {
    const [sx, sy] = toPx(SELR.v.lon, SELR.v.lat);
    o.push(
      A(
        19,
        183,
        16,
        16,
        `${sceneBg(sx, sy, 16, 16, 2.0)};border:1px solid #6b7680`,
      ),
      T(41, 190, TRK(SELR.mmsi), "#aab4bc", 9.5),
      T(171, 190, "1", "#aab4bc", 9.5),
    );
  }
  o.push(
    I("chevron-down", 10, 219, 9, "#e5e8eb"),
    T(20, 219, "Search feeds", "#e5e8eb", 10),
    I("chevron-down", 10, 249, 9, "#e5e8eb"),
    T(20, 249, "Artifact feeds", "#e5e8eb", 10),
  );
  CORR.forEach((nm, k) => {
    const yc = 278 + k * 29.7;
    o.push(
      I("chevron-down", 10, yc, 9, "#e5e8eb"),
      T(20, yc, `Correlations - ${nm}`, "#e5e8eb", 10),
    );
  });
  if (!c.watch) o.push(T(20, 278, "Correlations loading", "#aab4bc", 10));
  // message list
  o.push(A(191, 0, 312, H, `background:${BG2};border-right:1px solid #333a46`));
  o.push(
    T(207, 17, "All messages", "#f1f4f5", 11),
    I("more", 485, 17, 13, "#e5e8eb"),
    A(191, 35, 312, 1, "background:#333a46"),
  );
  o.push(Hit(477, 9, 16, 16, "More", undefined, "No message actions exist"));
  o.push(
    I("filter", 212, 53, 11, "#e5e8eb"),
    T(222, 53, "Filters (0)", "#e5e8eb", 10),
    I("list-columns", 428, 53, 12, "#e5e8eb"),
    T(444, 53, "No groups", "#e5e8eb", 10),
  );
  o.push(
    Hit(206, 45, 70, 16, "Filters", undefined, "Two feeds, nothing to filter"),
    Hit(422, 45, 76, 16, "Groups", undefined, "Two feeds, nothing to group"),
  );
  const rows = [SELR, near].filter((r): r is NonNullable<typeof r> => !!r);
  rows.forEach((r, k) => {
    const sel = r === SELR;
    const y0_ = 70 + 64 * k;
    o.push(
      A(
        192,
        y0_,
        311,
        64,
        `background:${sel ? "#1a427c" : BG2};border-bottom:1px solid #333a46`,
      ),
    );
    const [px, py] = toPx(r.v.lon, r.v.lat);
    o.push(
      A(
        218,
        y0_ + 6,
        14,
        17,
        `${sceneBg(px, py, 14, 17, 2.0)};border:1px solid #8f99a8`,
      ),
    );
    o.push(
      T(240, y0_ + 13, TRK(r.mmsi), "#f1f4f5", 10, 400, "font-weight:700"),
      T(
        218,
        y0_ + 31,
        `${TRK(r.mmsi)} has ${nch(r.mmsi)} changes`,
        "#f1f4f5",
        10,
      ),
      T(218, y0_ + 48, mdy(r.v.t), "#aab4bc", 8.5),
    );
    if (!sel)
      o.push(A(201, y0_ + 29, 5, 5, "background:#4c90f0;border-radius:3px"));
    o.push(Hit(192, y0_, 311, 64, `${TRK(r.mmsi)} feed`, () => c.pick(r.mmsi)));
  });
  // right: toolbar + alert
  o.push(A(503, 0, 660, H, `background:${BG2}`));
  for (const [xc, ic] of [
    [522, "archive"],
    [549, "star-empty"],
    [576, "modal"],
  ] as const)
    o.push(I(ic, xc, 17, 13, "#e5e8eb"));
  o.push(
    Hit(
      514,
      9,
      16,
      16,
      "Archive",
      undefined,
      "Feed messages are derived, so there is nothing to archive",
    ),
    Hit(541, 9, 16, 16, "Star", undefined, "No favourites store exists"),
    Hit(568, 9, 16, 16, "Open in a window", undefined, "One window"),
  );
  o.push(
    A(1094, 5, 60, 23, "background:#2e72d2;border-radius:2px"),
    I("eye-open", 1109, 17, 11, "#bcd2f0"),
    T(1122, 17, "Open", "#fff", 10, 400, "font-weight:500"),
  );
  o.push(Hit(1094, 5, 60, 23, "Open the object view", () => c.go("cov")));
  o.push(A(503, 36, 660, 1, "background:#333a46"));
  if (!SELR) {
    o.push(
      T(
        514,
        58,
        c.boxRes && !c.boxRes.ok
          ? unavailable("AIS box", c.boxRes)
          : "No object feed",
        "#f1f4f5",
        12.5,
      ),
    );
    return frag(o);
  }
  const SELT = TRK(SELR.mmsi);
  const SELP = c.fixes.length
    ? c.fixes
    : [[SELR.v.t, SELR.v.lon, SELR.v.lat, SELR.sog] as const];
  const tl = SELP[SELP.length - 1]![0];
  const [sx, sy] = toPx(SELR.v.lon, SELR.v.lat);
  o.push(
    T(514, 58, `${SELT} has ${nch(SELR.mmsi)} changes`, "#f1f4f5", 12.5),
    T(514, 80, longUtc(tl), "#8f99a8", 9),
    I("shield", 1148, 56, 13, "#f1f4f5"),
  );
  o.push(
    T(514, 105, "From:", "#aab4bc", 10),
    A(
      564,
      98,
      14,
      18,
      `${sceneBg(sx, sy, 14, 18, 2.0)};border:1px solid #8f99a8`,
    ),
    T(585, 106, SELT, "#f1f4f5", 10),
    I("caret-down", 655, 106, 9, "#e5e8eb"),
  );
  o.push(
    T(514, 136, "Data:", "#aab4bc", 10),
    T(554, 136, "No linked items", "#f1f4f5", 10),
    T(522, 163, "Show less", "#6aa6e8", 10),
  );
  o.push(A(503, 178, 660, 1, "background:#333a46"));
  o.push(
    A(
      509,
      186,
      30,
      32,
      `${sceneBg(sx, sy, 30, 32, 2.0)};border:1px solid #8f99a8`,
    ),
  );
  o.push(
    T(548, 195, SELT, "#f1f4f5", 10.5, 400, "font-weight:700"),
    T(548, 211, "Vessel", "#e5e8eb", 8.5),
    T(1100, 202, "Actions", "#f1f4f5", 10),
    I("caret-down", 1145, 202, 9, "#e5e8eb"),
  );
  o.push(Hit(1095, 194, 58, 16, "Actions: the object view", () => c.go("cov")));
  const tabs: [string, number, (() => void) | undefined][] = [
    ["Overview", 511, () => c.go("cov")],
    ["Properties", 573, () => c.go("cov")],
    ["Links", 640, () => c.go("cov")],
    ["Media", 683, () => c.go("cov")],
    ["Evidence", 752, () => c.go("chat")],
    ["Notes", 846, undefined],
    ["Map", 892, () => c.go("cov")],
    ["History", 930, undefined],
    ["Sources", 983, undefined],
    ["AI brief", 1039, undefined],
    ["Replay", 1085, undefined],
    ["More", 1129, undefined],
  ];
  for (const [t_, x, fn] of tabs) {
    o.push(T(x, 231, t_, t_ === "History" ? "#8abcfe" : "#e5e8eb", 9.5));
    o.push(
      Hit(
        x - 3,
        223,
        t_.length * 5.6 + 8,
        16,
        t_,
        fn,
        t_ === "History"
          ? "This is the open tab"
          : `${t_} is not part of this feed`,
      ),
    );
  }
  o.push(
    A(713, 224, 19, 14, "background:#323a46;border-radius:2px"),
    T(722.5, 231, String(N_MEDIA), "#c3ccd2", 8, 20, "", false, true),
    I("caret-down", 1163 - 25, 231, 9, "#e5e8eb"),
  );
  o.push(
    A(917, 241, 47, 2, "background:#8abcfe"),
    A(503, 243, 660, 1, "background:#333a46"),
  );
  o.push(
    A(
      511,
      251,
      233,
      25,
      "background:#1a1e26;border:1px solid #4a525a;border-radius:2px",
    ),
    I("search", 523, 263, 12, "#e5e8eb"),
  );
  o.push(
    <input
      className="sl-field"
      aria-label="Filter the history"
      placeholder="Filter..."
      value={q}
      onChange={(e) => setQ(e.target.value)}
      style={{
        left: 536,
        top: 256,
        width: 200,
        height: 14,
        fontSize: 10,
        color: "#f1f4f5",
      }}
    />,
  );
  o.push(T(511, 304, mdy(tl), "#c3ccd2", 9.5));
  const nsrc = SELR.v.sources?.length ?? 1;
  const all = SELP.slice(-7).reverse();
  const fx = q
    ? all.filter((f) =>
        `${f[2].toFixed(5)} ${f[1].toFixed(5)} ${hhmm(f[0], true)}`.includes(q),
      )
    : all;
  o.push(
    I("add", 750, 304, 12, "#3fb27f"),
    A(744, 298, 12, 12, "border:1px solid #3fb27f;border-radius:6px"),
    T(
      762,
      304,
      `Added ${fx.length} position fix${fx.length === 1 ? "" : "es"}`,
      "#f1f4f5",
      10,
      400,
      "font-weight:700",
    ),
  );
  let yy = 320;
  fx.forEach((f, k) => {
    const two = k !== 4;
    o.push(
      T(
        762,
        yy,
        `Added AIS position fix ${f[2].toFixed(5)} N, ${f[1].toFixed(5)} E at ${hhmm(f[0], true)} with data source`,
        "#c3ccd2",
        9.2,
      ),
    );
    if (two) {
      yy += 16;
      o.push(
        T(
          762,
          yy,
          `AIS recorder (${nsrc} source${nsrc === 1 ? "" : "s"} merged)`,
          "#c3ccd2",
          9.2,
        ),
      );
    }
    yy += k !== 3 ? 16 : 22;
  });
  const y2 = 554;
  o.push(
    A(744, y2 - 6, 12, 12, "border:1px solid #3fb27f;border-radius:6px"),
    I("add", 750, y2, 12, "#3fb27f"),
    T(
      762,
      y2,
      "Added 1 sanctions lookup",
      "#f1f4f5",
      10,
      400,
      "font-weight:700",
    ),
  );
  o.push(
    c.sanc
      ? T(
          762,
          y2 + 17,
          `Looked up ${SELR.mmsi} against ${c.sanc.lists.join(", ")}: ${c.sanc.matched ? "match" : "no match"}`,
          "#c3ccd2",
          9.2,
        )
      : T(
          762,
          y2 + 17,
          unavailable("Sanctions lookup", c.sancRes),
          "#c3ccd2",
          9.2,
        ),
  );
  if (c.sanc)
    o.push(
      T(762, y2 + 32, `(Fetched ${mdyhm(c.sanc.fetched_at)})`, "#c3ccd2", 9.2),
    );
  o.push(
    T(
      762,
      y2 + 52,
      `Added ${SELP.length} fix${SELP.length === 1 ? "" : "es"} to ${SELT} from the AIS recorder`,
      "#c3ccd2",
      9.2,
    ),
  );
  o.push(A(1157, 285, 6, 10, "background:#c3ccd2;border-radius:3px"));
  return frag(o);
}
