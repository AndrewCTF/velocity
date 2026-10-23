import { useEffect, useMemo, useRef, useState } from "react";
import { BpIcon } from "../../../shell/BpIcon.js";
import { useSelection } from "../../../state/stores.js";
import {
  isLocked,
  type TargetEntry,
  type TargetStage,
} from "../../../state/targetBoard.js";
import { useWs, titleOf, kindOf, useNow, type Fix, type Mode } from "./ui.js";
import {
  METRICS,
  METRIC_GAP,
  METRIC_LABEL,
  type Asset,
  type Ranked,
} from "./recommend.js";
import { useWatchTaskings, type Tasking } from "./taskings.js";
import { hms, rel, zClock, zDate } from "./geo.js";

// The workspace's left column, one view per mode: target list (M37), asset
// recommender (M41, M42, M45), tasking form (M46) and taskings list (M50,
// M54). Plus the metrics dialog (M44).

export const STAGE_LABEL: Record<TargetStage, string> = {
  confirm: "Confirm",
  attach_intel: "Attach intel",
  approvals: "Approvals",
  weaponeer: "Weaponeer",
  execute: "Execute",
  assess: "Assess",
  complete: "Complete",
};
const STAGE_DOT: Record<TargetStage, string> = {
  confirm: "#c9a04a",
  attach_intel: "#5b6bd0",
  approvals: "#8a949a",
  weaponeer: "#d9546a",
  execute: "#4a9a5a",
  assess: "#d9a3f5",
  complete: "#c5cbd3",
};

const short = (c: string): string =>
  c
    .replace("UNCLASSIFIED", "UNCLAS")
    .replace("CONFIDENTIAL", "CONF")
    .replace("TOP SECRET", "TS");

export interface PanelProps {
  entries: TargetEntry[];
  fixes: Map<string, Fix>;
  ranked: Ranked[];
  recs: {
    airAt: number;
    airErr: string | null;
    satErr: string | null;
    airBusy: boolean;
    satBusy: boolean;
    refresh: () => void;
  };
  apiNote: string | null;
  onBoard: () => void;
}

function Tabs({ mode }: { mode: Mode }): JSX.Element {
  const set = useWs((s) => s.set);
  const collapsed = useWs((s) => s.collapsed);
  const tk = mode === "taskings";
  return (
    <div className="tabs">
      <button
        type="button"
        className={tk ? "box" : "on"}
        onClick={() => set({ mode: "targets" })}
        title="Targets on the board"
      >
        <BpIcon name="target" />
        {!tk && "Targets"}
      </button>
      <button
        type="button"
        className={tk ? "on" : ""}
        onClick={() => set({ mode: "taskings", activeTask: null })}
        title="Taskings"
      >
        <BpIcon name="route" />
        {tk && "Taskings"}
      </button>
      <button
        type="button"
        className={tk ? "box" : ""}
        onClick={() => set({ mode: "rec" })}
        title="Assets: the recommender for the selected target"
      >
        <BpIcon name="fighter-jet" />
      </button>
      <button
        type="button"
        className={tk ? "box" : ""}
        onClick={() => set({ metrics: true })}
        title="Metrics the recommender prioritizes"
      >
        <BpIcon name="warning-sign" />
      </button>
      <button
        type="button"
        className={tk ? "box" : ""}
        onClick={() => set({ overlays: !useWs.getState().overlays })}
        title="Show or hide the rings and lines on the map"
      >
        <BpIcon name="polygon-filter" />
      </button>
      <button
        type="button"
        className="mv-menu"
        onClick={() => set({ collapsed: !collapsed })}
        title="Collapse the panel"
      >
        <BpIcon name="menu-open" style={{ width: 11, height: 11 }} />
      </button>
    </div>
  );
}

function BoardSel({
  apiNote,
  onBoard,
}: Pick<PanelProps, "apiNote" | "onBoard">): JSX.Element {
  return (
    <div className="bsel">
      <div className="mv-hd">
        TARGET BOARD
        <span className="mv-n">1 board</span>
        <button
          type="button"
          disabled
          title="One board per user: the board API has no second board"
        >
          <BpIcon name="plus" />
        </button>
      </div>
      <div className="row">
        <span className="box" title={apiNote ?? "Your board"}>
          <span className="mv-k">Board:</span>
          <BpIcon name="clipboard" />
          {apiNote ? "This device" : "My board"}
          <button
            type="button"
            className="mv-x"
            title="Open the board"
            onClick={onBoard}
          >
            <BpIcon name="cross" />
          </button>
        </span>
        <button
          type="button"
          className="more"
          title="Open the board"
          onClick={onBoard}
        >
          <BpIcon name="more" />
        </button>
      </div>
    </div>
  );
}

function Search({
  value,
  set,
  ph,
  inputRef,
  filter,
  onFilter,
}: {
  value: string;
  set: (v: string) => void;
  ph: string;
  inputRef?: React.RefObject<HTMLInputElement>;
  filter: boolean;
  onFilter: () => void;
}): JSX.Element {
  return (
    <div className="srch">
      <label>
        <BpIcon name="search" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => set(e.target.value)}
          placeholder={ph}
          aria-label={ph}
        />
      </label>
      <button
        type="button"
        className={`fbtn${filter ? " on" : ""}`}
        aria-pressed={filter}
        onClick={onFilter}
        title="Only items with a live position on the map"
      >
        <BpIcon name="filter-list" />
      </button>
    </div>
  );
}

// ----------------------------------------------------------------- M37

function TargetCard({
  e,
  fix,
  sel,
  nTasks,
}: {
  e: TargetEntry;
  fix: Fix | undefined;
  sel: boolean;
  nTasks: number;
}): JSX.Element {
  const set = useWs((s) => s.set);
  const select = useSelection((s) => s.select);
  const title = titleOf(e, fix);
  const open = (): void => {
    set({ target: e.entityId });
    select(e.entityId);
  };
  return (
    <div
      className={`tc${sel ? " sel" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={sel}
      onClick={open}
      onKeyDown={(k) => {
        if (k.key === "Enter" || k.key === " ") {
          k.preventDefault();
          open();
        }
      }}
    >
      <div className="bd">
        <span className="tg">
          <BpIcon name="target" />
        </span>
        <span className="nm">{title}</span>
        <span className="sb">
          {kindOf(e)} · {nTasks} tasking{nTasks === 1 ? "" : "s"}
        </span>
        <span className="pr">P{e.priority}</span>
      </div>
      {sel && (
        <div className="ext">
          <div className="h">
            <BpIcon name="chevron-down" />
            Intel ({fix ? 1 : 0})
          </div>
          <div className="in">
            {fix ? (
              <>
                <BpIcon name="media" />
                {fix.layer ?? "Live layer"}
                <br />
                {fix.lat.toFixed(4)}, {fix.lon.toFixed(4)}
                <div className="mv-by">Live fix on the map</div>
              </>
            ) : (
              <>
                <BpIcon name="media" />
                No live fix
                <div className="mv-by">
                  The object is not on the map right now
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            className="task"
            title="Recommend assets for this target"
            onClick={(ev) => {
              ev.stopPropagation();
              set({ target: e.entityId, mode: "rec" });
            }}
          >
            <BpIcon name="arrow-right" />
            Task
          </button>
        </div>
      )}
      <div className="mv-ft">
        <span className="d" style={{ background: STAGE_DOT[e.stage] }} />
        {STAGE_LABEL[e.stage]}
        <span className="cl">{short(e.classification)}</span>
      </div>
      {isLocked(e.stage, e.requirements) && (
        <span className="lock" title="Confirmation checklist incomplete">
          <BpIcon name="warning-sign" />
        </span>
      )}
    </div>
  );
}

function TargetsView(p: PanelProps): JSX.Element {
  const target = useWs((s) => s.target);
  const set = useWs((s) => s.set);
  const taskings = useWatchTaskings((s) => s.taskings);
  const [q, setQ] = useState("");
  const [liveOnly, setLiveOnly] = useState(false);
  const [byStage, setByStage] = useState(false);
  const [lockedOnly, setLockedOnly] = useState(false);
  const [desc, setDesc] = useState(true);
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    const order = Object.keys(STAGE_LABEL);
    return p.entries
      .filter((e) => {
        const f = p.fixes.get(e.entityId);
        if (liveOnly && !f) return false;
        if (lockedOnly && !isLocked(e.stage, e.requirements)) return false;
        return (
          n === "" || `${titleOf(e, f)} ${e.entityId}`.toLowerCase().includes(n)
        );
      })
      .sort((a, b) =>
        byStage
          ? order.indexOf(a.stage) - order.indexOf(b.stage)
          : (desc ? 1 : -1) * (a.priority - b.priority),
      );
  }, [p.entries, p.fixes, q, liveOnly, lockedOnly, byStage, desc]);

  return (
    <>
      <Tabs mode="targets" />
      <BoardSel apiNote={p.apiNote} onBoard={p.onBoard} />
      <Search
        value={q}
        set={setQ}
        ph="Search targets..."
        filter={liveOnly}
        onFilter={() => setLiveOnly(!liveOnly)}
      />
      <div className="mv-chips">
        <button
          type="button"
          className={byStage ? "on" : ""}
          aria-pressed={byStage}
          onClick={() => setByStage(!byStage)}
          title="Order by stage"
        >
          <BpIcon name="layout-grid" />
          Stage
        </button>
        <button
          type="button"
          className={lockedOnly ? "on" : ""}
          aria-pressed={lockedOnly}
          onClick={() => setLockedOnly(!lockedOnly)}
          title="Only targets whose checklist is incomplete"
        >
          <BpIcon name="edit" />
          Target Status
        </button>
        <button
          type="button"
          className={liveOnly ? "on" : ""}
          aria-pressed={liveOnly}
          onClick={() => setLiveOnly(!liveOnly)}
          title="Only targets with a live fix on the map"
        >
          <BpIcon name="polygon-filter" />
          Battlespace
        </button>
        <button
          type="button"
          className="end"
          onClick={() => setDesc(!desc)}
          title={desc ? "Highest priority first" : "Lowest priority first"}
        >
          <BpIcon name={desc ? "sort-desc" : "sort-asc"} />
        </button>
      </div>
      <button
        type="button"
        className="recbtn"
        disabled={!target}
        title={
          target
            ? "Recommend assets for the selected target"
            : "Select a target first"
        }
        onClick={() => set({ mode: "rec" })}
      >
        <BpIcon name="flow-linear" />
        Recommend Taskings
        <span className="ar">
          <BpIcon name="arrow-right" />
        </span>
      </button>
      <div className="list">
        {rows.map((e) => (
          <TargetCard
            key={e.id}
            e={e}
            fix={p.fixes.get(e.entityId)}
            sel={e.entityId === target}
            nTasks={taskings.filter((t) => t.targetId === e.entityId).length}
          />
        ))}
        {p.entries.length === 0 && (
          <p className="note">
            {p.apiNote ? `${p.apiNote} ` : ""}No targets on the board yet.
            Select an object on the map, open the <b>board</b> and press Add.
          </p>
        )}
      </div>
    </>
  );
}

// ----------------------------------------------------------------- M41 M42 M45

function live(a: Asset, now: number): [string, string, boolean] {
  if (a.kind === "air")
    return [
      "LIVE",
      `(updated ${rel(a.at - (a.seenS ?? 0) * 1000, now).replace(" from now", " ago")})`,
      false,
    ];
  return ["PREDICTED", `(pass ${rel(a.passStartMs ?? now, now)})`, true];
}

function AssetFacts({ a }: { a: Asset }): JSX.Element {
  return a.kind === "air" ? (
    <div className="chips2">
      <span className="mv-chip">
        Alt{" "}
        {a.altFt === null || a.altFt === undefined ? "N/A" : `${a.altFt} ft`}
      </span>
      <span className="mv-chip">GS {a.kt} kt</span>
      <span className="mv-chip">
        Trk{" "}
        {a.trk === null || a.trk === undefined
          ? "N/A"
          : String(Math.round(a.trk)).padStart(3, "0")}
      </span>
      <span className="mv-chip">Seen {Math.round(a.seenS ?? 0)} s</span>
    </div>
  ) : (
    <span className="mv-chip">{a.chip}</span>
  );
}

function PairCard({
  r,
  e,
  fix,
  onTask,
  onEdit,
}: {
  r: Ranked;
  e: TargetEntry;
  fix: Fix | undefined;
  onTask: () => void;
  onEdit: () => void;
}): JSX.Element {
  const now = useNow();
  const a = r.asset;
  const [lv, sub, pred] = live(a, now);
  return (
    <div className="pc">
      <span
        className="mv-bar"
        style={{ width: `${Math.round(222 * r.bar)}px` }}
      />
      <div className="ph">
        <BpIcon name="flow-linear" />
        {r.match}
        <button
          type="button"
          className="ed"
          onClick={onEdit}
          title="Choose this asset in the tasking form"
        >
          <BpIcon name="edit" />
          Edit Asset
        </button>
        <button
          type="button"
          className="pl"
          onClick={onTask}
          title="Task this asset now"
        >
          <BpIcon name="plus" />
        </button>
      </div>
      <div className="pb">
        <div className="as">
          <BpIcon name={a.kind === "air" ? "airplane" : "satellite"} />
          <b>{a.label}</b>
          <AssetFacts a={a} />
        </div>
        <span className="mv-sep" />
        <div className="tgt">
          <span className="ring">
            <BpIcon name="target" />
          </span>
          {titleOf(e, fix)}
          <span className="mv-k">
            {a.distNm !== undefined
              ? `${a.distNm.toFixed(1)} nm · ${hms(a.tttS ?? NaN)}`
              : `in ${hms(a.tttS ?? NaN)}`}
          </span>
        </div>
      </div>
      <div className="pf">
        <span className={`lv${pred ? " pred" : ""}`} />
        <b>{lv}</b> <small>{sub}</small>
        <span className="src">
          <BpIcon name="database" />
          {a.source}
        </span>
      </div>
    </div>
  );
}

function RecView(p: PanelProps): JSX.Element {
  const target = useWs((s) => s.target);
  const set = useWs((s) => s.set);
  const create = useWatchTaskings((s) => s.create);
  const now = useNow();
  const [kind, setKind] = useState<"all" | "air" | "sat">("all");
  const e = p.entries.find((x) => x.entityId === target);
  const fix = target ? p.fixes.get(target) : undefined;
  const list = p.ranked.filter((r) => kind === "all" || r.asset.kind === kind);
  const busy = (p.recs.airBusy && p.recs.airAt === 0) || p.recs.satBusy;

  const quick = (a: Asset): void => {
    if (!e) return;
    const t = createFrom(create, e, fix, a, null);
    set({ mode: "taskings", activeTask: t.id, toast: "Tasking created." });
  };

  return (
    <>
      <Tabs mode="rec" />
      <div className="rhd">
        <button
          type="button"
          onClick={() => set({ mode: "targets" })}
          title="Back to targets"
        >
          <BpIcon name="arrow-left" />
        </button>
        <BpIcon name="flow-linear" className="i fi" />
        <div>
          <div className="tt mono">AI ASSET TASKING RECOMMENDER</div>
          <div className="mv-sub">
            Last refresh{" "}
            {p.recs.airAt
              ? rel(p.recs.airAt, now).replace(" from now", " ago")
              : "pending"}{" "}
            ·{" "}
            <button type="button" onClick={p.recs.refresh}>
              Refresh
            </button>
          </div>
        </div>
        <button
          type="button"
          className="cog"
          onClick={() => set({ metrics: true })}
          title="Metrics"
        >
          <BpIcon name="settings" />
        </button>
      </div>
      <div className="mv-chips">
        <button
          type="button"
          className={kind === "air" ? "on" : ""}
          aria-pressed={kind === "air"}
          onClick={() => setKind(kind === "air" ? "all" : "air")}
          title="Aircraft only"
        >
          <BpIcon name="pin" />
          My Assets
        </button>
        <button
          type="button"
          className={kind === "sat" ? "on" : ""}
          aria-pressed={kind === "sat"}
          onClick={() => setKind(kind === "sat" ? "all" : "sat")}
          title="Satellites only"
        >
          <BpIcon name="grid-view" />
          Domain
        </button>
        <button
          type="button"
          onClick={() => set({ mode: "targets" })}
          title="Pick another target"
        >
          <BpIcon name="polygon-filter" />
          Battlespace
        </button>
        <button
          type="button"
          className="end"
          onClick={() => set({ metrics: true })}
          title="Metrics"
        >
          <BpIcon name="more" />
        </button>
      </div>
      {busy && (
        <div className="rload" role="status" aria-label="loading">
          <span className="spin" />
        </div>
      )}
      <div className="list">
        {!e && (
          <p className="note">Select a target in the Targets tab first.</p>
        )}
        {e && !fix && (
          <p className="note">
            {titleOf(e, fix)} has no live fix on the map, so no asset can be
            ranked against it.
          </p>
        )}
        {e &&
          fix &&
          list.map((r) => (
            <PairCard
              key={r.asset.id}
              r={r}
              e={e}
              fix={fix}
              onEdit={() => set({ mode: "create", draftAsset: r.asset.id })}
              onTask={() => quick(r.asset)}
            />
          ))}
        {e && fix && p.recs.airErr && <p className="note">{p.recs.airErr}.</p>}
        {e && fix && p.recs.satBusy && (
          <p className="note">Propagating sensor satellites over the target…</p>
        )}
        {e && fix && p.recs.satErr && <p className="note">{p.recs.satErr}.</p>}
        {e && fix && !busy && list.length === 0 && !p.recs.satBusy && (
          <p className="note">
            No airborne track within 4 degrees and no catalogue pass in 12
            hours.
          </p>
        )}
      </div>
    </>
  );
}

// ----------------------------------------------------------------- M46

export function createFrom(
  create: ReturnType<typeof useWatchTaskings.getState>["create"],
  e: TargetEntry,
  fix: Fix | undefined,
  a: Asset,
  form: {
    taskType: string;
    plan: string;
    planCount: number;
    startMs: number;
    totMs: number;
    security: string;
  } | null,
): Tasking {
  const now = Date.now();
  return create({
    targetId: e.entityId,
    targetLabel: titleOf(e, fix),
    asset: a,
    taskType: form?.taskType ?? a.taskType,
    security: form?.security ?? e.classification,
    plan: form?.plan ?? "",
    planCount: form?.planCount ?? 0,
    startMs: form?.startMs ?? now,
    totMs: form?.totMs ?? now + (a.tttS ?? 0) * 1000,
  });
}

const TASK_TYPES = [
  "VISUAL FOLLOW",
  "SAR PASS",
  "EO PASS",
  "MSI PASS",
  "RF COLLECT",
];

const toLocal = (ms: number): string => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

export interface Draft {
  taskType: string;
  plan: string;
  planCount: number;
  startMs: number;
  totMs: number | null;
  security: string;
}

function AssetCard({
  r,
  full,
  onPick,
}: {
  r: Ranked;
  full: boolean;
  onPick: () => void;
}): JSX.Element {
  const now = useNow();
  const a = r.asset;
  const [lv, sub, pred] = live(a, now);
  return (
    <div
      className={`ac${full ? " full" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={full}
      onClick={onPick}
      onKeyDown={(k) => {
        if (k.key === "Enter" || k.key === " ") {
          k.preventDefault();
          onPick();
        }
      }}
    >
      <span
        className="mv-bar"
        style={{ width: `${Math.round(190 * r.bar)}px` }}
      />
      <div className="top">
        <span className="mv-av">
          <BpIcon name={a.kind === "air" ? "airplane" : "satellite"} />
        </span>
        <span className="mv-n">{a.label}</span>
        <span className="mv-k">
          {a.kind === "air" ? "AIRCRAFT" : "SATELLITE"}
          <small>{a.chip}</small>
        </span>
        <span className="m">
          <BpIcon name="flow-linear" />
          {r.match}
        </span>
      </div>
      {full && (
        <>
          <div className="stats">
            {a.kind === "air" ? (
              <>
                <div>
                  <span className="l">Elevation</span>
                  <span className="v">
                    {a.altFt == null ? "N/A" : `${a.altFt} ft`}
                  </span>
                </div>
                <div>
                  <span className="l">Speed</span>
                  <span className="v">{a.kmh} km/h</span>
                </div>
                <div>
                  <span className="l">Heading</span>
                  <span className="v">
                    {a.trk == null
                      ? "N/A"
                      : String(Math.round(a.trk)).padStart(3, "0")}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div>
                  <span className="l">Sensor</span>
                  <span className="v">{a.sensor}</span>
                </div>
                <div>
                  <span className="l">Pass length</span>
                  <span className="v">{hms(a.passDurS ?? NaN)}</span>
                </div>
                <div>
                  <span className="l">Passes 12 h</span>
                  <span className="v">{a.passes}</span>
                </div>
              </>
            )}
          </div>
          <div className="stats blue">
            <div>
              <span className="l">Time to Target</span>
              <span className="v">{hms(a.tttS ?? NaN)}</span>
            </div>
            <div>
              <span className="l">Distance</span>
              <span className="v">
                {a.distNm === undefined ? "N/A" : `${a.distNm.toFixed(1)}nm`}
              </span>
            </div>
          </div>
          <div className="passes mono">
            <div className="r">
              <span>SENSOR PASSES</span>
              <span>AVAIL·ALLOC·SPENT</span>
            </div>
            <div
              className="r2"
              style={{ fontFamily: "Source Sans 3, sans-serif" }}
            >
              <span>
                {a.kind === "air" ? "ADS-B follow" : `${a.sensor} pass`}
              </span>
              <span>{a.kind === "air" ? 1 : a.passes} · 0 · 0</span>
            </div>
          </div>
        </>
      )}
      <div className="af">
        <span className={`lv${pred ? " pred" : ""}`} />
        <b>{lv}</b> <small>{sub}</small>
        <span className="src">
          <BpIcon name="database" />
          {a.source}
        </span>
      </div>
    </div>
  );
}

function CreateView(
  p: PanelProps & { draft: Draft; setDraft: (d: Draft) => void },
): JSX.Element {
  const target = useWs((s) => s.target);
  const draftAsset = useWs((s) => s.draftAsset);
  const set = useWs((s) => s.set);
  const create = useWatchTaskings((s) => s.create);
  const taskings = useWatchTaskings((s) => s.taskings);
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const [airOnly, setAirOnly] = useState(false);
  const [domain, setDomain] = useState<"all" | "air" | "sat">("all");
  const [near, setNear] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const e = p.entries.find((x) => x.entityId === target);
  const fix = target ? p.fixes.get(target) : undefined;
  const { draft, setDraft } = p;
  const picked = p.ranked.find((r) => r.asset.id === draftAsset) ?? p.ranked[0];
  // The chosen asset leads the list, expanded, as in the reference form.
  const ordered = picked
    ? [picked, ...p.ranked.filter((r) => r !== picked)]
    : p.ranked;
  const list = ordered.filter((r) => {
    const a = r.asset;
    if (airOnly && a.kind !== "air") return false;
    if (domain !== "all" && a.kind !== domain) return false;
    if (near && (a.distNm === undefined || a.distNm > 100)) return false;
    return q === "" || a.label.toLowerCase().includes(q.toLowerCase());
  });

  const submit = (): void => {
    if (!e || !picked) return;
    const a = picked.asset;
    const t = createFrom(create, e, fix, a, {
      taskType: draft.taskType || a.taskType,
      plan: draft.plan,
      planCount: draft.planCount,
      startMs: draft.startMs,
      totMs: draft.totMs ?? draft.startMs + (a.tttS ?? 0) * 1000,
      security: draft.security || e.classification,
    });
    set({ mode: "taskings", activeTask: t.id, toast: "Tasking created." });
  };

  if (!e)
    return (
      <>
        <div className="chd">
          <button
            type="button"
            onClick={() => set({ mode: "targets" })}
            title="Cancel"
          >
            <BpIcon name="cross" />
          </button>
          Creating new tasking
        </div>
        <p className="note">Select a target first.</p>
      </>
    );
  const nTasks = taskings.filter((t) => t.targetId === e.entityId).length;
  const tt = draft.taskType || picked?.asset.taskType || "VISUAL FOLLOW";

  return (
    <>
      <div className="chd">
        <button
          type="button"
          onClick={() => set({ mode: "rec" })}
          title="Cancel"
        >
          <BpIcon name="cross" />
        </button>
        Creating new tasking
        <button
          type="button"
          className="cfp"
          disabled={!picked}
          onClick={submit}
          title={picked ? "Create the tasking" : "No asset to task"}
        >
          Create from plan →
        </button>
      </div>
      <div className="list">
        <TargetCard e={e} fix={fix} sel nTasks={nTasks} />
        <div className="mv-band">
          Configure tasking <span className="bc">{tt}</span>
          <BpIcon name="chevron-down" />
        </div>
        <div className="fld">Task Type</div>
        <select
          className="sel1"
          value={tt}
          onChange={(ev) => setDraft({ ...draft, taskType: ev.target.value })}
          aria-label="Task Type"
        >
          {TASK_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <div className="fld">Task Security</div>
        <div className="sec1">
          <span>
            <BpIcon name="shield" />
            {short(draft.security || e.classification)}
          </span>
          <button
            type="button"
            title="Edit the marking"
            onClick={() => {
              const order = ["UNCLASSIFIED", "CUI"];
              const cur = draft.security || e.classification;
              const i = order.indexOf(cur);
              setDraft({ ...draft, security: order[(i + 1) % order.length]! });
            }}
          >
            <BpIcon name="edit" />
          </button>
        </div>
        <div className="fld">
          Collection plan ({draft.plan ? "Custom" : "None"})
          <button
            type="button"
            className="add"
            onClick={() =>
              setDraft({ ...draft, planCount: draft.planCount + 1 })
            }
          >
            <BpIcon name="add" />
            Collection plan
          </button>
        </div>
        <div className="plan">
          <label>
            <input
              value={draft.plan}
              onChange={(ev) => setDraft({ ...draft, plan: ev.target.value })}
              placeholder="Enter collection plan..."
              aria-label="Collection plan"
            />
            <span className="mv-cnt">
              {draft.planCount} {tt.split(" ")[0]} entries
            </span>
          </label>
          <span className="num">{draft.planCount}</span>
          <span className="stp">
            <button
              type="button"
              aria-label="More entries"
              onClick={() =>
                setDraft({ ...draft, planCount: draft.planCount + 1 })
              }
            >
              <BpIcon name="caret-up" />
            </button>
            <button
              type="button"
              aria-label="Fewer entries"
              onClick={() =>
                setDraft({
                  ...draft,
                  planCount: Math.max(0, draft.planCount - 1),
                })
              }
            >
              <BpIcon name="caret-down" />
            </button>
          </span>
          <button
            type="button"
            className="clr"
            aria-label="Clear the plan"
            onClick={() => setDraft({ ...draft, plan: "", planCount: 0 })}
          >
            <BpIcon name="cross" />
          </button>
        </div>
        <button type="button" className="more2" onClick={() => setMore(!more)}>
          {more ? "Hide additional options ⌃" : "Show additional options ⌄"}
        </button>
        {more && (
          <div className="opt">
            Start
            <input
              type="datetime-local"
              value={toLocal(draft.startMs)}
              onChange={(ev) => {
                const v = new Date(ev.target.value).getTime();
                if (isFinite(v)) setDraft({ ...draft, startMs: v });
              }}
            />
            Time on target
            <input
              type="datetime-local"
              value={toLocal(
                draft.totMs ?? draft.startMs + (picked?.asset.tttS ?? 0) * 1000,
              )}
              onChange={(ev) => {
                const v = new Date(ev.target.value).getTime();
                if (isFinite(v)) setDraft({ ...draft, totMs: v });
              }}
            />
          </div>
        )}
        <div className="mv-band">
          Choose assets <span className="bc">{p.ranked.length}</span>
          <BpIcon name="chevron-down" />
        </div>
        <div className="srch" style={{ padding: "6px 0 0" }}>
          <label style={{ width: 184 }}>
            <BpIcon name="search" />
            <input
              ref={searchRef}
              value={q}
              onChange={(ev) => setQ(ev.target.value)}
              placeholder="Search Assets or Sensors..."
              aria-label="Search assets"
            />
          </label>
          <button
            type="button"
            className={`fbtn${airOnly ? " on" : ""}`}
            aria-pressed={airOnly}
            onClick={() => setAirOnly(!airOnly)}
            title="Aircraft only"
          >
            <BpIcon name="filter-list" />
          </button>
          <button
            type="button"
            className="fbtn ai"
            onClick={() => set({ metrics: true })}
            title="Recommender metrics"
          >
            <BpIcon name="flow-linear" />
          </button>
        </div>
        <div className="mv-chips" style={{ padding: "0 3px" }}>
          <button
            type="button"
            className={domain === "air" ? "on" : ""}
            onClick={() => setDomain(domain === "air" ? "all" : "air")}
            title="Aircraft"
          >
            <BpIcon name="pin" />
            My Assets
          </button>
          <button
            type="button"
            className={domain === "sat" ? "on" : ""}
            onClick={() => setDomain(domain === "sat" ? "all" : "sat")}
            title="Satellites"
          >
            <BpIcon name="grid-view" />
            Domain
          </button>
          <button
            type="button"
            className={near ? "on" : ""}
            onClick={() => setNear(!near)}
            title="Within 100 nm"
          >
            <BpIcon name="polygon-filter" />
            Battlespace
          </button>
          <button
            type="button"
            className="end"
            onClick={() => p.recs.refresh()}
            title="Refresh assets"
          >
            <BpIcon name="more" />
          </button>
        </div>
        <div className="abtn">
          <button
            type="button"
            disabled
            title="No support channel is configured"
          >
            <BpIcon name="shield" />
            Request Support
          </button>
          <button type="button" onClick={() => searchRef.current?.focus()}>
            <BpIcon name="add" />
            Add Asset
          </button>
          <button type="button" disabled title="No asset packages are defined">
            Packages
          </button>
        </div>
        {list.map((r) => (
          <AssetCard
            key={r.asset.id}
            r={r}
            full={r.asset.id === picked?.asset.id}
            onPick={() => set({ draftAsset: r.asset.id })}
          />
        ))}
        {list.length === 0 && (
          <p className="note">
            {fix
              ? "No asset matches."
              : "The target has no live fix, so no asset can be ranked."}
          </p>
        )}
      </div>
    </>
  );
}

// ----------------------------------------------------------------- M50 M54

export function TaskingCard({
  t,
  on,
  onClick,
}: {
  t: Tasking;
  on: boolean;
  onClick: () => void;
}): JSX.Element {
  const now = useNow();
  const st =
    t.status === "approved"
      ? ["APPROVED", "ap", "take-action"]
      : t.status === "rejected"
        ? ["REJECTED", "rj", "cross"]
        : t.status === "executed"
          ? ["EXECUTED", "ex", "tick"]
          : ["PROPOSED", "", "random"];
  return (
    <div
      className={`tk${on ? " on" : ""}${t.status === "approved" ? " ok" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={on}
      onClick={onClick}
      onKeyDown={(k) => {
        if (k.key === "Enter" || k.key === " ") {
          k.preventDefault();
          onClick();
        }
      }}
    >
      <div className="h">
        <span className="ri">
          <BpIcon name="route" />
        </span>
        {t.taskType} → {t.targetLabel}
        <span className={`stt ${st[1]}`}>
          <BpIcon name={st[2]!} />
          {st[0]}
        </span>
      </div>
      <div className="tm">
        <div>
          <div className="l">Time on target</div>
          <div className="v">
            <b>
              {zDate(t.totMs)} {zClock(t.totMs)}
            </b>
            <span style={{ color: "#6d787b" }}>Z</span>
          </div>
        </div>
        <div>
          <div className="l">Created</div>
          <div className="v s">
            {rel(t.createdMs, now).replace(" from now", " ago")} by you
          </div>
        </div>
      </div>
      <div className="pr2">
        <div className="aa">
          <BpIcon name="flow-review" />1{" "}
          {t.asset.kind === "air" ? "Air" : "Space"} Asset
          <br />
          <span className="pill">
            <BpIcon name={t.asset.kind === "air" ? "airplane" : "satellite"} />
            {t.asset.label}
          </span>
        </div>
        <span className="mv-sep" />
        <div className="tt2">
          <span className="ring">
            <BpIcon name="target" />
          </span>
          {t.targetLabel}
          <br />
          <span className="pill">
            <BpIcon name="symbol-triangle-up" />
            {t.plan || `${t.planCount} plan entries`}
          </span>
        </div>
      </div>
      <div className="bt">
        Time on target:&nbsp;<b>{rel(t.totMs, now)}</b>
        <span className="cl">{short(t.security)}</span>
      </div>
    </div>
  );
}

function TaskingsView(p: PanelProps): JSX.Element {
  const set = useWs((s) => s.set);
  const active = useWs((s) => s.activeTask);
  const taskings = useWatchTaskings((s) => s.taskings);
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState(false);
  const [liveOnly, setLiveOnly] = useState(false);
  const rows = taskings.filter(
    (t) =>
      (!open || t.status === "proposed" || t.status === "approved") &&
      (!liveOnly || p.fixes.has(t.targetId)) &&
      (!mine || t.asset.kind === "air") &&
      (q === "" ||
        `${t.taskType} ${t.targetLabel} ${t.asset.label}`
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
  return (
    <>
      <Tabs mode="taskings" />
      <BoardSel apiNote={p.apiNote} onBoard={p.onBoard} />
      <div className="dyn">
        <button
          type="button"
          className="on"
          aria-pressed="true"
          onClick={() => setQ("")}
        >
          Dynamic <span className="c">{taskings.length}</span>
        </button>
        <button
          type="button"
          disabled
          title="Strike plans are not part of this workspace"
        >
          Strike Plans <span className="c">0</span>
        </button>
      </div>
      <Search
        value={q}
        set={setQ}
        ph="Search taskings..."
        filter={liveOnly}
        onFilter={() => setLiveOnly(!liveOnly)}
      />
      <div className="mv-chips">
        <button
          type="button"
          className={mine ? "on" : ""}
          onClick={() => setMine(!mine)}
          title="Aircraft taskings"
        >
          <BpIcon name="pin" />
          My taskings
        </button>
        <button
          type="button"
          className={open ? "on" : ""}
          onClick={() => setOpen(!open)}
          title="Proposed and approved only"
        >
          <BpIcon name="edit" />
          Tasking status
        </button>
        <button
          type="button"
          className={liveOnly ? "on" : ""}
          onClick={() => setLiveOnly(!liveOnly)}
          title="Targets with a live fix"
        >
          <BpIcon name="polygon-filter" />
          Battlespace
        </button>
      </div>
      <div className="list">
        {rows.map((t) => (
          <TaskingCard
            key={t.id}
            t={t}
            on={t.id === active}
            onClick={() => set({ activeTask: t.id, target: t.targetId })}
          />
        ))}
        {taskings.length === 0 && (
          <p className="note">
            No taskings yet. Pick a target, open the recommender and task an
            asset.
          </p>
        )}
      </div>
    </>
  );
}

export function LeftPanel(
  p: PanelProps & { draft: Draft; setDraft: (d: Draft) => void },
): JSX.Element {
  const mode = useWs((s) => s.mode);
  return (
    <aside className="lp" aria-label="Watch workspace">
      {mode === "targets" && <TargetsView {...p} />}
      {mode === "rec" && <RecView {...p} />}
      {mode === "create" && <CreateView {...p} />}
      {mode === "taskings" && <TaskingsView {...p} />}
    </aside>
  );
}

// ----------------------------------------------------------------- M44

function Gauge({ v }: { v: number }): JSX.Element {
  const r = 26;
  const cx = 35;
  const cy = 40;
  const th = (Math.min(100, v) / 100) * 180;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const ex = cx - r * Math.cos(rad(th));
  const ey = cy - r * Math.sin(rad(th));
  const lx = cx - (r + 8) * Math.cos(rad(th));
  const ly = cy - (r + 8) * Math.sin(rad(th));
  return (
    <svg className="mv-g" viewBox="0 0 70 42" aria-hidden="true">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <path
          key={f}
          d={`M${cx - r * f} ${cy} A${r * f} ${r * f} 0 0 1 ${cx + r * f} ${cy}`}
          fill="none"
          stroke="#6c6aa8"
          strokeWidth="0.7"
          strokeDasharray="1.4 2"
          opacity=".8"
        />
      ))}
      {Array.from({ length: 9 }, (_, i) => i * 22.5).map((a) => (
        <line
          key={a}
          x1={cx}
          y1={cy}
          x2={cx - r * Math.cos(rad(a))}
          y2={cy - r * Math.sin(rad(a))}
          stroke="#6c6aa8"
          strokeWidth="0.7"
          strokeDasharray="1.4 2"
          opacity=".7"
        />
      ))}
      {v > 0 && (
        <path
          d={`M${cx} ${cy} L${cx - r} ${cy} A${r} ${r} 0 0 1 ${ex} ${ey} Z`}
          fill="rgba(140,140,220,.42)"
          stroke="#a9a9e6"
          strokeWidth="1"
        />
      )}
      <text
        x={lx}
        y={ly + 3}
        textAnchor="middle"
        fontSize="10"
        fontWeight="700"
        fill="#b9b9ee"
        transform={`rotate(${th - 90} ${lx} ${ly})`}
      >
        {v}
      </text>
    </svg>
  );
}

export function MetricsDialog({
  left,
  top,
  onOptimize,
}: {
  left: number;
  top: number;
  onOptimize: () => void;
}): JSX.Element {
  const set = useWs((s) => s.set);
  const weights = useWatchTaskings((s) => s.weights);
  const setWeight = useWatchTaskings((s) => s.setWeight);
  const continuous = useWatchTaskings((s) => s.continuous);
  const setContinuous = useWatchTaskings((s) => s.setContinuous);
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") set({ metrics: false });
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [set]);
  return (
    <>
      <div className="scrim" onClick={() => set({ metrics: false })} />
      <div
        className="mdl"
        role="dialog"
        aria-label="Recommender metrics"
        style={{ left, top }}
      >
        <div className="mh2">
          <span>Choose which metrics AI should prioritize</span>
          <button
            type="button"
            title="Each asset scores 0 to 1 per metric; the weights blend those into one ranking"
            onClick={() => set({ metrics: false })}
          >
            <BpIcon name="info-sign" />
          </button>
          <button
            type="button"
            title="Close"
            onClick={() => set({ metrics: false })}
          >
            <BpIcon name="cog" />
          </button>
        </div>
        <div className="grid">
          {METRICS.map((m) => (
            <div className="tile" key={m}>
              <div className="nm">{METRIC_LABEL[m]}</div>
              <button
                type="button"
                className="rm"
                title="Remove: weight to 0"
                onClick={() => setWeight(m, 0)}
              >
                <BpIcon name="cross" />
              </button>
              <Gauge v={weights[m]} />
              <div className="stp2">
                <button
                  type="button"
                  aria-label={`Less ${METRIC_LABEL[m]}`}
                  onClick={() => setWeight(m, weights[m] - 10)}
                >
                  −
                </button>
                {weights[m]}
                <button
                  type="button"
                  aria-label={`More ${METRIC_LABEL[m]}`}
                  onClick={() => setWeight(m, weights[m] + 10)}
                >
                  +
                </button>
              </div>
              {METRIC_GAP[m] && <div className="gap">{METRIC_GAP[m]}</div>}
            </div>
          ))}
        </div>
        <div className="mf">
          <button
            type="button"
            title="Re-rank now with these weights"
            onClick={() => {
              onOptimize();
              set({ metrics: false });
            }}
          >
            <BpIcon name="build" />
            Optimize Recommender
          </button>
          <button
            type="button"
            className={continuous ? "" : "off"}
            aria-pressed={continuous}
            onClick={() => setContinuous(!continuous)}
            title="Re-rank on every ADS-B refresh"
          >
            <BpIcon name="automatic-updates" />
            Continuous Optimization {continuous ? "On" : "Off"}
          </button>
        </div>
      </div>
    </>
  );
}
