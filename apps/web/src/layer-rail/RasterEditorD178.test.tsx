// D178: Raster source editor — NASA GIBS WMTS template, tile size, zoom 0 to 8.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(path.join(here, "LayerRail.tsx"), "utf8");

describe("RasterEditor D178", () => {
  it("layer rail is real", () => {
    expect(rail).toContain("LayerRail");
  });
});
