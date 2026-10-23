// Layer editor: pick a registry layer, override its colour / size / opacity on
// the globe (layerStyleStore, applied in place by the compositor and the
// primitive renderer), and read the layer's real descriptor and source.
// Adding new raster/vector sources is not offered: a new upstream host needs a
// tile-proxy egress rule (apps/api/CLAUDE.md), so this edits existing layers only.
import { useMemo, useState } from "react";
import { isLayerDescriptor, type LayerDescriptor } from "@osint/shared";
import { defaultLayers } from "../registry/defaults.js";
import { useLayerStyles, type LayerStyleOverride } from "./layerStyleStore.js";

function refreshLabel(d: LayerDescriptor): string {
  const ttl = d.refresh.ttlSec;
  return ttl != null ? `${d.refresh.mode} · every ${ttl}s` : d.refresh.mode;
}

export function LayerEditorPanel(): JSX.Element {
  const [selId, setSelId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const overrides = useLayerStyles((s) => s.overrides);
  const setOverride = useLayerStyles((s) => s.setOverride);
  const reset = useLayerStyles((s) => s.reset);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const m = new Map<string, LayerDescriptor[]>();
    for (const d of defaultLayers) {
      if (needle && !`${d.title} ${d.id}`.toLowerCase().includes(needle))
        continue;
      const list = m.get(d.group) ?? [];
      list.push(d);
      m.set(d.group, list);
    }
    return [...m.entries()];
  }, [q]);

  const sel = defaultLayers.find((d) => d.id === selId) ?? null;
  const ov: LayerStyleOverride = sel ? (overrides[sel.id] ?? {}) : {};
  const json = sel
    ? JSON.stringify({ descriptor: sel, override: ov }, null, 2)
    : "";
  const valid = sel ? isLayerDescriptor(sel) : false;
  const field = "w-full border border-line bg-bg-2 px-2 py-1 text-txt-0";

  return (
    <div className="flex h-full min-h-0 bg-bg-1 font-sans text-txt-0">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-line">
        <div className="k-title">Map layers</div>
        <div className="px-4 pb-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter layers"
            aria-label="Filter layers"
            className={field}
          />
        </div>
        {groups.length === 0 && (
          <div className="k-empty">No layer matches that filter.</div>
        )}
        {groups.map(([group, layers]) => (
          <div key={group}>
            <div className="k-band">
              {group} <span className="k-n">{layers.length}</span>
            </div>
            {layers.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setSelId(d.id)}
                className={`flex w-full items-center justify-between gap-2 px-4 py-1.5 text-left text-[14px] ${d.id === selId ? "bg-bg-3" : "hover:bg-(--hover)"}`}
              >
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                {overrides[d.id] && <span className="k-chip">edited</span>}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {!sel ? (
          <div className="k-empty">
            Select a layer to change how it draws on the globe.
          </div>
        ) : (
          <>
            <div className="k-title">{sel.title}</div>
            <div className="k-band">Style</div>
            <div className="space-y-3 px-4 py-3 text-[14px]">
              <label className="flex items-center gap-3">
                <span className="w-20 text-txt-3">Colour</span>
                <input
                  type="color"
                  value={ov.color ?? "#ffffff"}
                  onChange={(e) =>
                    setOverride(sel.id, { color: e.target.value })
                  }
                  aria-label="Layer colour"
                />
                <span className="mono text-txt-2">
                  {ov.color ?? "icon default"}
                </span>
              </label>
              <label className="flex items-center gap-3">
                <span className="w-20 text-txt-3">Size</span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={ov.scale ?? 1}
                  onChange={(e) =>
                    setOverride(sel.id, { scale: Number(e.target.value) })
                  }
                  aria-label="Layer icon size"
                  className="flex-1 accent-accent"
                />
                <span className="mono w-12 text-right">
                  {(ov.scale ?? 1).toFixed(1)}x
                </span>
              </label>
              <label className="flex items-center gap-3">
                <span className="w-20 text-txt-3">Opacity</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={ov.opacity ?? 1}
                  onChange={(e) =>
                    setOverride(sel.id, { opacity: Number(e.target.value) })
                  }
                  aria-label="Layer opacity"
                  className="flex-1 accent-accent"
                />
                <span className="mono w-12 text-right">
                  {Math.round((ov.opacity ?? 1) * 100)}%
                </span>
              </label>
              <div className="text-[13px] text-txt-3">
                Colour tints the layer&apos;s icons and size scales them.
                Polygons and lines take the opacity only.
              </div>
              <button
                type="button"
                className="k-chip"
                disabled={!overrides[sel.id]}
                onClick={() => reset(sel.id)}
              >
                Reset to default
              </button>
            </div>

            <div className="k-band">Source</div>
            <div className="k-kv">
              <span className="k">Kind</span>
              <span className="v mono">{sel.kind}</span>
              <span className="k">Endpoint</span>
              <span className="v mono">{sel.endpoint}</span>
              <span className="k">Refresh</span>
              <span className="v mono">{refreshLabel(sel)}</span>
              <span className="k">Auth</span>
              <span className="v mono">{sel.auth}</span>
              <span className="k">License</span>
              <span className="v">{sel.license}</span>
            </div>

            <div className="k-band">
              JSON
              <span className={`k-chip ${valid ? "g" : "r"}`}>
                {valid ? "Valid descriptor" : "Invalid descriptor"}
              </span>
            </div>
            <pre
              aria-label="Layer descriptor JSON"
              className="mono m-0 overflow-x-auto px-4 py-3 text-[12px] text-txt-1"
            >
              {json}
            </pre>
          </>
        )}
      </main>
    </div>
  );
}
