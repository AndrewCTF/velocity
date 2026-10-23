import { useState } from "react";
import { createPortal } from "react-dom";
import type { LayerRegistry } from "../../../registry/LayerRegistry.js";
import { defaultLayers } from "../../../registry/defaults.js";
import { useLayerStyles } from "../../../layer-editor/layerStyleStore.js";
import { BpIcon } from "../../../shell/BpIcon.js";

// The reference "Create vessel watch layer" floating panel (row M12): pick a
// vessel layer, a colour and a symbol size. It writes the same per-layer
// style override the Layer editor does (layerStyleStore) and switches the
// layer on, so the change is on the globe at once. The chevron folds it to
// the small edit pill, as the copy does.

const VESSEL_LAYERS = defaultLayers.filter((d) => d.group === "maritime");
const SYMBOLS: ReadonlyArray<[string, number]> = [
  ["Small", 0.7],
  ["Medium", 1],
  ["Large", 1.4],
];

export function CreateLayer({
  registry,
  anchor,
  onClose,
}: {
  registry: LayerRegistry;
  anchor: { left: number; top: number };
  onClose: () => void;
}): JSX.Element {
  const overrides = useLayerStyles((s) => s.overrides);
  const setOverride = useLayerStyles((s) => s.setOverride);
  const [id, setId] = useState(VESSEL_LAYERS[0]?.id ?? "");
  const [folded, setFolded] = useState(false);
  const ov = overrides[id] ?? {};
  const apply = (patch: { color?: string; scale?: number }): void => {
    setOverride(id, patch);
    if (!registry.isEnabled(id)) registry.enable(id);
  };

  return createPortal(
    <div className="cvl" style={{ left: anchor.left, top: anchor.top }}>
      {folded ? (
        <button
          type="button"
          className="pillb"
          onClick={() => setFolded(false)}
          title="Open the layer form"
        >
          <BpIcon name="edit" />
          <BpIcon name="chevron-right" />
        </button>
      ) : (
        <>
          <div className="box">
            <div className="t">Create vessel watch layer</div>
            <div className="r">
              <label className="sel" title="Vessel layer">
                <select
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  aria-label="Vessel layer"
                >
                  {VESSEL_LAYERS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
                <BpIcon name="caret-down" />
              </label>
              <label className="sw" title="Colour">
                <input
                  type="color"
                  value={ov.color ?? "#58c8e0"}
                  aria-label="Colour"
                  onChange={(e) => apply({ color: e.target.value })}
                />
                <i style={{ background: ov.color ?? "#58c8e0" }} />
                <BpIcon name="caret-down" />
              </label>
              <label className="sel sym" title="Symbol size">
                <select
                  value={String(ov.scale ?? 1)}
                  aria-label="Symbol"
                  onChange={(e) => apply({ scale: Number(e.target.value) })}
                >
                  {SYMBOLS.map(([l, v]) => (
                    <option key={l} value={String(v)}>
                      Symbol · {l}
                    </option>
                  ))}
                </select>
                <BpIcon name="caret-down" />
              </label>
              <button
                type="button"
                className="fold"
                aria-label="Fold"
                onClick={() => setFolded(true)}
              >
                <BpIcon name="chevron-left" />
              </button>
            </div>
          </div>
          <button
            type="button"
            className="pillb"
            onClick={onClose}
            title="Close"
          >
            <BpIcon name="edit" />
            <BpIcon name="cross" />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
