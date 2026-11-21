import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Cesium from "cesium";
import { apiFetch } from "../../../transport/http.js";
import {
  useFilters,
  useImagery,
  useSelection,
} from "../../../state/stores.js";
import { BpIcon } from "../../../shell/BpIcon.js";
import { toast } from "../../../shell/toast.js";
import "./saveMenu.css";
// SaveMenu: D62 "Save menu with Duplicate and Save as template" in the Maven
// header. The main split button saves the current viewport/layers as a copy
// ("Duplicate" semantics: always mints a fresh `map:<uuid>`); the caret opens
// the two-item menu. Backend is the existing POST /api/maps ontology store
// (apps/api/app/routes/maps.py), which already supports insert without id.

interface CopViewport {
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
}

interface CopState {
  viewport: CopViewport | null;
  layers: string[];
  imagery: {
    provider: string;
    layer: string;
    date: string;
    maxZ: number;
    opacity: number;
  } | null;
  selection: string | null;
  filters: { facet: string; value: string; mode: "only" | "not" }[];
}

function readViewport(viewer: Cesium.Viewer): CopViewport | null {
  const carto = viewer.camera.positionCartographic;
  if (!carto) return null;
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
    height: carto.height,
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
    roll: viewer.camera.roll,
  };
}

function serializeState(viewer: Cesium.Viewer | null): CopState {
  const overlay = useImagery.getState().overlay;
  const overlayOpacity = useImagery.getState().overlayOpacity;
  const reg = (window as unknown as { __registry?: { list(): { id: string }[]; isEnabled(id: string): boolean } }).__registry;
  const layers = reg
    ? reg
        .list()
        .filter((l) => reg.isEnabled(l.id))
        .map((l) => l.id)
    : [];
  return {
    viewport: viewer ? readViewport(viewer) : null,
    layers,
    imagery: overlay
      ? {
          provider: overlay.provider,
          layer: overlay.layer,
          date: overlay.date,
          maxZ: overlay.maxZ,
          opacity: overlayOpacity,
        }
      : null,
    selection: useSelection.getState().selectedEntityId,
    filters: [...useFilters.getState().clauses],
  };
}

export function SaveMenu({
  title,
  viewer,
}: {
  title: string;
  viewer: Cesium.Viewer | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const save = useCallback(
    async (kind: "duplicate" | "template") => {
      if (busy) return;
      setBusy(true);
      setOpen(false);
      const base = title.trim() || "Unsaved Map";
      const name =
        kind === "template" ? `${base} (template)` : `${base} copy`;
      try {
        const r = await apiFetch("/api/maps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, state: serializeState(viewer) }),
        });
        if (!r.ok) {
          toast.error(
            r.status === 401
              ? "Sign in to save maps"
              : r.status === 503
                ? "Maps need Supabase"
                : `Could not save the map (HTTP ${r.status})`,
          );
          return;
        }
        toast.ok(
          kind === "template"
            ? `Template saved as ${name}`
            : `Duplicate saved as ${name}`,
        );
      } catch {
        toast.error("Could not save the map");
      } finally {
        setBusy(false);
      }
    },
    [title, viewer, busy],
  );

  return (
    <span ref={ref} className="mv-save" style={{ gap: 0 }}>
      <button
        type="button"
        className="mv-save-main"
        aria-label={busy ? "Saving…" : "Save as Duplicate"}
        aria-disabled={busy}
        disabled={busy}
        onClick={() => void save("duplicate")}
      >
        Save as…
      </button>
      <button
        type="button"
        className="mv-save-caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Save menu"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <BpIcon name="caret-down" size={10} />
      </button>
      {open &&
        createPortal(
          <div
            role="menu"
            aria-label="Save"
            className="sl-pop mv-save-pop"
            style={{
              position: "fixed",
              left: ref.current?.getBoundingClientRect().left ?? 481,
              top: (ref.current?.getBoundingClientRect().bottom ?? 56) + 4,
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => void save("duplicate")}
            >
              <span className="lbl">Duplicate</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void save("template")}
            >
              <span className="lbl">Save as template…</span>
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}
