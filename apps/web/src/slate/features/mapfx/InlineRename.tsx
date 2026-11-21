import { useEffect, useRef } from "react";
import type { CatalogRow } from "../../../normal/layerCatalog.js";
import type { LayerRegistry } from "../../../registry/LayerRegistry.js";
import "./inlineRename.css";

// InlineRename: D75 "Inline layer rename (the name becomes a focused text
// input)". The row label becomes a focused <input>; Enter or blur commits.
// The rename writes the first mapped layer's descriptor title (the registry
// is the source of truth for the row's display title in the Data sources tab)
// and persists the CatalogRow label override in localStorage keyed by label,
// so the catalog row itself re-renders with the new name on the next pass.

const KEY = "velocity.layerRenames.v1";

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function save(m: Record<string, string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    // Private mode: the rename still applies for this session.
  }
}

export function renameFor(row: CatalogRow): string {
  return load()[row.label] ?? row.label;
}

export function InlineRename({
  row,
  registry,
  onDone,
}: {
  row: CatalogRow;
  registry: LayerRegistry;
  onDone: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const initial = renameFor(row);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = (value: string): void => {
    const v = value.trim();
    if (v && v !== row.label) {
      const map = load();
      map[row.label] = v;
      save(map);
      // The registry title drives the Data sources rows: rename the first
      // mapped layer so both tabs agree.
      const first = row.layerIds[0];
      if (first) {
        const desc = registry.get(first);
        if (desc) registry.setTitle(first, v);
      }
    }
    onDone();
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className="mv-inline-rename"
      defaultValue={initial}
      aria-label={`Rename ${row.label}`}
      data-testid="d75-rename"
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit((e.currentTarget as HTMLInputElement).value);
        if (e.key === "Escape") onDone();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
