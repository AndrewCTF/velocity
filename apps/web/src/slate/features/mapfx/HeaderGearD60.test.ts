// D60: Map app header — Save as, gear (Settings), Time selection.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const maven = readFileSync(
  path.join(here, "../../../globe/MavenMap.tsx"),
  "utf8",
);
const saveMenu = readFileSync(path.join(here, "SaveMenu.tsx"), "utf8");
const layers = readFileSync(
  path.join(here, "../../pages/MavenLayers.tsx"),
  "utf8",
);

describe("D60 map header", () => {
  it("Save as split button exists in the Maven header", () => {
    expect(saveMenu).toContain("Save as…");
    expect(maven).toContain("<SaveMenu");
  });

  it("gear opens Settings via ctx.openSettings", () => {
    expect(maven).toContain('data-testid="d60-settings"');
    expect(maven).toContain('aria-label="Settings"');
    expect(maven).toContain("ctx.openSettings()");
    expect(maven).toContain('name="cog"');
  });

  it("empty Layers state renders when no rows are on", () => {
    expect(layers).toContain("No layers");
    expect(layers).toContain("Add data to your map to get started");
  });

  it("the TimeDock clock is the live time surface", () => {
    expect(maven).toContain("View on timeline");
  });
});
