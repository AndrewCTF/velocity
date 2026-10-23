import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import { apiFetch } from "../../../transport/http.js";
import type { VesselEnrichment } from "../../../transport/entity.js";
import { shipTypeLabel } from "../../../entity-panel/EntityPanel.js";
import { useImageryView } from "../imagery/ImageryWorkspace.js";
import { useProjectFx } from "../mapfx/store.js";
import { baselineOf, underwayDaysByMonth } from "./archive.js";
import type { View } from "./SlateObject.js";

// The vessel object panel (features-a copy G22, frame t138): thumbnail
// header, Affiliation / Type, "Project vessel position", DETAILS (photo, Type,
// Length, Speed, nearest port, registries), ACTIVITY (average days underway
// per month from the position archive). The panel's absolute rows are the
// copy's, relative to its box at frame (1350, 104). OBSERVATIONS and the full
// property panels follow in flow (`rest`, shared with the place panel).

const box = (
  left: number,
  top: number,
  width?: number,
  height?: number,
  extra: CSSProperties = {},
): CSSProperties => ({
  position: "absolute",
  left,
  top,
  width,
  height,
  ...extra,
});

const MONTHS = 7;

export function VesselPanel({
  id,
  v,
  enr,
  props,
  onClose,
  onMore,
  rest,
}: {
  id: string;
  v: View;
  enr: VesselEnrichment | null;
  props: Record<string, unknown>;
  onClose: () => void;
  onMore: () => void;
  rest: ReactNode;
}): JSX.Element {
  const mmsi = id.slice(id.indexOf(":") + 1);
  const code = Number(props["shipType"] ?? NaN);
  const type =
    shipTypeLabel(Number.isFinite(code) ? code : null) ??
    enr?.vessel_type ??
    (typeof props["shipType"] === "string" ? props["shipType"] : null);
  const sog = typeof props["sog"] === "number" ? props["sog"] : null;
  const cog =
    typeof props["cog"] === "number"
      ? props["cog"]
      : typeof props["heading"] === "number"
        ? props["heading"]
        : null;
  const flag = enr?.flag_country ?? enr?.flag ?? null;
  const proj = useProjectFx((s) => s.p);
  const projecting = proj?.id === id;

  // ACTIVITY: the hull's archived fixes for the last seven months.
  const [months, setMonths] = useState<
    { label: string; days: number | null }[] | string | null
  >(null);
  useEffect(() => {
    setMonths(null);
    const ac = new AbortController();
    const from = Math.floor(Date.now() / 1000 - 215 * 86400);
    apiFetch(
      `/api/history/track?id=${encodeURIComponent(id)}&from_ts=${from}&limit=20000&series=true`,
      { signal: ac.signal },
    )
      .then(async (r) => {
        if (!r.ok) return setMonths(`Archive unavailable (HTTP ${r.status})`);
        const j = (await r.json()) as {
          series?: { t: number; sog?: number | null }[];
        };
        setMonths(underwayDaysByMonth(j.series ?? [], Date.now(), MONTHS));
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [id]);
  const rows = Array.isArray(months) ? months : [];
  const base = baselineOf([...rows.map((m) => m.days), null]);
  const held = rows.filter((m) => m.days !== null).length;
  const pxPerDay = 84 / 20; // the copy's axis: 20 days over 84 px

  const kvRight: [string, ReactNode][] = [
    ["Type", type ?? "—"],
    ["Length", enr?.length_m ? `${Math.round(enr.length_m)} m` : "—"],
    ["Speed", sog !== null ? `${sog.toFixed(1)} knots` : "—"],
    ["Near port", enr?.nearest_port ?? "—"],
  ];

  return (
    <div className="sl-obj sl-vp">
      <div style={{ position: "relative", height: 714, flex: "none" }}>
        <button
          type="button"
          style={box(17, 20, 58, 58, {
            border: "1px solid #4a5a64",
            padding: 0,
            background: v.photo
              ? `url(${v.photo.url}) center/cover #10181c`
              : "#10181c",
            cursor: "pointer",
          })}
          aria-label="Open the imagery workspace for this vessel"
          title="Open the imagery workspace for this vessel"
          onClick={() => useImageryView.getState().set(id)}
        />
        <div
          className="t"
          style={box(88, 20, 330, undefined, {
            fontSize: 19,
            fontWeight: 600,
            color: "#f6f7f9",
            overflow: "hidden",
            textOverflow: "ellipsis",
          })}
        >
          {v.title}
        </div>
        <div
          className="t"
          style={box(88, 42, undefined, undefined, {
            fontSize: 14.5,
            color: "#9fabb2",
          })}
        >
          Vessel
        </div>
        <button
          type="button"
          className="sl-vp-x"
          style={box(433, 16, 16, 16)}
          aria-label="Close the object panel"
          onClick={onClose}
        >
          <BpIcon name="cross" size={16} />
        </button>
        <div
          className="t"
          style={box(16, 89, undefined, undefined, {
            fontSize: 15,
            color: "#9fabb2",
          })}
        >
          Affiliation
        </div>
        <div
          className="t"
          style={box(129, 89, 320, undefined, {
            fontSize: 15.5,
            color: "#f1f4f6",
          })}
        >
          {flag ? `${flag} (flag state)` : "—"}
        </div>
        <div
          className="t"
          style={box(16, 115, undefined, undefined, {
            fontSize: 15,
            color: "#9fabb2",
          })}
        >
          Type
        </div>
        <div
          className="t"
          style={box(129, 115, undefined, undefined, {
            fontSize: 15.5,
            color: "#f1f4f6",
          })}
        >
          {type ?? "—"}
        </div>
        <button
          type="button"
          className="sl-vp-btn"
          style={box(16, 152, 431, 35)}
          aria-pressed={projecting}
          disabled={!v.pos}
          title={
            !v.pos
              ? "No position to project from"
              : "Reachable range rings and the course fan from the last real fix and reported speed"
          }
          onClick={() => {
            if (projecting) {
              useProjectFx.getState().set(null);
              return;
            }
            if (!v.pos) return;
            useProjectFx.getState().set({
              id,
              name: v.title,
              fix: v.pos,
              speedKn: sog ?? 0,
              cog,
            });
            useProjectFx.getState().setRunning(true);
          }}
        >
          <BpIcon name="geofence" size={20} />
          {projecting ? "Clear projection" : "Project vessel position"}
        </button>

        <div className="sl-vp-band" style={box(2, 205, 461, 29)}>
          <BpIcon name="chevron-down" size={14} />
          DETAILS
        </div>
        <div
          style={box(16, 253, 205, 124, {
            border: "1px solid #3a454b",
            background: v.photo
              ? `url(${v.photo.url}) center/cover #10181c`
              : "#10181c",
          })}
          role="img"
          aria-label={
            v.photo ? `${v.title}, ${v.photo.credit ?? "photo"}` : v.photoWhy
          }
        />
        {kvRight.map(([k, val], i) => (
          <div key={k}>
            <div
              className="t"
              style={box(239, 251 + 29 * i, undefined, undefined, {
                fontSize: 13.5,
                color: "#9fabb2",
              })}
            >
              {k}
            </div>
            <div
              className="t"
              style={box(321, 251 + 29 * i, 135, undefined, {
                fontSize: 13.5,
                color: "#f1f4f6",
                overflow: "hidden",
                textOverflow: "ellipsis",
              })}
            >
              {val}
            </div>
          </div>
        ))}
        <div
          className="t"
          style={box(16, 385, undefined, undefined, {
            fontSize: 13.5,
            color: "#9fabb2",
          })}
        >
          Registries
        </div>
        {(
          [
            [
              `VesselFinder record (MMSI ${mmsi})`,
              `https://www.vesselfinder.com/vessels/details/${encodeURIComponent(mmsi)}`,
            ],
            [
              `MarineTraffic record (MMSI ${mmsi})`,
              `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${encodeURIComponent(mmsi)}`,
            ],
          ] as const
        ).map(([label, href], i) => (
          <a
            key={href}
            className="sl-vp-reg"
            style={box(18, 405 + 25 * i)}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="cg">
              <BpIcon name="cog" size={12} />
            </span>
            {label}
          </a>
        ))}
        <button
          type="button"
          className="t sl-vp-link"
          style={box(16, 457)}
          onClick={onMore}
        >
          Show more...
        </button>

        <div className="sl-vp-band" style={box(2, 497, 461, 29)}>
          <BpIcon name="chevron-down" size={14} />
          ACTIVITY
        </div>
        <div
          className="t"
          style={box(15, 539, undefined, undefined, {
            fontSize: 15.5,
            color: "#e5e8eb",
          })}
        >
          Average days underway per month
        </div>
        <div
          style={box(16, 570, 431, 140, {
            border: "1px solid #3a454b",
            background: "#1a2227",
          })}
        >
          <svg
            width="431"
            height="140"
            style={{ position: "absolute", left: 0, top: 0 }}
            aria-label="Days underway per month"
          >
            <path
              d="M73 19 V103 H409"
              fill="none"
              stroke="#6a757b"
              strokeWidth="1.3"
            />
            {rows.map((m, i) =>
              m.days !== null ? (
                <rect
                  key={m.label}
                  x={84 + i * 46.3}
                  y={103 - m.days * pxPerDay}
                  width="20"
                  height={m.days * pxPerDay}
                  fill="#323d42"
                  stroke="#566268"
                  strokeWidth="1"
                >
                  <title>{`${m.label}: ${m.days} days with a fix at 1 kn or more`}</title>
                </rect>
              ) : null,
            )}
            {base !== null && held > 1 && (
              <line
                x1="73"
                y1={103 - base * pxPerDay}
                x2="391"
                y2={103 - base * pxPerDay}
                stroke="#4a8fd8"
                strokeWidth="2"
              />
            )}
          </svg>
          {[20, 15, 10, 5].map((n, i) => (
            <div
              key={n}
              className="t"
              style={box(51, 17 + 22 * i, undefined, undefined, {
                fontSize: 13,
                color: "#c7d0d5",
              })}
            >
              {n}
            </div>
          ))}
          <div
            style={box(21, 41, 24, 60, {
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
              fontSize: 13,
              color: "#c7d0d5",
              whiteSpace: "nowrap",
            })}
          >
            # days
          </div>
          {rows.map((m, i) => (
            <div
              key={m.label}
              className="t"
              style={box(74 + i * 46.3, 108, 40, undefined, {
                fontSize: 13,
                color: "#c7d0d5",
                textAlign: "center",
              })}
            >
              {m.label}
            </div>
          ))}
          {(typeof months === "string" || held === 0) && (
            <div className="sl-vp-empty" style={box(90, 40, 320)}>
              {typeof months === "string"
                ? months
                : months === null
                  ? "loading…"
                  : "No archived fixes for this hull in seven months."}
            </div>
          )}
        </div>
      </div>
      {rest}
    </div>
  );
}
