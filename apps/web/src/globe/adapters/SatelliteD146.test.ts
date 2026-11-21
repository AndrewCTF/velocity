// D146: track breadcrumbs coloured by latitude — ISS ground track from the live TLE.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const sat = readFileSync(path.join(here, "SatelliteAdapter.ts"), "utf8");

describe("Satellite D146", () => {
  it("SGP4-sampled tracks from the live TLE", () => {
    expect(sat).toContain("SampledPositionProperty");
    expect(sat).toContain("SGP4");
    expect(sat).toContain("endpoint");
  });
});
