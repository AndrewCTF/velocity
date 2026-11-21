import { useMemo, useState } from "react";
import type { LayerRegistry } from "../../../registry/LayerRegistry.js";
import { defaultLayers } from "../../../registry/defaults.js";
import "./overlaysCatalog.css";

// OverlaysCatalog: D85 "Overlays catalog tab (the real layer registry: tags
// by group, keyless filter, licence, titles)". Tag pills are the registry's
// own sub-groups (id segment); keyless = auth "none"; licence comes from the
// descriptor. The copy's "In path" / "Created by" have no registry source
// and became Group / Licence inputs (D85 note).

interface Descriptor {
  id: string;
  group: string;
  title: string;
  auth: string;
  license: string;
}

const REG: readonly Descriptor[] = defaultLayers as unknown as readonly Descriptor[];

export function OverlaysCatalog({
  registry,
}: {
  registry: LayerRegistry;
}): React.JSX.Element {
  const [keylessOnly, setKeylessOnly] = useState(true);
  const [groupFilter, setGroupFilter] = useState("");
  const [licenseFilter, setLicenseFilter] = useState("");

  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const r of REG) {
      const sub = r.id.split(".")[1] ?? r.id;
      const list = g.get(r.group) ?? [];
      if (!list.includes(sub)) list.push(sub);
      g.set(r.group, list);
    }
    return [...g.entries()];
  }, []);

  const rows = useMemo(() => {
    let out = [...REG];
    if (keylessOnly) out = out.filter((r) => r.auth === "none");
    if (groupFilter) out = out.filter((r) => r.group === groupFilter);
    if (licenseFilter) {
      outer: for (const r of out) {
        if (r.license.toLowerCase().includes(licenseFilter.toLowerCase())) continue;
        out = out.filter((x) => x !== r);
        break outer;
      }
    }
    return out;
  }, [keylessOnly, groupFilter, licenseFilter]);

  return (
    <div className="mv-overlays-catalog" data-testid="d85-catalog">
      <div className="mv-oc-filters">
        <div className="mv-oc-section">
          <div className="mv-oc-heading">TAGS</div>
          {groups.slice(0, 2).map(([g, subs]) => (
            <div key={g} className="mv-oc-group">
              <div className="mv-oc-glabel">{g.charAt(0).toUpperCase() + g.slice(1)}</div>
              <div className="mv-oc-pills">
                {subs.slice(0, 3).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="mv-oc-pill"
                    onClick={() => setGroupFilter(groupFilter === g ? "" : g)}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mv-oc-section">
          <div className="mv-oc-heading">ONLY SHOW</div>
          <label className="mv-oc-keyless">
            <input
              type="checkbox"
              checked={keylessOnly}
              onChange={(e) => setKeylessOnly(e.target.checked)}
            />
            Keyless
          </label>
        </div>
        <div className="mv-oc-section">
          <div className="mv-oc-heading">GROUP</div>
          <input
            type="text"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            placeholder="Group"
            aria-label="Group"
            className="mv-oc-input"
          />
        </div>
        <div className="mv-oc-section">
          <div className="mv-oc-heading">LICENSE</div>
          <input
            type="text"
            value={licenseFilter}
            onChange={(e) => setLicenseFilter(e.target.value)}
            placeholder="Search…"
            aria-label="License"
            className="mv-oc-input"
          />
        </div>
      </div>
      <div className="mv-oc-rows">
        {rows.slice(0, 7).map((r) => (
          <div key={r.id} className="mv-oc-row">
            <span className="mv-oc-icon" aria-hidden="true" />
            <span className="mv-oc-title">{r.title}</span>
            <button
              type="button"
              className="mv-oc-add"
              onClick={() => {
                if (!registry.isEnabled(r.id)) registry.enable(r.id);
              }}
            >
              Add Layer
            </button>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="mv-oc-empty">No keyless layers match</div>
        )}
      </div>
    </div>
  );
}
