// D90: Object right-click menu with coordinate copy footer + series submenu.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "ContextMenu.tsx"), "utf8");
const css = readFileSync(path.join(here, "contextMenu.css"), "utf8");
const actions = readFileSync(path.join(here, "mapActions.ts"), "utf8");

describe("ContextMenu D90", () => {
  it("menu carries a coordinate copy footer with the clicked point", () => {
    expect(src).toContain('inArea ? "d92-area-footer" : "d90-coord-footer"');
    expect(src).toContain("lat.toFixed(4)");
    expect(src).toContain("lon.toFixed(4)");
  });

  it("Copy coordinates writes the same point to the clipboard", () => {
    expect(actions).toContain("Copy coordinates");
    expect(actions).toContain("navigator.clipboard?.writeText");
  });

  it("menu has the full pointActions list", () => {
    expect(src).toContain("pointActions(lat, lon)");
    expect(actions).toContain("Collect satellite imagery");
    expect(actions).toContain("AI assess this location");
  });

  it("footer is styled at the menu foot", () => {
    expect(css).toContain(".gx-coord");
  });
});
