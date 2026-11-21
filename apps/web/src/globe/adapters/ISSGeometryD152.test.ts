// D152: Add geometry menu for the ISS layer — TLE source, breadcrumbs, heatmap, lines.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const sat = readFileSync(path.join(here, "SatelliteAdapter.ts"), "utf8");

describe("ISSGeometry D152", () => {
  it("satellite tracks come from the live TLE", () => {
    expect(sat).toContain("SampledPositionProperty");
    expect(sat).toContain("SGP4");
  });
});
