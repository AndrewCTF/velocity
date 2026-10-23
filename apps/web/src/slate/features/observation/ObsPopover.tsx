import { useEffect, useState, type CSSProperties } from "react";
import { create } from "zustand";
import "./observation.css";
import { BpIcon } from "../../../shell/BpIcon.js";
import { useAppView } from "../../../state/appView.js";
import type { Detection } from "../../../situations/DetectedSituation.js";
import { usePortName, useSlateSituation } from "../../SlateSituations.js";
import { useSitView } from "../situation/SituationObject.js";

// "Satellite observation" popover (features-a copy G18, frame t91), opened by
// Review on an OBSERVATIONS card. The observation is the anchorage detector's
// live detection (GET /api/situations/detect); before/after are Sentinel-2
// chips over its centre (GET /api/imagery/chip, `date` = latest scene on or
// before), so the pair shows the same water at two dates. The copy's hatched
// detection boxes are not drawn: no per-scene detections exist for them.
// Geometry: the copy's, relative to the popover box at frame (580, 280).

export const useObsPopover = create<{
  det: Detection | null;
  open: (d: Detection) => void;
  close: () => void;
}>((set) => ({
  det: null,
  open: (det) => set({ det }),
  close: () => set({ det: null }),
}));

const box = (
  left: number,
  top: number,
  width?: number,
  height?: number,
  extra: CSSProperties = {},
): CSSProperties => ({ left, top, width, height, ...extra });

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const md = (ms: number): string => ymd(ms).slice(5).replace("-", "/");
const DAY = 86400_000;

function chip(d: Detection, dateMs: number): string {
  const q = new URLSearchParams({
    lat: d.lat.toFixed(3),
    lon: d.lon.toFixed(3),
    radius_km: Math.max(2, Math.min(8, d.r_km)).toFixed(1),
    date: ymd(dateMs),
    source: "sentinel",
  });
  return `/api/imagery/chip?${q.toString()}`;
}

export function ObsPopover({
  onPlan,
}: {
  onPlan: () => void;
}): JSX.Element | null {
  const det = useObsPopover((s) => s.det);
  const close = useObsPopover((s) => s.close);
  const port = usePortName((s) => s.name);
  const [back, setBack] = useState(12);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    setBack(12);
    setVote(null);
  }, [det]);
  useEffect(() => {
    if (!det) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [det, close]);
  if (!det) return null;
  const now = Date.now();
  const before = now - back * DAY;
  const after = now - 2 * DAY;
  const area = (
    port ?? `${det.lat.toFixed(2)}, ${det.lon.toFixed(2)}`
  ).toUpperCase();
  const t = new Date(now).toISOString();
  return (
    <div className="sl-obs-backdrop" onClick={close}>
      <div
        className="sl-g18"
        role="dialog"
        aria-label="Satellite observation"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={box(1, 1, 724, 30, {
            background: "#141b1e",
            borderBottom: "1px solid #222b2f",
          })}
        />
        <div
          className="t"
          style={box(15, 5, undefined, undefined, { fontSize: 13.5 })}
        >
          Satellite observation
        </div>
        <button
          type="button"
          className="sl-link"
          style={box(690, 7, 16, 16, { color: "#d5dce0" })}
          aria-label="Close"
          onClick={close}
        >
          <BpIcon name="cross" size={16} />
        </button>
        <div
          className="t"
          style={box(24, 48, 580, undefined, {
            fontSize: 12.5,
            letterSpacing: ".06em",
            color: "#b4bec4",
            overflow: "hidden",
            textOverflow: "ellipsis",
          })}
        >
          COLLECTION AREA: {area} {" • "} TIME: {md(now)} {t.slice(11, 16)}Z
        </div>
        <div className="sl-g18-head" style={box(24, 77, 580, 44)}>
          Anchorage detector finds {det.n} vessels stationary together within{" "}
          {det.r_km} km of this point
          {det.sanctioned ? `, ${det.sanctioned} on a sanctions list` : ""}.
        </div>
        <div
          style={box(630, 53, 66, 66, {
            borderRadius: "50%",
            border: "1px solid #9eaab4",
            background: `url(${chip(det, after)}) center/cover #5e6e7c`,
          })}
          role="img"
          aria-label="Latest chip, thumbnail"
        />
        <div
          style={box(20, 147, 688, 37, {
            background: "#151c1f",
            border: "1px solid #232d31",
          })}
        />
        <BpIcon
          name="timeline-line-chart"
          size={18}
          style={{ position: "absolute", left: 31, top: 157, color: "#e08ab0" }}
        />
        <div
          className="t"
          style={box(70, 156, undefined, undefined, {
            fontSize: 15,
            fontWeight: 600,
            color: "#f6f7f9",
          })}
        >
          Anchorage detector
        </div>
        <div
          className="t"
          style={box(219, 156, undefined, undefined, {
            fontSize: 13,
            color: "#aab4ba",
          })}
        >
          {"•  live AIS cluster"}
        </div>
        <button
          type="button"
          className="sl-link"
          style={box(576.5, 157.5, 17, 17, {
            color: vote === "down" ? "#f0838b" : "#cdd5da",
          })}
          aria-pressed={vote === "down"}
          aria-label="Not useful"
          title="Not useful"
          onClick={() => setVote((v) => (v === "down" ? null : "down"))}
        >
          <BpIcon name="thumbs-down" size={17} />
        </button>
        <button
          type="button"
          className="sl-link"
          style={box(608.5, 155.5, 17, 17, {
            color: vote === "up" ? "#3fd0b4" : "#e5e8eb",
          })}
          aria-pressed={vote === "up"}
          aria-label="Useful"
          title="Useful"
          onClick={() => setVote((v) => (v === "up" ? null : "up"))}
        >
          <BpIcon name="thumbs-up" size={17} />
        </button>
        <button
          type="button"
          className="t sl-link"
          style={box(644, 156, undefined, undefined, {
            fontSize: 15,
            color: "#5da7ef",
          })}
          onClick={() => {
            close();
            useSitView.getState().set(true);
          }}
        >
          Details
        </button>
        <div
          style={box(22, 186, 340, 234, {
            background: `url(${chip(det, before)}) center/cover #10181c`,
          })}
          role="img"
          aria-label={`Sentinel-2 on or before ${ymd(before)}`}
        />
        <div
          style={box(366, 186, 340, 234, {
            background: `url(${chip(det, after)}) center/cover #10181c`,
          })}
          role="img"
          aria-label={`Sentinel-2 on or before ${ymd(after)}`}
        />
        <div
          className="sl-g18-date"
          style={box(32, 384, 54, 21, {
            background: "#bfcdd1",
            color: "#14202a",
          })}
        >
          {md(before)}
        </div>
        <div
          className="sl-g18-date"
          style={box(373, 384, 54, 21, {
            background: "#1c2427",
            color: "#e5e8eb",
          })}
        >
          {md(after)}
        </div>
        <div
          style={box(1, 438, 724, 51, {
            background: "#131a1d",
            borderTop: "1px solid #222b2f",
          })}
        />
        <div
          className="t"
          style={box(19, 455, undefined, undefined, {
            fontSize: 12.5,
            letterSpacing: ".05em",
            fontWeight: 600,
          })}
        >
          ACTIONS
        </div>
        <button
          type="button"
          className="sl-g18-act"
          style={box(305, 451, 166, 28)}
          title="Step the left image back ten more days"
          onClick={() => setBack((b) => b + 10)}
        >
          <BpIcon name="history" size={17} />
          View historic activity
        </button>
        <button
          type="button"
          className="sl-g18-act"
          style={box(479, 451, 117, 28)}
          onClick={() => {
            close();
            useAppView.getState().setApp("reports");
          }}
        >
          <BpIcon name="document" size={17} />
          Create report
        </button>
        <button
          type="button"
          className="sl-g18-act"
          style={box(604, 451, 105, 28)}
          onClick={() => {
            close();
            useSlateSituation.getState().set("detected");
            useSlateSituation.getState().setListed(false);
            onPlan();
          }}
        >
          <BpIcon name="timeline-line-chart" size={17} />
          Create plan
        </button>
      </div>
    </div>
  );
}
