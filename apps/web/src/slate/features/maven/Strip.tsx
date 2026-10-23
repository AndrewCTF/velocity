import { BpIcon } from "../../../shell/BpIcon.js";
import { useWs, useNow, type Fix } from "./ui.js";
import { useWatchTaskings, tenLine, type Tasking } from "./taskings.js";
import { hms, mgrs, rel, zClock, zDate } from "./geo.js";
import type { Draft } from "./Panels.js";
import type { Ranked } from "./recommend.js";
import { toast } from "../../../shell/toast.js";

// The bottom strip: the tasking Gantt (M47) while a tasking is drafted or the
// taskings of the selected target are listed, and the detail strip with the
// 10-line message and the decision row (M51, M52, M53) for an open tasking.

interface Bar {
  id: string;
  lane: string;
  kind: "air" | "sat";
  title: string;
  startMs: number;
  totMs: number;
  ok: boolean;
}

// Tick spacing that gives 6-12 labels across the window.
const STEPS = [
  60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 21600e3,
];

function axis(t0: number, t1: number): number[] {
  const span = Math.max(60e3, t1 - t0);
  const step = STEPS.find((s) => span / s <= 10) ?? 43200e3;
  const out: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return out;
}

function Timeline({
  bars,
  w,
  x0,
  label,
}: {
  bars: Bar[];
  w: number;
  /** Left edge of the time area, copy units. */
  x0: number;
  label: (b: Bar) => JSX.Element;
}): JSX.Element {
  const now = useNow();
  const lo = Math.min(now, ...bars.map((b) => b.startMs));
  const hi = Math.max(now + 60e3, ...bars.map((b) => b.totMs));
  const pad = (hi - lo) * 0.08 + 30e3;
  const t0 = lo - pad;
  const t1 = hi + pad;
  const span = w - x0 - 10;
  const x = (t: number): number => x0 + ((t - t0) / (t1 - t0)) * span;
  const ticks = axis(t0, t1);
  const lanes = [...new Set(bars.map((b) => b.lane))];
  const draft = bars[0];
  return (
    <div className="gt">
      <div className="mv-ax">
        <span className="d" style={{ left: x0 }}>
          {zDate(t0)} {zClock(t0, false)}Z
        </span>
        {draft && (
          <span
            className="win"
            style={{
              left: x(draft.startMs),
              width: Math.max(4, x(draft.totMs) - x(draft.startMs)),
            }}
          >
            <i
              style={{
                width: `${Math.max(0, Math.min(1, (now - draft.startMs) / Math.max(1, draft.totMs - draft.startMs))) * 100}%`,
              }}
            />
          </span>
        )}
        {ticks.map((t) => (
          <span key={t} className="tk2" style={{ left: x(t) - 18 }}>
            {zClock(t, false)}Z
          </span>
        ))}
      </div>
      {ticks.map((t) => (
        <span key={t} className="mv-gl" style={{ left: x(t) }} />
      ))}
      {lanes.map((lane, i) => {
        const lb = bars.filter((b) => b.lane === lane);
        const top = 39 + i * 50;
        return (
          <div key={lane}>
            <div className="lane" style={{ top }}>
              {label(lb[0]!)}
            </div>
            {lb.map((b) => (
              <div key={b.id}>
                <span
                  className="blue"
                  style={{
                    top: top - 9,
                    left: x(b.startMs),
                    width: Math.max(3, x(b.totMs) - x(b.startMs)),
                  }}
                />
                <span
                  className="dia"
                  style={{ top: top - 9, left: x(b.totMs) - 3 }}
                />
                <span
                  className={`prop${b.ok ? " ok" : ""}`}
                  style={{
                    top,
                    left: x(b.startMs),
                    width: Math.max(40, x(b.totMs) - x(b.startMs)),
                  }}
                >
                  <BpIcon name="route" />
                  <span>
                    {b.title}
                    <small>{hms((b.totMs - b.startMs) / 1000)}</small>
                  </span>
                </span>
              </div>
            ))}
          </div>
        );
      })}
      <span className="now" style={{ left: x(now) }} />
    </div>
  );
}

function laneLabel(b: Bar): JSX.Element {
  return (
    <>
      <span className="mv-av">
        <BpIcon name={b.kind === "air" ? "airplane" : "satellite"} />
      </span>
      <span>
        <b>{b.lane}</b>
        <small>{b.kind === "air" ? "AIRCRAFT" : "SATELLITE"}</small>
      </span>
    </>
  );
}

/** M47: Gantt of the drafted tasking, or of the selected target's taskings. */
export function GanttStrip({
  w,
  pos,
  draft,
  setDraft,
  picked,
}: {
  w: number;
  pos: React.CSSProperties;
  draft: Draft | null;
  setDraft: (d: Draft) => void;
  picked: Ranked | undefined;
}): JSX.Element {
  const target = useWs((s) => s.target);
  const set = useWs((s) => s.set);
  const taskings = useWatchTaskings((s) => s.taskings);
  const show = useWs((s) => s.ganttAll);
  const now = Date.now();
  const bars: Bar[] = [];
  if (draft && picked) {
    const a = picked.asset;
    bars.push({
      id: "draft",
      lane: a.label,
      kind: a.kind,
      title: `Proposed ${draft.taskType || a.taskType}`,
      startMs: draft.startMs,
      totMs: draft.totMs ?? draft.startMs + (a.tttS ?? 0) * 1000,
      ok: false,
    });
  }
  for (const t of taskings)
    if ((show || t.targetId === target) && t.status !== "rejected")
      bars.push({
        id: t.id,
        lane: t.asset.label,
        kind: t.asset.kind,
        title: `${t.status === "proposed" ? "Proposed" : t.status === "approved" ? "Approved" : "Executed"} ${t.taskType}`,
        startMs: t.startMs,
        totMs: t.totMs,
        ok: t.status !== "proposed",
      });
  const head = bars[0];
  const toLocal = (ms: number): string =>
    new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  return (
    <div className="strip" style={pos}>
      <div className="sh">
        <select
          value={show ? "all" : "planned"}
          onChange={(e) => set({ ganttAll: e.target.value === "all" })}
          aria-label="Which taskings"
        >
          <option value="planned">Planned</option>
          <option value="all">All targets</option>
        </select>
        Start
        <input
          type="datetime-local"
          aria-label="Start"
          disabled={!draft}
          value={head ? toLocal(head.startMs) : toLocal(now)}
          onChange={(e) => {
            const v = new Date(e.target.value).getTime();
            if (draft && isFinite(v)) setDraft({ ...draft, startMs: v });
          }}
        />
        Time on Target
        <input
          type="datetime-local"
          aria-label="Time on Target"
          disabled={!draft}
          value={head ? toLocal(head.totMs) : toLocal(now)}
          onChange={(e) => {
            const v = new Date(e.target.value).getTime();
            if (draft && isFinite(v)) setDraft({ ...draft, totMs: v });
          }}
        />
        <span className="end">
          <button
            type="button"
            title="Hide the strip"
            onClick={() => set({ strip: false })}
          >
            <BpIcon name="cross" />
          </button>
        </span>
      </div>
      {bars.length > 0 ? (
        <Timeline bars={bars} w={w} x0={135} label={laneLabel} />
      ) : (
        <p className="note">No taskings for this target yet.</p>
      )}
    </div>
  );
}

/** M51 M52 M53: the open tasking with its 10-line message and decision row. */
export function DetailStrip({
  t,
  w,
  pos,
  fix,
}: {
  t: Tasking;
  w: number;
  pos: React.CSSProperties;
  fix: Fix | undefined;
}): JSX.Element {
  const set = useWs((s) => s.set);
  const decide = useWatchTaskings((s) => s.decide);
  const now = useNow();
  const grid = fix ? mgrs(fix.lat, fix.lon) : null;
  const tot = `${zDate(t.totMs)} ${zClock(t.totMs)}Z`;
  const lines = tenLine(t, grid, tot);
  const copy = (): void => {
    void navigator.clipboard?.writeText(lines.join("\n")).then(
      () => toast.ok("10-line message copied"),
      () => toast.warn("Clipboard unavailable"),
    );
  };
  const retask = (): void =>
    set({
      mode: "create",
      target: t.targetId,
      draftAsset: t.asset.id,
      activeTask: null,
    });
  const a = t.asset;
  const bar: Bar = {
    id: t.id,
    lane: t.taskType,
    kind: a.kind,
    title: a.label,
    startMs: t.startMs,
    totMs: t.totMs,
    ok: t.status !== "proposed",
  };
  return (
    <div className="strip" style={pos}>
      <div className="sh dk">
        <span className="mv-ttl mono">
          <span className="ri">
            <BpIcon name="random" />
          </span>
          {t.taskType} → {t.targetLabel.toUpperCase()}
        </span>
        <span className="tot">
          {zDate(t.totMs)} {zClock(t.totMs, false)}Z
        </span>
        <button
          type="button"
          title="Edit: re-open the tasking form"
          onClick={retask}
        >
          <BpIcon
            name="edit"
            style={{ width: 8, height: 8, color: "#dfe3e6" }}
          />
        </button>
        <span className="end dec">
          <span className="ms" title="Tasking marking">
            <BpIcon name="shield" />
            {t.security.replace("UNCLASSIFIED", "UNCLAS")}
          </span>
          {t.status === "proposed" && (
            <button
              type="button"
              className="rj"
              onClick={() => decide(t.id, "rejected")}
            >
              <BpIcon name="cross" />
              Reject
            </button>
          )}
          <button type="button" className="rt" onClick={retask}>
            <BpIcon name="redo" />
            Retask
          </button>
          {t.status === "proposed" && (
            <button
              type="button"
              className="ap"
              onClick={() => {
                decide(t.id, "approved");
                set({ toast: "Tasking approved." });
              }}
            >
              Approve →
            </button>
          )}
          {(t.status === "approved" || t.status === "executed") && (
            <button
              type="button"
              className="ex"
              disabled={t.status === "executed"}
              title={
                t.status === "executed"
                  ? "Executed"
                  : "Mark the tasking executed"
              }
              onClick={() => decide(t.id, "executed")}
            >
              Task executed →
            </button>
          )}
          {t.status === "rejected" && (
            <span style={{ color: "#e0536a", fontSize: 7.6 }}>Rejected</span>
          )}
          <button
            type="button"
            title="Close"
            onClick={() => set({ activeTask: null })}
          >
            <BpIcon name="more" />
          </button>
          <button
            type="button"
            title="Comments on the target"
            onClick={() => set({ objOpen: true, section: "Comments" })}
          >
            <BpIcon name="chat" style={{ color: "#9ac24a" }} />
          </button>
          <button type="button" title="Copy the 10-line message" onClick={copy}>
            <BpIcon name="send-message" style={{ color: "#5a7a4a" }} />
          </button>
        </span>
      </div>
      <div style={{ position: "relative", flex: 1, display: "flex" }}>
        <div
          style={{ position: "relative", width: w - 169 - 150, height: "100%" }}
        >
          <Timeline
            bars={[bar]}
            w={w - 169 - 150}
            x0={100}
            label={(b) => (
              <span>
                <b>{b.lane}</b>
                <small>{t.targetLabel}</small>
              </span>
            )}
          />
        </div>
        <div className="dc" style={{ left: w - 169 - 152, top: 7 }}>
          <div
            className="ac"
            style={{ width: 147, marginTop: 0, background: "transparent" }}
          >
            <div className="top" style={{ height: 36 }}>
              <span
                className="mv-av"
                style={{ width: 18, height: 18, top: 8, left: 9 }}
              >
                <BpIcon name={a.kind === "air" ? "airplane" : "satellite"} />
              </span>
              <span className="mv-n" style={{ left: 37, fontSize: 7.6 }}>
                {a.label}
              </span>
              <span className="mv-k" style={{ left: 37, fontSize: 7.2 }}>
                {a.kind === "air" ? "AIRCRAFT" : "SATELLITE"}
                <small style={{ fontSize: 5.4 }}>{a.chip}</small>
              </span>
            </div>
            <div
              className="af"
              style={{ background: "transparent", height: 16 }}
            >
              <span className={`lv${a.kind === "sat" ? " pred" : ""}`} />
              <b>{a.kind === "air" ? "LIVE" : "PREDICTED"}</b>
              <small>({rel(a.at, now).replace(" from now", " ago")})</small>
              <span className="src">
                <BpIcon name="database" />
                {a.source}
              </span>
            </div>
          </div>
        </div>
        <div className="msg">
          <div className="mh">
            <select aria-label="Message format" defaultValue="10 Line">
              <option>10 Line</option>
            </select>
            <button
              type="button"
              title="Edit: re-open the tasking form"
              onClick={retask}
            >
              <BpIcon name="edit" />
            </button>
            <button
              type="button"
              title="Target details"
              onClick={() => set({ objOpen: true, section: "Location" })}
            >
              <BpIcon name="cog" />
            </button>
            <button type="button" title="Copy the message" onClick={copy}>
              <BpIcon name="clipboard" />
            </button>
          </div>
          <pre>{lines.join("\n")}</pre>
        </div>
      </div>
    </div>
  );
}
