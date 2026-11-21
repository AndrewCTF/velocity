// M11: layer row menu mounts MoveToLayer.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const menu = readFileSync(path.join(here, "LayerMenu.tsx"), "utf8");

describe("LayerMenuMove M11", () => {
  it("layer menu mounts MoveToLayer with the category splits", () => {
    expect(menu).toContain("<MoveToLayer");
    expect(menu).toContain('id: "airliners"');
    expect(menu).toContain('id: "other-aircraft"');
  });

  it("portal menus stop propagation so the row button does not collapse them", () => {
    expect(menu).toContain("onClick={(e) => e.stopPropagation()}");
  });

  it("counts come from the live registry, not hard-coded zeros", () => {
    expect(menu).toContain("useLayerCounts(viewer)");
    expect(menu).toContain("rowCount(counts");
  });
});
