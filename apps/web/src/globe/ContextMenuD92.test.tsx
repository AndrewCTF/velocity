// D92: shape right-click menu on a drawn area box (real area actions).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const menu = readFileSync(path.join(here, "ContextMenu.tsx"), "utf8");
const canvas = readFileSync(path.join(here, "GlobeCanvas.tsx"), "utf8");
const actions = readFileSync(path.join(here, "mapActions.ts"), "utf8");
const store = readFileSync(path.join(here, "contextMenuStore.ts"), "utf8");

describe("ContextMenu D92 area box", () => {
  it("right-click inside the drawn box opens the area menu", () => {
    expect(canvas).toContain("useMapTools.getState().area");
    expect(canvas).toContain('inArea ? "area" : "point"');
    expect(canvas).toContain("drawn.north");
    expect(canvas).toContain("drawn.west");
  });

  it("menu renders areaActions when mode is area", () => {
    expect(menu).toContain("areaActions(area!)");
    expect(menu).toContain('mode === "area"');
    expect(menu).toContain('inArea ? "d92-area-footer" : "d90-coord-footer"');
  });

  it("area actions are real (search/collect/ground/AI over the box)", () => {
    expect(actions).toContain("Search objects in box");
    expect(actions).toContain("Collect imagery (centre)");
    expect(actions).toContain("AI assess this area");
  });

  it("store carries the point/area mode", () => {
    expect(store).toContain('type CmenuMode = "point" | "area"');
    expect(store).toContain("mode?: CmenuMode");
  });
});
