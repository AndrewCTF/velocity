import { useEffect, useMemo, useState } from "react";
import * as Cesium from "cesium";
import "./targetBoard.css";
import { BpIcon } from "../../shell/BpIcon.js";
import { useAlerts, useSelection } from "../../state/stores.js";
import { useAppView } from "../../state/appView.js";
import { flyToPosition } from "../../globe/camera.js";
import { apiFetch } from "../../transport/http.js";
import { MAP_LAYER_FOLDERS } from "../../normal/layerCatalog.js";
import {
  useTargetBoard,
  TARGET_STAGES,
  isLocked,
  type TargetStage,
  type TargetEntry,
} from "../../state/targetBoard.js";
import { TargetDetail } from "../../target-kanban/TargetDetail.js";

// TargetBoard: the reference target-board page, element for element
// (targetBoard.css is the copy's CSS), fed by the target board store. The
// copy's seven columns are the seven F2T2EA stages; every card is a board
// entry. Nothing on this page is a literal from the copy.

const STAGE_LABEL: Record<TargetStage, string> = {
  confirm: "Confirm",
  attach_intel: "Attach intel",
  approvals: "Approvals",
  weaponeer: "Weaponeer",
  execute: "Execute",
  assess: "Assess",
  complete: "Complete",
};
// The copy's column marker colours, in column order.
const STAGE_DOT = [
  "#f5c84c",
  "#4c90f0",
  "#738091",
  "#cd4246",
  "#32a467",
  "#d9a3f5",
  "#c5cbd3",
];

type Kind = "aircraft" | "vessel" | "other";
function kindOf(e: TargetEntry): Kind {
  if (e.entityId.startsWith("aircraft:") || e.kind === "aircraft")
    return "aircraft";
  if (e.entityId.startsWith("vessel:") || e.kind === "vessel") return "vessel";
  return "other";
}

const LAYER_LABEL = new Map<string, string>();
for (const f of MAP_LAYER_FOLDERS)
  for (const r of f.rows)
    for (const id of r.layerIds) LAYER_LABEL.set(id, r.label);

/** The live entity behind a card, and the layer holding it. */
export function boardLookup(
  viewer: Cesium.Viewer | null | undefined,
  id: string,
): { ent: Cesium.Entity; layer: string | null } | null {
  if (!viewer || viewer.isDestroyed()) return null;
  for (let i = 0; i < viewer.dataSources.length; i++) {
    const ds = viewer.dataSources.get(i);
    const ent = ds.entities.getById(id);
    if (ent) return { ent, layer: LAYER_LABEL.get(ds.name) ?? ds.name };
  }
  const ent = viewer.entities.getById(id);
  return ent ? { ent, layer: null } : null;
}

// One stage forward or back, as the backend's _MAX_STAGE_STEP gate requires.
const legalStep = (a: TargetStage, b: TargetStage): boolean =>
  Math.abs(TARGET_STAGES.indexOf(a) - TARGET_STAGES.indexOf(b)) <= 1;

type Pop = "add" | "filter" | "sort" | null;
type Filter = "all" | Kind | "locked";

export function TargetBoard({
  viewer,
  onTaskings,
}: {
  viewer?: Cesium.Viewer | null;
  /** Opens the watch workspace (map, recommender, taskings) for the board. */
  onTaskings?: () => void;
}): JSX.Element {
  const entries = useTargetBoard((s) => s.entries);
  const add = useTargetBoard((s) => s.add);
  const move = useTargetBoard((s) => s.move);
  const load = useTargetBoard((s) => s.load);
  const selectedId = useSelection((s) => s.selectedEntityId);
  const select = useSelection((s) => s.select);
  const alertCount = useAlerts((s) => s.alerts.length);
  const setApp = useAppView((s) => s.setApp);

  // The store's load() swallows the response code, so read it here once:
  // a keyless deployment answers 401 and the board is this device's only.
  const [api, setApi] = useState<number | "down" | null>(null);
  useEffect(() => {
    let live = true;
    apiFetch("/api/targets/board")
      .then((r) => {
        if (!live) return;
        setApi(r.status);
        if (r.ok) void load();
      })
      .catch(() => live && setApi("down"));
    return () => {
      live = false;
    };
  }, [load]);

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<"priority" | "name">("priority");
  const [pop, setPop] = useState<Pop>(null);
  const [shut, setShut] = useState<Partial<Record<TargetStage, boolean>>>({});
  const [drag, setDrag] = useState<TargetEntry | null>(null);
  const [over, setOver] = useState<TargetStage | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!pop) return;
    const close = (): void => setPop(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [pop]);

  // Labels are re-read from the live picture on every render of the board.
  const cards = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries
      .map((e) => {
        const hitE = boardLookup(viewer, e.entityId);
        const c = e.entityId.indexOf(":");
        const short = c >= 0 ? e.entityId.slice(c + 1) : e.entityId;
        return {
          e,
          short,
          title: hitE?.ent.name || e.label || short,
          layer: hitE?.layer ?? null,
          live: hitE !== null,
          kind: kindOf(e),
          locked: isLocked(e.stage, e.requirements),
        };
      })
      .filter(
        (c) =>
          (needle === "" ||
            `${c.short} ${c.title} ${c.layer ?? ""}`
              .toLowerCase()
              .includes(needle)) &&
          (filter === "all" ||
            (filter === "locked" ? c.locked : c.kind === filter)),
      )
      .sort((a, b) =>
        sort === "priority"
          ? a.e.priority - b.e.priority || a.title.localeCompare(b.title)
          : a.title.localeCompare(b.title),
      );
  }, [entries, viewer, q, filter, sort]);

  const lockedCount = cards.filter((c) => c.locked).length;
  const onBoard = selectedId
    ? entries.some((e) => e.entityId === selectedId)
    : false;

  const addSelected = (stage?: TargetStage): void => {
    if (!selectedId) return;
    const hitE = boardLookup(viewer, selectedId);
    const kind = selectedId.startsWith("aircraft:")
      ? "aircraft"
      : selectedId.startsWith("vessel:")
        ? "vessel"
        : undefined;
    add(selectedId, {
      ...(hitE?.ent.name ? { label: hitE.ent.name } : {}),
      ...(kind ? { kind } : {}),
      ...(stage ? { stage } : {}),
    });
    setPop(null);
  };

  const open = (e: TargetEntry): void => {
    select(e.entityId);
    const hitE = boardLookup(viewer, e.entityId);
    const cart = hitE?.ent.position?.getValue(
      viewer?.clock.currentTime ?? Cesium.JulianDate.now(),
    );
    if (!viewer || !cart) return;
    const g = Cesium.Cartographic.fromCartesian(cart);
    flyToPosition(
      viewer,
      Cesium.Math.toDegrees(g.longitude),
      Cesium.Math.toDegrees(g.latitude),
      350_000,
      0.8,
    );
  };

  const drop = (stage: TargetStage): void => {
    const d = drag;
    setDrag(null);
    setOver(null);
    if (!d || d.stage === stage) return;
    if (!legalStep(d.stage, stage)) {
      setNote(
        `${STAGE_LABEL[d.stage]} to ${STAGE_LABEL[stage]} is blocked. Cards move one stage at a time.`,
      );
      return;
    }
    if (!move(d.entityId, stage))
      setNote(
        `${STAGE_LABEL[stage]} is blocked until the confirmation checklist is complete. Open the card to finish it.`,
      );
    else setNote(null);
  };

  const apiNote =
    api === null || api === 200
      ? null
      : api === "down"
        ? "Board API unreachable. Entries stay on this device."
        : `Board API unavailable (HTTP ${api}). Entries stay on this device.`;

  const FILTERS: ReadonlyArray<[Filter, string]> = [
    ["all", "All cards"],
    ["aircraft", "Aircraft"],
    ["vessel", "Vessels"],
    ["other", "Other objects"],
    ["locked", "Checklist incomplete"],
  ];

  return (
    <div className="target-board" aria-label="Target board">
      <div className="tools">
        <span className="add">
          <button
            type="button"
            disabled={!selectedId || onBoard}
            title={
              !selectedId
                ? "Select an object on the map to add it"
                : onBoard
                  ? "The selected object is already on the board"
                  : "Add the selected object to the board"
            }
            onClick={() => addSelected()}
          >
            <BpIcon name="add" className="i" />
            Add
          </button>
          <button
            type="button"
            disabled={!selectedId || onBoard}
            aria-label="Add to a stage"
            aria-expanded={pop === "add"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setPop(pop === "add" ? null : "add")}
          >
            <BpIcon name="caret-down" className="i" style={{ width: 10 }} />
          </button>
        </span>
        {pop === "add" && (
          <div
            className="pop"
            role="menu"
            style={{ left: 12 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {TARGET_STAGES.map((s) => (
              <button
                key={s}
                type="button"
                role="menuitem"
                onClick={() => addSelected(s)}
              >
                Add to {STAGE_LABEL[s]}
              </button>
            ))}
          </div>
        )}
        <label className="sf">
          <BpIcon name="search" className="i" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            aria-label="Search the board"
          />
          <button
            type="button"
            aria-label="Clear the search"
            disabled={q === ""}
            onClick={() => setQ("")}
          >
            <BpIcon
              name="cross"
              className="i"
              style={{ marginLeft: "auto", width: 12 }}
            />
          </button>
        </label>
        <button
          type="button"
          className="t"
          aria-expanded={pop === "filter"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setPop(pop === "filter" ? null : "filter")}
          style={filter === "all" ? undefined : { color: "var(--t0)" }}
        >
          <BpIcon name="filter" className="i" />
          {filter === "all"
            ? "Filter"
            : FILTERS.find(([f]) => f === filter)?.[1]}
        </button>
        <button
          type="button"
          className="t"
          aria-expanded={pop === "sort"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setPop(pop === "sort" ? null : "sort")}
        >
          <BpIcon name="sort" className="i" />
          Sort by {sort === "priority" ? "priority" : "name"}
          <BpIcon name="caret-down" className="i" style={{ width: 10 }} />
        </button>
        {(pop === "filter" || pop === "sort") && (
          <div
            className="pop"
            role="menu"
            style={{ left: pop === "filter" ? 330 : 420 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {pop === "filter"
              ? FILTERS.map(([f, label]) => (
                  <button
                    key={f}
                    type="button"
                    role="menuitemradio"
                    aria-checked={filter === f}
                    onClick={() => {
                      setFilter(f);
                      setPop(null);
                    }}
                  >
                    {label}
                  </button>
                ))
              : (
                  [
                    ["priority", "Priority"],
                    ["name", "Name"],
                  ] as const
                ).map(([s, label]) => (
                  <button
                    key={s}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sort === s}
                    onClick={() => {
                      setSort(s);
                      setPop(null);
                    }}
                  >
                    {label}
                  </button>
                ))}
          </div>
        )}
        <button
          type="button"
          className="t"
          disabled
          title="Grouped by stage. The board stores no other grouping."
        >
          <BpIcon name="th" className="i" />
          Group by stage
        </button>
        <span className="rt">
          <button
            type="button"
            className="cnt"
            title="Alerts in the live ticker"
            aria-label={`Alerts, ${alertCount}`}
            onClick={() => setApp("map")}
          >
            <BpIcon name="notifications" className="i" />
            {alertCount}
          </button>
          <button
            type="button"
            className="cnt"
            title="Cards whose confirmation checklist is incomplete. Click to show only those."
            aria-label={`Checklist incomplete, ${lockedCount}`}
            onClick={() => setFilter(filter === "locked" ? "all" : "locked")}
          >
            <BpIcon name="warning-sign" className="i" />
            {lockedCount > 0 ? <b>{lockedCount}</b> : lockedCount}
          </button>
          {onTaskings && (
            <button
              type="button"
              className="t"
              title="Map the board, recommend assets and task them"
              onClick={onTaskings}
            >
              <BpIcon name="flow-linear" className="i" />
              Taskings
            </button>
          )}
          <button
            type="button"
            className="t"
            title="Back to the map"
            onClick={() => setApp("map")}
          >
            <BpIcon name="map" className="i" />
            Map
          </button>
        </span>
      </div>

      {note && (
        <div className="note" role="status" onClick={() => setNote(null)}>
          {note}
        </div>
      )}

      <main className="cols">
        {TARGET_STAGES.map((stage, i) => {
          const col = cards.filter((c) => c.e.stage === stage);
          const isShut = shut[stage] ?? false;
          const barred =
            drag !== null &&
            stage !== drag.stage &&
            !legalStep(drag.stage, stage);
          return (
            <section
              key={stage}
              className={`col${over === stage && !barred ? " over" : ""}${barred ? " bar" : ""}${isShut ? " shut" : ""}`}
              aria-label={STAGE_LABEL[stage]}
              onDragOver={(e) => {
                if (!drag || barred) return;
                e.preventDefault();
                setOver(stage);
              }}
              onDragLeave={() => setOver((o) => (o === stage ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                drop(stage);
              }}
            >
              <div className="ch">
                <span className="d" style={{ background: STAGE_DOT[i] }} />
                {STAGE_LABEL[stage]}
                <span className="n">{col.length}</span>
                <button
                  type="button"
                  aria-label={
                    isShut
                      ? `Expand ${STAGE_LABEL[stage]}`
                      : `Collapse ${STAGE_LABEL[stage]}`
                  }
                  aria-expanded={!isShut}
                  onClick={() => setShut((s) => ({ ...s, [stage]: !isShut }))}
                >
                  <BpIcon
                    name={isShut ? "chevron-down" : "chevron-left"}
                    className="i cl"
                  />
                </button>
              </div>
              {!isShut &&
                col.map((c) => (
                  <div
                    key={c.e.id}
                    role="button"
                    tabIndex={0}
                    draggable
                    className={`card ${stage === "complete" ? "plain" : c.e.priority <= 2 ? "amber" : "purple"}${c.e.entityId === selectedId ? " on" : ""}`}
                    title={c.e.entityId}
                    onClick={() => open(c.e)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(c.e);
                      }
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", c.e.entityId);
                      setDrag(c.e);
                      setNote(null);
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setOver(null);
                    }}
                  >
                    <div className="exp">
                      {c.live ? null : (
                        <>
                          Live fix is <b>not on the map</b>
                        </>
                      )}
                    </div>
                    <div className="row">
                      <span
                        className={`sym ${c.kind === "aircraft" ? "dia" : "c"}`}
                        style={
                          {
                            "--sc":
                              c.kind === "aircraft"
                                ? "#f59e0b"
                                : c.kind === "vessel"
                                  ? "#14b8a6"
                                  : "#e5e8eb",
                          } as React.CSSProperties
                        }
                      >
                        <BpIcon
                          name={
                            c.kind === "aircraft"
                              ? "airplane"
                              : c.kind === "vessel"
                                ? "ship"
                                : "document"
                          }
                          className="i"
                        />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div className="ti">
                          <span className="id">{c.short} /</span>
                          {c.title}
                        </div>
                        <div className="lk">
                          <BpIcon name="link" className="i" />
                          {c.layer ??
                            (c.kind === "other"
                              ? "Object"
                              : c.kind === "aircraft"
                                ? "Aircraft"
                                : "Vessel")}
                        </div>
                        <div className="ed">Priority {c.e.priority}</div>
                      </div>
                    </div>
                    <span className="ms">{c.e.classification}</span>
                    {c.locked && (
                      <span
                        className="wn"
                        title="Confirmation checklist incomplete: gates the next stage"
                      >
                        <BpIcon name="warning-sign" className="i" />
                      </span>
                    )}
                  </div>
                ))}
            </section>
          );
        })}
      </main>

      {entries.length === 0 && (
        <p className="empty" role="status">
          {apiNote ? `${apiNote} ` : ""}No targets on the board yet. Select an
          object on the map and press Add.
        </p>
      )}

      {entries.length > 0 && apiNote && (
        <div className="note" style={{ top: "auto", bottom: 8 }}>
          {apiNote}
        </div>
      )}

      {onBoard && (
        <div className="detail">
          <TargetDetail viewer={viewer ?? null} />
        </div>
      )}
    </div>
  );
}
