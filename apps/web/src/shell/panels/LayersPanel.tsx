import { useEffect, useReducer, useState } from "react";
import type * as Cesium from "cesium";
import type { LayerRegistry } from "../../registry/LayerRegistry.js";
import { Icon } from "../../normal/Icon.js";
import { LayerRail } from "../../layer-rail/LayerRail.js";
import { useLayerCounts, rowState } from "../../layer-rail/useLayerCounts.js";
import {
  tierOf,
  TIER_META,
  TIER_ORDER,
  type Tier,
} from "../../registry/provenance.js";
import {
  MAP_LAYER_FOLDERS,
  rowEnabled,
  toggleRow,
  toggleFolder,
} from "../../normal/layerCatalog.js";

// The Layers panel, built from docs/mockups/console-2026-08 and fed by the real
// registry. It is NOT the old LayerCatalog restyled.
//
// The difference matters and it is the whole point of the rebuild. The old
// panel painted a deep hand-tuned background per domain (cyan for air, teal for
// maritime, red for hazards) and stated each layer's state as the word `ON` or
// `OFF`. So the loudest thing in the panel was the folder chrome, and the
// quietest thing was the data: a 12,000-contact layer and a 3-contact layer
// both said `ON`.
//
// The mockup inverts that. The group header is a plain uppercase label with a
// hairline and a `3 of 6` count, carrying no colour of its own, and every row
// carries its live count and a bar. Colour is spent on the DATA, not on the
// furniture around it.
//
// The bar is scaled against the largest row in its own group. Scaling across
// groups would render every hazard row as an empty track next to aircraft, and
// the comparison an operator actually makes is within a domain.

/** The tier a catalog row's data comes from. A row can map to several registry
 *  layers; where they disagree the WEAKEST wins, because a fused row is only as
 *  believable as its softest input and rounding that up is the laundering the
 *  tier exists to prevent. */
export function rowTier(layerIds: readonly string[]): Tier | undefined {
  const rank: Record<Tier, number> = {
    sensor: 0,
    registry: 1,
    filing: 2,
    claim: 3,
  };
  let worst: Tier | undefined;
  for (const id of layerIds) {
    const t = tierOf(id);
    if (t && (worst === undefined || rank[t] > rank[worst])) worst = t;
  }
  return worst;
}

function TierMark({ tier }: { tier: Tier | undefined }): JSX.Element {
  if (!tier) return <span className="w-[21px] shrink-0" aria-hidden="true" />;
  const m = TIER_META[tier];
  return (
    <abbr
      title={`${m.label} · ${m.blurb}`}
      className={`mono w-[21px] shrink-0 text-center text-[12px] no-underline ${
        tier === "claim" ? "text-warn" : "text-txt-3"
      }`}
    >
      {m.short}
    </abbr>
  );
}

export function LayersPanel({
  registry,
  viewer,
}: {
  registry: LayerRegistry;
  viewer?: Cesium.Viewer | null;
}): JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => registry.subscribe(force), [registry]);
  const counts = useLayerCounts(viewer);
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const toggleOpen = (id: string): void =>
    setOpenIds((o) => ({
      ...o,
      [id]: !(
        o[id] ??
        MAP_LAYER_FOLDERS.find((f) => f.id === id)?.defaultOpen ??
        false
      ),
    }));
  // The curated / all switch `panels.ts` promised.
  //
  // REHOMED records `allsources` as "redundant with Layers, which gains a
  // curated/all toggle". The toggle was never built, so `byHome` dropped the
  // old All-sources rail on the floor and the raw registry — every layer the
  // curated folders do not name — became unreachable in the console. A recorded
  // replacement that does not exist is worse than an unrecorded deletion,
  // because the contract test passes either way.
  const [all, setAll] = useState(false);
  // Provenance filter. `claim` starts OFF: the default posture of this console
  // is that nothing on the map is there because somebody said so. Turning it
  // back on is one click and it is a deliberate one.
  const [tiers, setTiers] = useState<ReadonlySet<Tier>>(
    () => new Set<Tier>(["sensor", "registry", "filing"]),
  );
  const toggleTier = (t: Tier): void =>
    setTiers((s) => {
      const next = new Set(s);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  const showsRow = (layerIds: readonly string[]): boolean => {
    const t = rowTier(layerIds);
    return t === undefined || tiers.has(t);
  };

  return (
    <div className="pb-2">
      <div
        className="flex items-center gap-[4px] border-b border-line px-[14px] py-[6px]"
        role="group"
        aria-label="Layer source"
      >
        {(
          [
            ["Curated", false],
            ["All sources", true],
          ] as const
        ).map(([label, v]) => (
          <button
            key={label}
            type="button"
            onClick={() => setAll(v)}
            aria-pressed={all === v}
            className={`mono h-[20px] rounded-sm px-[7px] text-[12px] ${
              all === v
                ? "bg-accent-dim text-accent-fg shadow-[inset_0_0_0_1px_var(--accent-line)]"
                : "text-txt-2 hover:bg-(--hover)"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <span className="mono text-[12px] tabular-nums text-txt-3">
          {registry.list().length}
        </span>
      </div>

      {/* Provenance. Four buttons that say who is vouching for the data, in the
          order they deserve to be believed. docs/plan-99-2026-08.md §0. */}
      <div
        className="flex items-center gap-[4px] border-b border-line px-[14px] py-[6px]"
        role="group"
        aria-label="Provenance"
      >
        <span className="mr-[2px] text-[12px] text-txt-3">Source</span>
        {TIER_ORDER.map((t) => {
          const on = tiers.has(t);
          const m = TIER_META[t];
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggleTier(t)}
              aria-pressed={on}
              title={m.blurb}
              className={`mono h-[20px] rounded-sm px-[6px] text-[12px] ${
                on
                  ? "bg-accent-dim text-accent-fg shadow-[inset_0_0_0_1px_var(--accent-line)]"
                  : "text-txt-3 hover:bg-(--hover)"
              }`}
            >
              {m.short}
            </button>
          );
        })}
        <span className="flex-1" />
        <span className="truncate text-[12px] text-txt-3">
          {tiers.has("claim") ? "incl. claims" : "observed only"}
        </span>
      </div>

      {all && <LayerRail registry={registry} viewer={viewer ?? null} />}
      {!all && (
        <>
          {MAP_LAYER_FOLDERS.map((folder) => {
            const rows = folder.rows.filter((r) => showsRow(r.layerIds));
            if (rows.length === 0) return null;
            // Counted over what the operator can actually see. `folderCounts` reads
            // the whole folder, so with a tier filtered out it would report an `on`
            // for a row that is not on screen.
            const on = rows.filter((r) => rowEnabled(registry, r)).length;
            const total = rows.length;
            const open = openIds[folder.id] ?? folder.defaultOpen ?? on > 0;
            return (
              <section key={folder.id} aria-label={folder.label}>
                <div data-layer-folder className="k-band">
                  <button
                    type="button"
                    onClick={() => toggleOpen(folder.id)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-[6px] text-left"
                  >
                    <Icon
                      name={open ? "chevron-down" : "chevron-right"}
                      className="h-3 w-3 shrink-0 text-txt-2"
                    />
                    <span className="truncate">{folder.label}</span>
                  </button>
                  <span className="k-n tabular-nums">
                    {on} of {total}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleFolder(registry, { ...folder, rows })}
                    aria-label={
                      on > 0
                        ? `Turn all ${folder.label} off`
                        : `Turn all ${folder.label} on`
                    }
                    className="flex h-5 w-5 items-center justify-center rounded-sm text-txt-3 hover:bg-bg-2 hover:text-txt-0"
                  >
                    <Icon name="crosshair" className="h-3 w-3" />
                  </button>
                </div>

                {open &&
                  rows.map((row) => {
                    const en = rowEnabled(registry, row);
                    const st = rowState(counts, row.layerIds, en);
                    const tier = rowTier(row.layerIds);
                    return (
                      <button
                        key={row.label}
                        type="button"
                        onClick={() => toggleRow(registry, row)}
                        aria-pressed={en}
                        data-layer-row
                        className="flex h-[29px] w-full items-center gap-[10px] pl-[30px] pr-[14px] text-left hover:bg-(--hover)"
                      >
                        <Icon
                          name={row.icon}
                          className={`h-4 w-4 shrink-0 ${en ? "text-txt-0" : "text-txt-2"}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block truncate text-[15px] ${en ? "text-txt-0" : "text-txt-1"}`}
                          >
                            {row.label}
                          </span>
                        </span>
                        {/* The tier this row's data comes from, stated on the row and
                      not only in a filter. It is the one fact that decides how
                      much of the rest of the row to believe. */}
                        <TierMark tier={tier} />
                        {/* A count, never the word "on". (The magnitude bar beside it
                      went 2026-10-23 for the reference's plain list rows.)
                      Four states, not two. `off`, `pending`, `empty` and `live`
                      used to collapse into a blank and a lone em dash, so a
                      layer that answered zero and a layer that never answered
                      looked identical, and 58 of 64 rows read as the same grey
                      nothing. A quiet source is information; a source that never
                      loaded is a fault; they cannot share a glyph. */}
                        <span
                          className={`w-[52px] shrink-0 text-right text-[14px] tabular-nums ${
                            st.state === "live"
                              ? "text-txt-1"
                              : st.state === "empty"
                                ? "text-txt-2"
                                : "text-txt-3"
                          }`}
                          title={
                            st.state === "pending"
                              ? "Loading"
                              : st.state === "empty"
                                ? "Reported, nothing in view"
                                : undefined
                          }
                        >
                          {st.state === "off"
                            ? ""
                            : st.state === "pending"
                              ? "…"
                              : st.state === "empty"
                                ? "0"
                                : st.n.toLocaleString()}
                        </span>
                        {/* An eye, not a sliding pill. The pill was 26px of iOS in a
                      Blueprint console, and it stated a second time what the
                      accent icon and the accent bar already state. Its width is
                      what forced `Chokepoint conge…`, `Disaster alerts (G…` and
                      `Humanitarian disa…` in a 336px panel. */}
                        <Icon
                          name={en ? "eye" : "eye-off"}
                          className={`h-4 w-4 shrink-0 ${en ? "text-txt-1" : "text-txt-3"}`}
                        />
                      </button>
                    );
                  })}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
