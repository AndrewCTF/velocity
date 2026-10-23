import { useEffect } from "react";
import { RING_HOURS, useProjectFx } from "../mapfx/store.js";
import "./observation.css";

// Progress toast with Cancel (features-a copy G25, frame t153: box at frame
// (710, 115) 500x68). It runs while the projection's range rings draw
// outward one per step; Cancel clears the projection. When the vessel reports
// no speed there is nothing to project, and the toast says so.

const STEP_MS = 160;

export function ProjectToast(): JSX.Element | null {
  const p = useProjectFx((s) => s.p);
  const running = useProjectFx((s) => s.running);
  const drawn = useProjectFx((s) => s.drawn);
  useEffect(() => {
    if (!running || !p) return;
    if (p.speedKn <= 0) {
      // Nothing was drawn: drop the projection so the button resets.
      const t = window.setTimeout(
        () => useProjectFx.getState().set(null),
        2600,
      );
      return () => window.clearTimeout(t);
    }
    if (drawn >= RING_HOURS.length) {
      useProjectFx.getState().setRunning(false);
      return;
    }
    const t = window.setTimeout(
      () => useProjectFx.getState().setDrawn(drawn + 1),
      STEP_MS,
    );
    return () => window.clearTimeout(t);
  }, [running, p, drawn]);
  if (!running || !p) return null;
  const still = p.speedKn <= 0;
  const frac = still ? 1 : drawn / RING_HOURS.length;
  return (
    <div className="sl-g25" role="status" aria-live="polite">
      <div
        className="t"
        style={{
          left: 18,
          top: 14,
          width: 400,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {still
          ? `${p.name} reports no speed: nothing to project`
          : `Projecting possible routes for ${p.name}...`}
      </div>
      <div
        style={{
          left: 20,
          top: 42,
          width: 380,
          height: 9,
          background: "#4d585e",
          borderRadius: 1,
        }}
      />
      <div
        style={{
          left: 20,
          top: 42,
          width: 380 * frac,
          height: 9,
          background: "#9aa5ab",
          borderRadius: 1,
        }}
      />
      <button
        type="button"
        className="t sl-link"
        style={{ left: 425, top: 24 }}
        onClick={() => useProjectFx.getState().set(null)}
      >
        Cancel
      </button>
    </div>
  );
}
