import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import { apiFetch } from "../../../transport/http.js";
import { useDetected } from "../../../situations/detectedStore.js";
import { passesOverAoi, type Pass } from "../../../sim/tasking.js";
import { usePortName } from "../../SlateSituations.js";
import { catalogue } from "../imagery/ImageryWorkspace.js";
import { TaskHead, useTaskFlow } from "./TaskFlow.js";

// Task Asset, asset step (features-b copy): G34 "Ground feeders" with search
// and recommended assets, G29 "Satellite" with the pass analysis and
// available satellites. Geometry: the copy's, relative to the panel at frame
// (157, 108).
//
// Feeders are the AIS sources actually reporting hulls in the detection's
// box (GET /api/maritime/vessels, each vessel's `sources`): READY when the
// source has a fix in the last 15 minutes. Satellites are every SENTINEL-1 and
// CAPELLA element set in GET /api/space/gp with a pass above 20 deg over the
// detection in the next 12 h (SGP4, sim/tasking.passesOverAoi).

const box = (
  left: number,
  top: number,
  width?: number,
  height?: number,
  extra: CSSProperties = {},
): CSSProperties => ({ left, top, width, height, ...extra });

const HOURS = 12;
const READY_S = 900;

interface Feeder {
  name: string;
  hulls: number;
  freshS: number;
}

function inRange(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} minutes to be in range`;
  return `${h} hour${h === 1 ? "" : "s"} ${r} minutes to be in range`;
}
const hm = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
};

export function Assets(): JSX.Element | null {
  const det = useDetected((s) => s.det);
  const port = usePortName((s) => s.name);
  const tab = useTaskFlow((s) => s.tab);
  const set = useTaskFlow((s) => s.set);
  const [feeders, setFeeders] = useState<Feeder[] | string | null>(null);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [sats, setSats] = useState<Pass[] | string | null>(null);
  const [allSats, setAllSats] = useState(false);
  const [t0] = useState(() => Date.now());

  useEffect(() => {
    if (!det) return;
    const ac = new AbortController();
    const pad = (det.r_km + 2) / 100;
    apiFetch(
      `/api/maritime/vessels?bbox=${det.lon - pad},${det.lat - pad},${det.lon + pad},${det.lat + pad}&limit=5000`,
      { signal: ac.signal },
    )
      .then(async (r) => {
        if (!r.ok) return setFeeders(`Live AIS unavailable (HTTP ${r.status})`);
        const j = (await r.json()) as {
          vessels?: { sources?: string[]; source?: string; ageS?: number }[];
        };
        const m = new Map<string, Feeder>();
        for (const v of j.vessels ?? [])
          for (const src of v.sources ?? (v.source ? [v.source] : [])) {
            const f = m.get(src) ?? { name: src, hulls: 0, freshS: Infinity };
            f.hulls += 1;
            f.freshS = Math.min(f.freshS, v.ageS ?? Infinity);
            m.set(src, f);
          }
        setFeeders([...m.values()].sort((a, b) => b.hulls - a.hulls));
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [det]);

  useEffect(() => {
    if (!det || tab !== "satellite" || sats !== null) return;
    let live = true;
    void catalogue().then((items) => {
      if (!live) return;
      if (typeof items === "string") return setSats(items);
      const out: Pass[] = [];
      for (const it of items) {
        const name = (it.OBJECT_NAME ?? "").trim();
        if (
          !/^(SENTINEL-1|CAPELLA)/.test(name) ||
          !it.TLE_LINE1 ||
          !it.TLE_LINE2
        )
          continue;
        const p = passesOverAoi(
          it.TLE_LINE1,
          it.TLE_LINE2,
          { lat: det.lat, lon: det.lon },
          { startMs: t0, endMs: t0 + HOURS * 3600_000 },
          30,
          20,
          name,
        )[0];
        if (p) out.push(p);
      }
      setSats(out.sort((a, b) => a.startMs - b.startMs));
    });
    return () => {
      live = false;
    };
  }, [det, tab, sats, t0]);

  const shownFeeders = useMemo(
    () =>
      Array.isArray(feeders)
        ? feeders.filter(
            (f) => !q || f.name.toLowerCase().includes(q.toLowerCase()),
          )
        : [],
    [feeders, q],
  );
  if (!det) return null;
  const area = port ?? `${det.lat.toFixed(2)}, ${det.lon.toFixed(2)}`;
  const picked = Array.isArray(feeders)
    ? feeders.find((f) => f.name === pick)
    : undefined;

  return (
    <div
      className="sl-g36"
      role="dialog"
      aria-label="Task Asset"
      style={{ height: tab === "satellite" ? 690 : 670 }}
    >
      <TaskHead />
      {tab === "feeders" && (
        <>
          <div style={box(1, 197, 419, 1, { background: "#2a343a" })} />
          <BpIcon
            name="chevron-down"
            size={15}
            style={{
              position: "absolute",
              left: 18,
              top: 215.5,
              color: "#e5e8eb",
            }}
          />
          <div
            className="t"
            style={box(39, 213, undefined, undefined, {
              fontSize: 15.5,
              fontWeight: 700,
              letterSpacing: ".06em",
              color: "#e9eef0",
            })}
          >
            SEARCH ALL ASSETS
          </div>
          <div style={box(18, 254, 388, 30, { background: "#141c20" })} />
          <BpIcon
            name="search"
            size={17}
            style={{
              position: "absolute",
              left: 25.5,
              top: 260.5,
              color: "#9fabb2",
            }}
          />
          <input
            className="t sl-g34in"
            style={box(52, 259, 340, 20, { fontSize: 15.5 })}
            placeholder="Search all feeders"
            aria-label="Search all feeders"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div style={box(18, 302, 388, 30, { background: "#141c20" })} />
          <BpIcon
            name="locate"
            size={17}
            style={{
              position: "absolute",
              left: 25.5,
              top: 308.5,
              color: "#9fabb2",
            }}
          />
          <div
            className="t"
            style={box(52, 307, 340, undefined, {
              fontSize: 15.5,
              color: "#e5e8eb",
              overflow: "hidden",
              textOverflow: "ellipsis",
            })}
          >
            {area}
          </div>
          <div
            className="t"
            style={box(16, 364, undefined, undefined, {
              fontSize: 16,
              color: "#f1f4f6",
            })}
          >
            Recommended assets
          </div>
          <div
            className="sl-g34list"
            style={box(17, 392, 389, details ? 110 : 160)}
          >
            {feeders === null && (
              <p className="sl-g36-empty">
                Reading the AIS sources in the area…
              </p>
            )}
            {typeof feeders === "string" && (
              <p className="sl-g36-empty">{feeders}</p>
            )}
            {Array.isArray(feeders) && !shownFeeders.length && (
              <p className="sl-g36-empty">
                No AIS source reports hulls here{q ? ` matching "${q}"` : ""}.
              </p>
            )}
            {shownFeeders.map((f, i) => {
              const ready = f.freshS <= READY_S;
              return (
                <button
                  key={f.name}
                  type="button"
                  className={`sl-g34card${pick === f.name ? " on" : ""}`}
                  aria-pressed={pick === f.name}
                  onClick={() => setPick(f.name)}
                >
                  <BpIcon
                    name="antenna"
                    size={22}
                    style={{
                      position: "absolute",
                      left: 27,
                      top: 7,
                      color: "#6fb0e6",
                    }}
                  />
                  <span className="nm">{f.name}</span>
                  <span className={`st${ready ? "" : " off"}`}>
                    {ready ? "READY" : "STALE"}
                  </span>
                  <span className="loc">• {f.hulls} hulls in the area</span>
                  {i < 2 && ready && <span className="rec">Recommended</span>}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="sl-g34band"
            style={box(16, 565 - (details ? 50 : 0), 390, 22)}
            aria-expanded={details}
            onClick={() => setDetails((v) => !v)}
          >
            <BpIcon
              name={details ? "chevron-down" : "chevron-right"}
              size={15}
            />
            TASKING DETAILS
          </button>
          {details && (
            <div className="sl-g34det" style={box(39, 540, 360, 50)}>
              {picked
                ? `${picked.name}: ${picked.hulls} hulls in the area, newest fix ${Math.round(picked.freshS)} s old.`
                : "Pick an asset to see what it reports."}
            </div>
          )}
          <button
            type="button"
            className="sl-g36-btn pri sl-g34go"
            style={box(19, 602, 384, 36)}
            disabled={!pick}
            title={pick ? undefined : "Pick an asset first"}
            onClick={() => set("models")}
          >
            Choose models <BpIcon name="arrow-right" size={18} />
          </button>
        </>
      )}
      {tab === "aircraft" && (
        <p className="sl-g36-empty" style={box(16, 220, 388)}>
          No airborne collection assets: the console has no aircraft sensor feed
          to task.
        </p>
      )}
      {tab === "satellite" && (
        <>
          <div className="sl-g29prog" style={box(13, 208, 385, 94)}>
            <BpIcon
              name="predictive-analysis"
              size={25}
              style={{
                position: "absolute",
                left: 16.5,
                top: 34.5,
                color: "#5fd6cb",
              }}
            />
            <div className="sl-g29t" style={box(57, 16, 315, 44)}>
              {sats === null
                ? "Propagating SAR element sets for an available imaging window..."
                : typeof sats === "string"
                  ? sats
                  : `${sats.length} SAR satellite${sats.length === 1 ? "" : "s"} pass above 20° here in the next ${HOURS} h.`}
            </div>
            <div
              style={box(57, 68, 293, 8, {
                background: "#3b474d",
                borderRadius: 4,
              })}
            />
            <div
              className={sats === null ? "sl-g29bar run" : "sl-g29bar"}
              style={box(57, 68, sats === null ? 8 : 293, 8)}
            />
          </div>
          <BpIcon
            name="locate"
            size={22}
            style={{
              position: "absolute",
              left: 14,
              top: 318,
              color: "#d5dce0",
            }}
          />
          <div style={box(48, 314, 350, 29, { background: "#1c2428" })} />
          <div
            className="t"
            style={box(63, 319, 330, undefined, {
              fontSize: 16,
              color: "#f1f4f6",
              overflow: "hidden",
              textOverflow: "ellipsis",
            })}
          >
            {area}
          </div>
          <BpIcon
            name="calendar"
            size={22}
            style={{
              position: "absolute",
              left: 14,
              top: 365,
              color: "#d5dce0",
            }}
          />
          <div style={box(48, 361, 350, 29, { background: "#1c2428" })} />
          <div
            className="t"
            style={box(63, 366, undefined, undefined, {
              fontSize: 16,
              color: "#f1f4f6",
            })}
          >
            {hm(t0)}
          </div>
          <div
            className="t"
            style={box(235, 366, undefined, undefined, {
              fontSize: 16,
              color: "#f1f4f6",
            })}
          >
            {hm(t0 + HOURS * 3600_000)}
          </div>
          <div
            className="t"
            style={box(13, 408, undefined, undefined, {
              fontSize: 16,
              color: "#f1f4f6",
            })}
          >
            Available satellites
          </div>
          <div className="sl-g29list" style={box(14, 437, 384, 182)}>
            {Array.isArray(sats) && !sats.length && (
              <p className="sl-g36-empty">
                No SAR pass above 20° in the next {HOURS} h.
              </p>
            )}
            {(Array.isArray(sats)
              ? allSats
                ? sats
                : sats.slice(0, 2)
              : []
            ).map((p) => (
              <div key={p.satName} className="sl-g29row">
                <span className="ic">
                  <BpIcon name="satellite" size={24} />
                </span>
                <span className="nm">{p.satName}</span>
                <span className="eta">{inRange(p.startMs - t0)}</span>
                <button
                  type="button"
                  className={`av${pick === p.satName ? " on" : ""}`}
                  aria-pressed={pick === p.satName}
                  onClick={() => setPick(p.satName ?? null)}
                >
                  Available
                </button>
              </div>
            ))}
            {Array.isArray(sats) && sats.length > 2 && (
              <button
                type="button"
                className="sl-g29all"
                onClick={() => setAllSats((v) => !v)}
              >
                {allSats ? "Show fewer satellites" : "See all satellites"}
              </button>
            )}
          </div>
          <button
            type="button"
            className="sl-g36-btn pri sl-g34go"
            style={box(14, 640, 382, 36)}
            disabled={!pick}
            title={pick ? undefined : "Pick a satellite first"}
            onClick={() => set("models")}
          >
            Choose models <BpIcon name="arrow-right" size={18} />
          </button>
        </>
      )}
    </div>
  );
}
