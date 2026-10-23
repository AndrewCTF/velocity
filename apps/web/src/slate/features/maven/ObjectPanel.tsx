import { useState } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import { toast } from "../../../shell/toast.js";
import { useAppView } from "../../../state/appView.js";
import { useSelection } from "../../../state/stores.js";
import {
  useTargetBoard,
  nextStage,
  unmetFor,
  REQUIREMENT_KEYS,
  REQUIREMENT_LABEL,
  type TargetEntry,
} from "../../../state/targetBoard.js";
import { useWs, titleOf, kindOf, type Fix, type Section } from "./ui.js";
import {
  useWatchTaskings,
  OUTCOMES,
  CONFIDENCE,
  GOOD_OUTCOME,
} from "./taskings.js";
import { mgrs, rel, zClock, zDate } from "./geo.js";
import { STAGE_LABEL, TaskingCard } from "./Panels.js";

// The object side panel of a watch item (M32): section nav down the left,
// the section on the right. Tasking empty state is M33; Assessment is M34
// (summary, log, re-collect) and M35 (the assessment table).

const NAV: Section[] = [
  "Overview",
  "Details",
  "Location",
  "Intelligence",
  "Collection plan",
  "Tasking",
  "Approvals",
  "Assessment",
  "Watch system",
];
const NAV2: Array<[Section, string]> = [
  ["Comments", "comment"],
  ["Activity", "pulse"],
  ["Requests", "shield"],
  ["Re-collects", "history"],
];

function Crosshair(): JSX.Element {
  return (
    <svg
      className="mv-x"
      viewBox="-14 -14 28 28"
      fill="none"
      stroke="#4a5559"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle r="8" />
      <circle r="2.4" />
      <path d="M0 -12V-6M0 6V12M-12 0H-6M6 0H12" />
    </svg>
  );
}

function Assessment({ e }: { e: TargetEntry }): JSX.Element {
  const [tab, setTab] = useState<"sum" | "log">("sum");
  const a =
    useWatchTaskings((s) => s.assess[e.entityId]) ??
    useWatchTaskings.getState().assessOf(e.entityId);
  const setRow = useWatchTaskings((s) => s.setRow);
  const addRow = useWatchTaskings((s) => s.addRow);
  const setRecollect = useWatchTaskings((s) => s.setRecollect);
  const now = Date.now();
  return (
    <div className="as2">
      <div className="tb">
        <button
          type="button"
          className={tab === "sum" ? "on" : ""}
          onClick={() => setTab("sum")}
        >
          Summary
        </button>
        <button
          type="button"
          className={tab === "log" ? "on" : ""}
          onClick={() => setTab("log")}
        >
          Assessments log
        </button>
      </div>
      {tab === "sum" ? (
        <>
          <div className="re">
            Re-collect status
            <button
              type="button"
              className={a.recollect ? "on" : ""}
              aria-pressed={a.recollect}
              onClick={() => setRecollect(e.entityId, !a.recollect)}
            >
              <BpIcon name={a.recollect ? "tick" : "plus"} />
              {a.recollect
                ? "Re-collect recommended"
                : "Set re-collect recommendation"}
            </button>
          </div>
          <div className="bda">
            <div className="bh">
              <BpIcon name="target" />
              {titleOf(e, undefined)}
              <button
                type="button"
                onClick={() => addRow(e.entityId, `R${a.rows.length + 1}`)}
              >
                <BpIcon name="plus" />
                Add new
              </button>
            </div>
            {a.rows.map((r) => (
              <div className="br" key={r.key}>
                <span className="mv-k">{r.key}</span>
                <select
                  className={
                    r.outcome
                      ? GOOD_OUTCOME.has(r.outcome)
                        ? "green"
                        : "red"
                      : "none"
                  }
                  value={r.outcome ?? ""}
                  aria-label={`${r.key} outcome`}
                  onChange={(ev) =>
                    setRow(e.entityId, r.key, {
                      outcome: ev.target.value || null,
                    })
                  }
                >
                  <option value="">No collection assessment</option>
                  {OUTCOMES.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
                <select
                  className={`cf${r.confidence ? "" : " none"}`}
                  value={r.confidence ?? ""}
                  aria-label={`${r.key} confidence`}
                  onChange={(ev) =>
                    setRow(e.entityId, r.key, {
                      confidence: ev.target.value || null,
                    })
                  }
                >
                  <option value="">No confidence level</option>
                  {CONFIDENCE.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
                <button
                  type="button"
                  title="Clear the row"
                  onClick={() =>
                    setRow(e.entityId, r.key, {
                      outcome: null,
                      confidence: null,
                    })
                  }
                >
                  <BpIcon name={r.outcome || r.confidence ? "edit" : "plus"} />
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="mvw-log">
          {a.log.length === 0 && (
            <div className="muted">No assessments recorded yet.</div>
          )}
          {a.log.map((l) => (
            <div className="item" key={l.t + l.text}>
              {l.text}
              <br />
              <small>{rel(l.t, now).replace(" from now", " ago")}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ObjectPanel({
  e,
  fix,
}: {
  e: TargetEntry;
  fix: Fix | undefined;
}): JSX.Element {
  const section = useWs((s) => s.section);
  const set = useWs((s) => s.set);
  const setApp = useAppView((s) => s.setApp);
  const select = useSelection((s) => s.select);
  const toggleRequirement = useTargetBoard((s) => s.toggleRequirement);
  const taskings = useWatchTaskings((s) => s.taskings).filter(
    (t) => t.targetId === e.entityId,
  );
  const starred = useWatchTaskings((s) => s.starred.includes(e.entityId));
  const toggleStar = useWatchTaskings((s) => s.toggleStar);
  const assess = useWatchTaskings((s) => s.assess[e.entityId]);
  const [split, setSplit] = useState(false);
  const title = titleOf(e, fix);
  const nxt = nextStage(e.stage);
  const unmet = nxt ? unmetFor(nxt, e.requirements) : [];
  const now = Date.now();
  const c = e.entityId.indexOf(":");
  const id = c >= 0 ? e.entityId.slice(c + 1) : e.entityId;
  const share = (): void => {
    const url = `${location.origin}${location.pathname}?app=targeting`;
    void navigator.clipboard?.writeText(url).then(
      () => toast.ok("Link to the board copied"),
      () => toast.warn("Clipboard unavailable"),
    );
  };

  let body: JSX.Element;
  switch (section) {
    case "Overview":
      body = (
        <div className="kv2">
          <span className="mv-k">Object</span>
          <span className="v">{e.entityId}</span>
          <span className="mv-k">Type</span>
          <span className="v">{kindOf(e)}</span>
          <span className="mv-k">Stage</span>
          <span className="v">{STAGE_LABEL[e.stage]}</span>
          <span className="mv-k">Priority</span>
          <span className="v">P{e.priority}</span>
          <span className="mv-k">On the map</span>
          <span className="v">
            {fix ? `Yes, ${fix.layer ?? "live layer"}` : "No live fix"}
          </span>
          <span className="mv-k">Taskings</span>
          <span className="v">{taskings.length}</span>
        </div>
      );
      break;
    case "Details":
      body = (
        <>
          {REQUIREMENT_KEYS.map((k) => (
            <button
              type="button"
              key={k}
              className="chk"
              aria-pressed={!!e.requirements[k]}
              onClick={() => toggleRequirement(e.entityId, k)}
            >
              <i>{e.requirements[k] ? "✓" : ""}</i>
              {REQUIREMENT_LABEL[k]}
            </button>
          ))}
          <div className="muted">
            {nxt
              ? unmet.length
                ? `${STAGE_LABEL[nxt]} is gated on ${unmet.length} item${unmet.length === 1 ? "" : "s"}.`
                : `Ready for ${STAGE_LABEL[nxt]}.`
              : "Final stage."}
          </div>
        </>
      );
      break;
    case "Location":
      body = fix ? (
        <div className="kv2">
          <span className="mv-k">Latitude</span>
          <span className="v">{fix.lat.toFixed(5)}</span>
          <span className="mv-k">Longitude</span>
          <span className="v">{fix.lon.toFixed(5)}</span>
          <span className="mv-k">MGRS</span>
          <span className="v">{mgrs(fix.lat, fix.lon)}</span>
          <span className="mv-k">Read</span>
          <span className="v">
            {zDate(now)} {zClock(now)}Z
          </span>
        </div>
      ) : (
        <div className="muted">
          No live fix: the object is not on the map right now.
        </div>
      );
      break;
    case "Intelligence":
    case "Comments":
      body = e.note ? (
        <div className="item">{e.note}</div>
      ) : (
        <div className="muted">
          {section === "Comments"
            ? "No comments on this target."
            : "No linked intelligence."}
        </div>
      );
      break;
    case "Collection plan":
      body = taskings.some((t) => t.plan || t.planCount) ? (
        <>
          {taskings
            .filter((t) => t.plan || t.planCount)
            .map((t) => (
              <div className="item" key={t.id}>
                {t.taskType}: {t.plan || "No plan text"}
                <br />
                <small>{t.planCount} entries</small>
              </div>
            ))}
        </>
      ) : (
        <div className="muted">
          No collection plan. Plans are written in the tasking form.
        </div>
      );
      break;
    case "Tasking":
      body =
        taskings.length > 0 ? (
          <>
            {taskings.map((t) => (
              <TaskingCard
                key={t.id}
                t={t}
                on={false}
                onClick={() => set({ mode: "taskings", activeTask: t.id })}
              />
            ))}
          </>
        ) : (
          <div className="empty">
            <Crosshair />
            <div className="t">No assets proposed</div>
            <button
              type="button"
              onClick={() => set({ mode: "rec", target: e.entityId })}
            >
              Propose assets →
            </button>
            <button
              type="button"
              onClick={() => {
                select(e.entityId);
                setApp("map");
              }}
            >
              <BpIcon name="lightning" />
              Propose assets in Velocity ↗
            </button>
          </div>
        );
      break;
    case "Approvals":
    case "Requests":
      body = (
        <>
          {taskings
            .filter((t) =>
              section === "Requests"
                ? t.status === "proposed"
                : t.status !== "proposed",
            )
            .map((t) => (
              <div className="item" key={t.id}>
                {t.taskType} · {t.asset.label}: {t.status}
                <br />
                <small>
                  {rel(t.decidedMs ?? t.createdMs, now).replace(
                    " from now",
                    " ago",
                  )}
                </small>
              </div>
            ))}
          {!taskings.some((t) =>
            section === "Requests"
              ? t.status === "proposed"
              : t.status !== "proposed",
          ) && (
            <div className="muted">
              {section === "Requests"
                ? "No taskings awaiting a decision."
                : "No decisions yet."}
            </div>
          )}
        </>
      );
      break;
    case "Assessment":
      body = <Assessment e={e} />;
      break;
    case "Watch system":
      body = (
        <div className="kv2">
          <span className="mv-k">Layer</span>
          <span className="v">{fix?.layer ?? "Not on the map"}</span>
          <span className="mv-k">Board</span>
          <span className="v">
            {e.id.startsWith("tb_") ? "This device" : "Synced"}
          </span>
          <span className="mv-k">Marking</span>
          <span className="v">{e.classification}</span>
        </div>
      );
      break;
    case "Activity":
      body = (
        <>
          {taskings.map((t) => (
            <div className="item" key={t.id}>
              {t.taskType} with {t.asset.label} created
              <br />
              <small>
                {rel(t.createdMs, now).replace(" from now", " ago")}
              </small>
            </div>
          ))}
          {taskings.length === 0 && (
            <div className="muted">No activity yet.</div>
          )}
        </>
      );
      break;
    case "Re-collects":
      body = (
        <div className="muted">
          {assess?.recollect
            ? "Re-collect recommended in the assessment."
            : "No re-collect recommended."}
        </div>
      );
      break;
  }

  return (
    <section
      className="mv-obj"
      aria-label={`${title} details`}
      style={split ? { width: 600 } : undefined}
    >
      <div className="ot">
        <button
          type="button"
          title="Close the panel"
          onClick={() => set({ objOpen: false })}
        >
          <BpIcon name="double-chevron-left" />
        </button>
        {title}
        <button
          type="button"
          className={`st2${starred ? " on" : ""}`}
          aria-pressed={starred}
          title="Star"
          onClick={() => toggleStar(e.entityId)}
        >
          <BpIcon name={starred ? "star" : "star-empty"} />
        </button>
        <span className="cl">
          {e.classification.replace("UNCLASSIFIED", "UNCLAS")}
        </span>
        <button
          type="button"
          title="Widen the panel"
          aria-pressed={split}
          onClick={() => setSplit(!split)}
        >
          <BpIcon name="layout-two-columns" />
        </button>
        <button type="button" onClick={share} title="Copy a link to the board">
          Share
        </button>
        <button
          type="button"
          title="Close"
          onClick={() => set({ objOpen: false })}
        >
          <BpIcon name="cross" />
        </button>
      </div>
      <div className="cls">
        {e.classification.replace("UNCLASSIFIED", "UNCLAS")}
      </div>
      <div className="oh">
        <span className="mv-av">
          <i />
        </span>
        <span className="t">
          <span>{id} / </span>
          {title}
        </span>
        <span className="s">
          {kindOf(e)}
          {fix ? `, ${fix.layer ?? "live"}` : ", no live fix"}
        </span>
        <span className="bs">
          <button
            type="button"
            className="wn"
            title="Checklist items gating the next stage"
            onClick={() => set({ section: "Details" })}
          >
            <BpIcon name="warning-sign" />
            {unmet.length}
          </button>
          <button
            type="button"
            title="Marking and checklist"
            onClick={() => set({ section: "Watch system" })}
          >
            <BpIcon name="shield" />
          </button>
          <button
            type="button"
            title="Copy a link to the board"
            onClick={share}
          >
            <BpIcon name="share" />
          </button>
          <button
            type="button"
            title="Overview"
            onClick={() => set({ section: "Overview" })}
          >
            <BpIcon name="more" />
          </button>
        </span>
      </div>
      <div className="ob">
        <nav>
          {NAV.map((n) => (
            <button
              type="button"
              key={n}
              className={n === section ? "on" : ""}
              aria-current={n === section}
              onClick={() => set({ section: n })}
            >
              {n}
            </button>
          ))}
          <hr />
          {NAV2.map(([n, ic]) => (
            <button
              type="button"
              key={n}
              className={n === section ? "on" : ""}
              aria-current={n === section}
              onClick={() => set({ section: n })}
            >
              <BpIcon name={ic} />
              {n}
            </button>
          ))}
        </nav>
        <div className="oc">
          <h3>{section}</h3>
          {body}
        </div>
      </div>
    </section>
  );
}
