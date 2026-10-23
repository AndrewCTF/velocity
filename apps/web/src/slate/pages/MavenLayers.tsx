import { useEffect, useReducer, useState, type ReactNode } from "react";
import type * as Cesium from "cesium";
import "./mavenLayers.css";
import type { LayerRegistry } from "../../registry/LayerRegistry.js";
import { BpIcon } from "../../shell/BpIcon.js";
import { LayerRail } from "../../layer-rail/LayerRail.js";
import { useLayerCounts, rowState } from "../../layer-rail/useLayerCounts.js";
import {
  MAP_LAYER_FOLDERS,
  rowEnabled,
  toggleRow,
  type CatalogRow,
} from "../../normal/layerCatalog.js";
import { useAnnotations } from "../../annotations/annotationStore.js";
import { useImagery } from "../../state/stores.js";
import { usePalette } from "../../state/palette.js";
import { BASEMAP_OPTIONS } from "../../globe/basemaps.js";
import { ToolCatalog } from "../features/maven/ToolCatalog.js";
import { CreateLayer } from "../features/maven/CreateLayer.js";

// MavenLayers: the reference map-workspace page's layers panel, element for
// element (mavenLayers.css is the copy's CSS), fed by the real registry. Rows
// are the curated catalog (normal/layerCatalog.ts), counts are live DataSource
// totals (useLayerCounts), annotations are the annotation store. Same props as
// shell/panels/LayersPanel so the mount is a one-line swap.

type Tab = "layers" | "sources" | "tools";
const TABS: ReadonlyArray<[Tab, string, string, number, number]> = [
  // id, label, icon, copy left, underline width
  ["layers", "Map layers", "layers", 20, 104],
  ["sources", "Data sources", "database", 136, 112],
  ["tools", "Tools", "wrench", 260, 62],
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
}: {
  icon: string;
  label: string;
  caret?: boolean | undefined;
  kid?: boolean;
  right?: ReactNode;
  title?: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  pressed?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`row${kid ? " kid" : ""}`}
      onClick={onClick}
      title={title ?? label}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      {...(caret !== undefined ? { "aria-expanded": caret } : {})}
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
  const basemap = useImagery((s) => s.mode);
  const setBasemap = useImagery((s) => s.setMode);

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
    const st = rowState(counts, row.layerIds, rowEnabled(registry, row));
    if (st.state === "live")
      return {
        label: `${row.label} (${st.n.toLocaleString()})`,
        right: (
          <span className="bad">
            <BpIcon name="lightning" className="i" />
          </span>
        ),
      };
    if (st.state === "empty") return { label: `${row.label} (0)`, right: null };
    if (st.state === "pending")
      return { label: row.label, right: <span className="dot" /> };
    return {
      label: row.label,
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
    return (
      <Row
        key={`${kid ? "k" : "o"}:${row.label}`}
        kid={kid}
        icon={on ? "antenna" : "circle"}
        label={s.label}
        right={s.right}
        pressed={on}
        title={on ? `Hide ${row.label}` : `Show ${row.label}`}
        onClick={() => toggleRow(registry, row)}
      />
    );
  };

  const annoOpen = open["__anno"] ?? false;
  const shownAnnos = annotations.filter((a) => hit(a.label || a.kind));
  const allHidden =
    annotations.length > 0 && annotations.every((a) => a.hidden);

  let body: ReactNode;
  if (tab === "sources") {
    body = <LayerRail registry={registry} viewer={viewer ?? null} />;
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
    body = (
      <>
        {live.map((r) => layerRow(r, false))}
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
          onClick={() => usePalette.getState().setOpen(true)}
        />
        {needle !== "" && live.length === 0 && folders.length === 0 && (
          <div className="empty">No layer matches “{q.trim()}”.</div>
        )}
      </>
    );
  }

  const usable = BASEMAP_OPTIONS.filter((b) => !b.unavailable?.());
  const bmIdx = usable.findIndex((b) => b.value === basemap);
  const bmLabel =
    BASEMAP_OPTIONS.find((b) => b.value === basemap)?.label ?? basemap;
  const nextBm = usable[(bmIdx + 1) % Math.max(1, usable.length)];

  const tabIdx = TABS.findIndex(([id]) => id === tab);
  const [, , , ulLeft, ulW] = TABS[tabIdx] ?? TABS[0]!;

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
        {TABS.map(([id, label, icon, left]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab${tab === id ? " on" : ""}`}
            style={{ left }}
            onClick={() => setTab(id)}
          >
            <BpIcon name={icon} className="i" />
            {label}
          </button>
        ))}
        <span className="uline" style={{ left: ulLeft - 14, width: ulW }} />
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
        <span style={{ position: "absolute", left: 10 }}>Basemap</span>
        <span className="sw" />
        <button
          type="button"
          style={{
            position: "absolute",
            left: 104,
            color: "var(--t1)",
            fontSize: 13.5,
          }}
          title={
            nextBm ? `Switch to ${nextBm.label}` : "No other basemap available"
          }
          onClick={() => nextBm && setBasemap(nextBm.value)}
        >
          {bmLabel}
        </button>
        <button
          type="button"
          style={{
            position: "absolute",
            right: 8,
            color: "var(--t1)",
            fontSize: 13.5,
          }}
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
