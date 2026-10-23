import { useEffect, useState, type CSSProperties } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import { apiFetch } from "../../../transport/http.js";
import { baselineOf, dailyContacts } from "../object/archive.js";
import { bboxAround, type ArchiveTrack } from "../object/activity.js";

// ACTIVITY card (features-a copy G11, frame t73): daily ships detected around
// the situation against the archive's own average, with the red inline
// callout when the latest day exceeds it. Source: GET /api/history/tracks over
// the last DAYS days, distinct vessels per UTC day within the situation
// radius. Geometry: the copy's, relative to its card at frame (182, 762).

const DAYS = 8;
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

// Plot frame inside the card: x 90..515, y 83 (top) .. 233 (zero).
const X0 = 90;
const X1 = 515;
const Y0 = 233;
const H = 150;

export function ActivityCard({
  lat,
  lon,
  km,
}: {
  lat: number;
  lon: number;
  km: number;
}): JSX.Element {
  const [rows, setRows] = useState<
    { day: string; n: number | null }[] | string | null
  >(null);
  useEffect(() => {
    setRows(null);
    const ac = new AbortController();
    const [w, s, e, n] = bboxAround(lat, lon);
    const from = Math.floor(Date.now() / 1000 - DAYS * 86400);
    apiFetch(
      `/api/history/tracks?kind=vessel&min_lon=${w}&min_lat=${s}&max_lon=${e}&max_lat=${n}&from_ts=${from}&limit_ids=5000`,
      { signal: ac.signal },
    )
      .then(async (r) => {
        if (!r.ok) return setRows(`Archive unavailable (HTTP ${r.status})`);
        const j = (await r.json()) as { tracks?: ArchiveTrack[] };
        setRows(dailyContacts(j.tracks ?? [], lat, lon, km, Date.now(), DAYS));
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [lat, lon, km]);

  const data = Array.isArray(rows) ? rows : [];
  const vals = data.map((d) => d.n);
  const held = vals.filter((v) => v !== null).length;
  const base = baselineOf(vals);
  const last = vals[vals.length - 1] ?? null;
  const top = Math.max(4, ...vals.map((v) => v ?? 0), base ?? 0);
  const M = 4 * Math.ceil(top / 4);
  const X = (i: number): number => X0 + ((X1 - X0) * i) / Math.max(1, DAYS - 1);
  const Y = (v: number): number => Y0 - (v / M) * H;
  const pts = data
    .map((d, i) => (d.n === null ? null : ([X(i), Y(d.n)] as [number, number])))
    .filter((p): p is [number, number] => p !== null);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const exceeds = base !== null && last !== null && last > base;
  const tail = exceeds && pts.length >= 2 ? pts.slice(-2) : [];
  const month = data.length
    ? new Date(`${data[data.length - 1]!.day}T00:00:00Z`).toLocaleString("en", {
        month: "long",
        timeZone: "UTC",
      })
    : "";

  return (
    <div
      className="sl-actcard"
      style={{ position: "relative", width: 807, height: 296 }}
    >
      <div
        style={box(0, 0, 807, 296, {
          border: "1px solid #2c363c",
          background: "#182026",
        })}
      />
      <div
        style={box(1, 1, 805, 41, {
          background: "#1c252b",
          borderBottom: "1px solid #2c363c",
        })}
      />
      <BpIcon
        name="timeline-area-chart"
        size={18}
        style={{ position: "absolute", left: 9, top: 11, color: "#e5e8eb" }}
      />
      <div
        className="t"
        style={box(37, 10, undefined, undefined, {
          fontSize: 17,
          fontWeight: 600,
          letterSpacing: ".03em",
        })}
      >
        ACTIVITY
      </div>
      <svg
        width="807"
        height="296"
        style={{ position: "absolute", left: 0, top: 0 }}
        aria-label="Ships detected per day"
      >
        <defs>
          <linearGradient id="g11a" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#35403f" />
            <stop offset="1" stopColor="#1b2326" />
          </linearGradient>
          <linearGradient id="g11r" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8a4850" stopOpacity=".95" />
            <stop offset="1" stopColor="#5a3238" stopOpacity=".7" />
          </linearGradient>
        </defs>
        {pts.length >= 2 && (
          <path
            d={`M${pts[0]![0]},${Y0} L${line.replace(/ /g, " L")} L${pts[pts.length - 1]![0]},${Y0} Z`}
            fill="url(#g11a)"
          />
        )}
        {tail.length === 2 && base !== null && (
          <path
            d={`M${tail[0]![0]},${Y(base)} L${tail[0]![0]},${Math.min(Y(base), tail[0]![1])} L${tail[1]![0]},${tail[1]![1]} L${tail[1]![0]},${Y(base)} Z`}
            fill="url(#g11r)"
          />
        )}
        <path
          d={`M${X0} 83 V${Y0} H${X1}`}
          fill="none"
          stroke="#5b666d"
          strokeWidth="1.5"
        />
        {base !== null && (
          <line
            x1={X0}
            y1={Y(base)}
            x2={X1}
            y2={Y(base)}
            stroke="#669cbe"
            strokeWidth="2"
          />
        )}
        {pts.length >= 1 && (
          <polyline
            points={line}
            fill="none"
            stroke="#9aa6ac"
            strokeWidth="1.4"
          />
        )}
        {tail.length === 2 && (
          <polyline
            points={tail.map(([x, y]) => `${x},${y}`).join(" ")}
            fill="none"
            stroke="#f0838b"
            strokeWidth="1.8"
          />
        )}
      </svg>
      {[M, (3 * M) / 4, M / 2, M / 4].map((v) => (
        <div
          key={v}
          className="t"
          style={box(48, Y(v) - 10, undefined, undefined, {
            fontSize: 15.5,
            color: "#c7d0d5",
          })}
        >
          {v}
        </div>
      ))}
      <div
        style={box(15, 98, 24, 125, {
          writingMode: "vertical-rl",
          transform: "rotate(180deg)",
          fontSize: 15,
          color: "#c7d0d5",
          whiteSpace: "nowrap",
          textAlign: "center",
          lineHeight: "24px",
        })}
      >
        # Ships detected
      </div>
      {data.map((d, i) =>
        i % 2 === 1 ? (
          <div
            key={d.day}
            className="t"
            style={box(X(i) - 10, 243, 20, undefined, {
              fontSize: 15.5,
              color: "#c7d0d5",
              textAlign: "center",
            })}
          >
            {Number(d.day.slice(8))}
          </div>
        ) : null,
      )}
      <div
        className="t"
        style={box(X0, 265, X1 - X0, undefined, {
          fontSize: 15.5,
          color: "#c7d0d5",
          textAlign: "center",
        })}
      >
        {month}
      </div>
      {held >= 2 && base !== null && (
        <div
          style={box(531, 56, 236, 68, {
            background: exceeds ? "#482428" : "#26323a",
            borderRadius: 2,
          })}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            style={{ position: "absolute", left: 12, top: 10 }}
          >
            <circle
              cx="12"
              cy="12"
              r="10.5"
              fill="none"
              stroke={exceeds ? "#f0838b" : "#9fabb2"}
              strokeWidth="2"
            />
            <rect
              x="10.8"
              y="6"
              width="2.4"
              height="8"
              fill={exceeds ? "#f0838b" : "#9fabb2"}
            />
            <circle
              cx="12"
              cy="17"
              r="1.4"
              fill={exceeds ? "#f0838b" : "#9fabb2"}
            />
          </svg>
          <div
            className="t"
            style={box(48, 12, undefined, undefined, {
              fontSize: 16,
              color: "#f4e6e7",
            })}
          >
            {exceeds ? "Recent activity exceeds" : "Recent activity is within"}
          </div>
          <div
            className="t"
            style={box(48, 33, undefined, undefined, {
              fontSize: 16,
              color: "#f4e6e7",
            })}
          >
            the historic baseline
          </div>
        </div>
      )}
      <div
        style={box(541, 192, 12, 12, {
          borderRadius: "50%",
          background: "#8f99a8",
        })}
      />
      <div
        className="t"
        style={box(559, 188, undefined, undefined, {
          fontSize: 16,
          color: "#d5dce0",
        })}
      >
        Ships detected
      </div>
      <div
        style={box(541, 222, 12, 12, {
          borderRadius: "50%",
          background: "#2d8cf0",
        })}
      />
      <div
        className="t"
        style={box(559, 218, undefined, undefined, {
          fontSize: 16,
          color: "#d5dce0",
        })}
      >
        Baseline avg
      </div>
      {held < 2 && (
        <div className="sl-sitempty" style={box(110, 120, 380)}>
          {typeof rows === "string"
            ? rows
            : rows === null
              ? "loading…"
              : `The position archive holds ${held === 0 ? "no vessel fixes" : "one day of vessel fixes"} here in the last ${DAYS} days; a baseline needs two.`}
        </div>
      )}
    </div>
  );
}
