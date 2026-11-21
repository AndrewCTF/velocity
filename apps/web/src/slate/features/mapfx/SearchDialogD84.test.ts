// SearchDialog D84: filtered to a drawn shape (bbox from useMapTools.area).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "SearchDialog.tsx"), "utf8");
const css = readFileSync(path.join(here, "searchDialog.css"), "utf8");
const layers = readFileSync(
  path.join(here, "../../pages/MavenLayers.tsx"),
  "utf8",
);

describe("SearchDialog D84", () => {
  it("shows a drawn-shape chip when bbox is set", () => {
    expect(src).toContain('data-testid="d84-drawn-shape"');
    expect(src).toContain("Filtered to drawn shape");
  });

  it("passes bbox into the object search", () => {
    expect(src).toContain("...(bbox ? { bbox } : {})");
  });

  it("derives bbox from the drawn area in MavenLayers", () => {
    expect(layers).toContain("useMapTools((s) => s.area)");
    expect(layers).toContain("drawnArea.west");
    expect(layers).toContain("drawnArea.south");
    expect(layers).toContain("drawnArea.east");
    expect(layers).toContain("drawnArea.north");
  });

  it("the chip is styled", () => {
    expect(css).toContain(".mv-sd-shape-chip");
  });
});
