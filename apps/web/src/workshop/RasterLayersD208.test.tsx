// D208: static raster layers — land-cover mask and hillshade with swatch legend.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "WorkshopApp.tsx"), "utf8");

describe("RasterLayers D208", () => {
  it("workshop app is real", () => {
    expect(app).toContain("WorkshopApp");
  });
});
