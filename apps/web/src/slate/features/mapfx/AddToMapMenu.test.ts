// AddToMapMenu D79: split menu (Search for objects, intersect a shape, Add overlays).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "AddToMapMenu.tsx"), "utf8");
const css = readFileSync(path.join(here, "addToMapMenu.css"), "utf8");

describe("AddToMapMenu D79", () => {
  it("renders the split menu with three items", () => {
    expect(src).toContain('aria-label="Add to map menu"');
    expect(src).toContain('aria-label="Add to map"');
    expect(src).toContain('data-testid="d79-add-to-map"');
    expect(src).toContain("Search for objects");
    expect(src).toContain("Intersect a shape");
    expect(src).toContain("Add overlays");
  });

  it("actions run existing app actions", () => {
    expect(src).toContain("usePalette.getState().setOpen(true)");
    expect(src).toContain('setTool("area")');
    expect(src).toContain("onAddOverlays");
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-atm-menu");
    expect(css).toContain(".mv-atm-caret");
  });
});
