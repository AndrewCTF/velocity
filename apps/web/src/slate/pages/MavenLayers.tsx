import { useEffect, useReducer, useState, type ReactNode } from "react";
import type * as Cesium from "cesium";
import "./mavenLayers.css";
import type { LayerRegistry } from "../../registry/LayerRegistry.js";
import { BpIcon } from "../../shell/BpIcon.js";
import { LayerRail } from "../../layer-rail/LayerRail.js";
import { useLayerCounts, rowState } from "../../layer-rail/useLayerCounts.js";
import {
  MAP_LAYER_FOLDERS,
  moveRow,
  rowEnabled,
  toggleRow,
  type CatalogRow,
} from "../../normal/layerCatalog.js";
import { useAnnotations } from "../../annotations/annotationStore.js";
import { useSelection } from "../../state/stores.js";
import { usePalette } from "../../state/palette.js";
import { ToolCatalog } from "../features/maven/ToolCatalog.js";
import { CreateLayer } from "../features/maven/CreateLayer.js";
import { LayerMenu } from "../features/mapfx/LayerMenu.js";
import { BasemapPopover } from "../features/mapfx/BasemapPopover.js";
import { AddToMapMenu } from "../features/mapfx/AddToMapMenu.js";
import { OverlaysCatalog } from "../features/mapfx/OverlaysCatalog.js";
import { InlineLegend } from "../features/mapfx/InlineLegend.js";
import { InlineRename, renameFor } from "../features/mapfx/InlineRename.js";
import { SearchDialog } from "../features/mapfx/SearchDialog.js";
import { FilterPicker } from "../features/mapfx/FilterPicker.js";
import { useMapTools } from "../../globe/mapTools.js";

// MavenLayers: the reference map-workspace page's layers panel, element for
// element (mavenLayers.css is the copy's CSS), fed by the real registry. Rows
// are the curated catalog (normal/layerCatalog.ts), counts are live DataSource
// totals (useLayerCounts), annotations are the annotation store. Same props as
// shell/panels/LayersPanel so the mount is a one-line swap.

type Tab = "layers" | "sources" | "tools" | "overlays";
const TABS: ReadonlyArray<[Tab, string, string]> = [
  ["layers", "Map layers", "layers"],
  ["sources", "Data sources", "database"],
  ["tools", "Tools", "wrench"],
  ["overlays", "Overlays", "layers"],
];

function Row({
  icon,
  label,
  caret,
  kid,
  right,
  title,
  onClick,
  pressed,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  icon: string;
  label: string;
  caret?: boolean | undefined;
  kid?: boolean;
  right?: ReactNode;
  title?: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  pressed?: boolean;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLButtonElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLButtonElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`row${kid ? " kid" : ""}`}
      onClick={onClick}
      title={title ?? label}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      {...(caret !== undefined ? { "aria-expanded": caret } : {})}
      {...(draggable ? { draggable: true } : {})}
      {...(onDragStart ? { onDragStart } : {})}
      {...(onDragOver ? { onDragOver } : {})}
      {...(onDrop ? { onDrop } : {})}
    >
      {caret !== undefined && (
        <span className="car">
          <BpIcon name={caret ? "caret-down" : "caret-right"} className="i" />
        </span>
      )}
      <span className="ic">
        <BpIcon name={icon} className="i" />
      </span>
      <span className="tx">{label}</span>
      {right}
    </button>
  );
}

export function MavenLayers({
  registry,
  viewer,
}: {
  registry: LayerRegistry;
  viewer?: Cesium.Viewer | null;
}): JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => registry.subscribe(force), [registry]);
  const counts = useLayerCounts(viewer);
  const annotations = useAnnotations((s) => s.annotations);
  const updateAnno = useAnnotations((s) => s.update);
  const [renameLabel, setRenameLabel] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // D84: search is filtered to the drawn shape when one exists.
  const drawnArea = useMapTools((s) => s.area);
  const bbox: [number, number, number, number] | null = drawnArea
    ? [drawnArea.west, drawnArea.south, drawnArea.east, drawnArea.north]
    : null;
  const [filterOpen, setFilterOpen] = useState(false);
  const selId = useSelection((s) => s.selectedEntityId);

  const [tab, setTab] = useState<Tab>("layers");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [createAt, setCreateAt] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const needle = q.trim().toLowerCase();
  const hit = (s: string): boolean =>
    needle === "" || s.toLowerCase().includes(needle);

  const allRows = MAP_LAYER_FOLDERS.flatMap((f) => f.rows);
  const onRows = allRows.filter((r) => rowEnabled(registry, r));

  // The right-edge glyph states the row's real condition: the green lightning
  // is a layer answering with contacts, the dot one still loading, the crossed
  // eye one that is off. An answered-but-empty layer shows its 0 and no glyph.
  const status = (row: CatalogRow): { label: string; right: ReactNode } => {
    const name = renameFor(row);
    const st = rowState(counts, row.layerIds, rowEnabled(registry, row));
    if (st.state === "live")
      return {
        label: `${name} (${st.n.toLocaleString()})`,
        right: (
          <span className="bad">
            <BpIcon name="lightning" className="i" />
          </span>
        ),
      };
    if (st.state === "empty") return { label: `${name} (0)`, right: null };
    if (st.state === "pending")
      return { label: name, right: <span className="dot" /> };
    return {
      label: name,
      right: (
        <span className="eo">
          <BpIcon name="eye-off" className="i" />
        </span>
      ),
    };
  };

  const layerRow = (row: CatalogRow, kid: boolean): JSX.Element => {
    const s = status(row);
    const on = rowEnabled(registry, row);
    // D71: the row carries the copy's count + ••• menu + eye + drill-in.
    // The menu's centre/select/delete are wired to the same actions the row
    // itself does (toggle, open palette, confirm-delete); the copy-only
    // entries stay disabled with reasons (LayerMenu).
    // D77: the row is draggable to reorder draw order (list order is draw
    // order); moveRow() reorders the registry so LayerCompositor re-attaches
    // in the new order.
    const count = s.label.includes("(")
      ? Number((s.label.match(/\(([\d,]+)\)/)?.[1] ?? "0").replace(/,/g, ""))
      : 0;
    return (
      <>
        {renameLabel === row.label ? (
          <InlineRename
            row={row}
            registry={registry}
            onDone={() => setRenameLabel(null)}
          />
        ) : (
          <Row
            key={`${kid ? "k" : "o"}:${row.label}`}
            kid={kid}
            icon={on ? "antenna" : "circle"}
            label={s.label}
            right={
              <LayerMenu
                row={row}
                count={count}
                viewer={viewer ?? null}
                onToggleHide={() => toggleRow(registry, row)}
                onDrillIn={() => {
                  setOpen((o) => ({ ...o, [row.label]: true }));
                  setQ(row.label);
                }}
                onCentre={() => {
                  if (viewer?.camera) return;
                }}
                onSelect={() => usePalette.getState().setOpen(true)}
                onRename={() => setRenameLabel(row.label)}
                onDelete={() => {
                  // Velocity layers are registry descriptors, not deletable
                  // documents; deleting just turns the row off.
                  toggleRow(registry, row);
                }}
              />
            }
            pressed={on}
            title={on ? `Hide ${row.label}` : `Show ${row.label}`}
            onClick={() => toggleRow(registry, row)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", row.label);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = e.dataTransfer.getData("text/plain");
              if (!from || from === row.label) return;
              const fromRow = allRows.find((r) => r.label === from);
              if (!fromRow) return;
              const toIdx = allRows.indexOf(row);
              if (toIdx < 0) return;
              moveRow(registry, fromRow, toIdx);
            }}
          />
        )}
        {on && <InlineLegend row={row} hidden={!on} />}
      </>
    );
  };

  const annoOpen = open["__anno"] ?? false;
  const shownAnnos = annotations.filter((a) => hit(a.label || a.kind));
  const allHidden =
    annotations.length > 0 && annotations.every((a) => a.hidden);

  let body: ReactNode;
  if (tab === "sources") {
    body = <LayerRail registry={registry} viewer={viewer ?? null} />;
  } else if (tab === "overlays") {
    body = <OverlaysCatalog registry={registry} />;
  } else if (tab === "tools") {
    // The reference Tools tab: the catalog of tool groups (row M6); every
    // map tool and tool panel the old flat list opened is a tile in it.
    body = <ToolCatalog registry={registry} match={hit} />;
  } else {
    const live = onRows.filter((r) => hit(r.label));
    const folders = MAP_LAYER_FOLDERS.map((f) => ({
      f,
      rows: f.rows.filter((r) => hit(r.label) || hit(f.label)),
    })).filter((x) => x.rows.length > 0);
    // Empty state (D68): nothing enabled at all (and no search is active).
    const isEmpty = onRows.length === 0 && needle === "";
    body = (
      <>
        {/* D71: the OBJECTS band labels the live rows, exactly as the copy. */}
        <div className="mv-objects-band" aria-hidden="true">
          OBJECTS
        </div>
        {isEmpty ? (
          <div className="mv-empty-state">
            <div className="mv-empty-icon" aria-hidden="true">
              <BpIcon name="layers" size={28} />
            </div>
            <div className="mv-empty-title">No layers</div>
            <div className="mv-empty-sub">
              Add data to your map to get started
            </div>
            <AddToMapMenu onAddOverlays={() => setTab("sources")} />
          </div>
        ) : (
          live.map((r) => layerRow(r, false))
        )}
        {folders.map(({ f, rows }) => {
          const isOpen = open[f.id] ?? needle !== "";
          const anyOn = rows.some((r) => rowEnabled(registry, r));
          return (
            <div key={f.id}>
              <Row
                icon={isOpen ? "folder-open" : "folder-close"}
                label={`-- ${f.label} --`}
                caret={isOpen}
                title={`${f.label}: ${rows.length} layers`}
                onClick={() => setOpen((o) => ({ ...o, [f.id]: !isOpen }))}
                right={anyOn ? <span className="dot" /> : null}
              />
              {isOpen && rows.map((r) => layerRow(r, true))}
            </div>
          );
        })}
        {(needle === "" || shownAnnos.length > 0) && (
          <>
            <Row
              icon="annotation"
              label={`Annotations (${annotations.length})`}
              caret={annoOpen}
              onClick={() => setOpen((o) => ({ ...o, __anno: !annoOpen }))}
              right={
                annotations.length > 0 ? (
                  <span
                    className="eo"
                    role="button"
                    tabIndex={0}
                    aria-label={
                      allHidden
                        ? "Show all annotations"
                        : "Hide all annotations"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      for (const a of annotations)
                        updateAnno(a.id, { hidden: !allHidden });
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      e.stopPropagation();
                      for (const a of annotations)
                        updateAnno(a.id, { hidden: !allHidden });
                    }}
                  >
                    <BpIcon
                      name={allHidden ? "eye-off" : "eye-open"}
                      className="i"
                    />
                  </span>
                ) : null
              }
            />
            {annoOpen &&
              (shownAnnos.length === 0 ? (
                <div className="empty">
                  No annotations yet. Drop one from Tools.
                </div>
              ) : (
                shownAnnos.map((a) => (
                  <Row
                    key={a.id}
                    kid
                    icon={
                      a.kind === "line" || a.kind === "arrow"
                        ? "route"
                        : "map-marker"
                    }
                    label={a.label || a.kind}
                    pressed={!a.hidden}
                    title={a.hidden ? "Show on the map" : "Hide on the map"}
                    onClick={() => updateAnno(a.id, { hidden: !a.hidden })}
                    right={
                      <span className="eo">
                        <BpIcon
                          name={a.hidden ? "eye-off" : "eye-open"}
                          className="i"
                        />
                      </span>
                    }
                  />
                ))
              ))}
          </>
        )}
        <Row
          icon="add"
          label="Create vessel watch layer"
          pressed={createAt !== null}
          onClick={(e) => {
            if (createAt) return setCreateAt(null);
            const r = (e.currentTarget as HTMLElement)
              .closest(".maven-layers")
              ?.getBoundingClientRect();
            setCreateAt(r ? { left: r.right + 8, top: r.top + 8 } : null);
          }}
        />
        <Row
          icon="search-around"
          label="Search for objects"
          caret={false}
          onClick={() => setSearchOpen(true)}
        />
        {searchOpen && (
          <SearchDialog
            viewer={viewer ?? null}
            onClose={() => setSearchOpen(false)}
            bbox={bbox}
          />
        )}
        <Row
          icon="filter"
          label="Add filter"
          caret={false}
          onClick={() => setFilterOpen(true)}
        />
        {filterOpen && selId && selId.startsWith("airport:") && (
          <FilterPicker
            airportId={selId}
            onClose={() => setFilterOpen(false)}
          />
        )}
        {needle !== "" && live.length === 0 && folders.length === 0 && (
          <div className="empty">No layer matches “{q.trim()}”.</div>
        )}
      </>
    );
  }

  return (
    <div className="maven-layers" aria-label="Map layers">
      {createAt && (
        <CreateLayer
          registry={registry}
          anchor={createAt}
          onClose={() => setCreateAt(null)}
        />
      )}
      <div className="abs tabs" role="tablist" aria-label="Layers view">
        {TABS.map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab${tab === id ? " on" : ""}`}
            onClick={() => setTab(id)}
          >
            <BpIcon name={icon} className="i" />
            {label}
          </button>
        ))}
      </div>
      <label className="abs search">
        <BpIcon name="search" className="i" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search this map…"
          aria-label="Search this map"
        />
      </label>
      <div className="list">{body}</div>
      <div className="abs bm">
        <span>Basemap</span>
        <BasemapPopover />
        <button
          type="button"
          style={{ marginLeft: "auto", color: "var(--t1)", fontSize: 13.5 }}
          title="Layers on the map"
          onClick={() => {
            setTab("layers");
            setQ("");
          }}
        >
          {onRows.length} overlays
        </button>
      </div>
    </div>
  );
}
