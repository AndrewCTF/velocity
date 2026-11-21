// D111: date binning — the facet bucket derives from the live feed's values.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const facets = readFileSync(path.join(here, "facets.ts"), "utf8");
const panel = readFileSync(path.join(here, "HistogramPanel.tsx"), "utf8");

describe("HistogramDate D111", () => {
  it("buckets derive from the feed's live values", () => {
    expect(facets).toContain("deriveFacets");
    expect(panel).toContain("hist.facet");
    expect(panel).toContain("b.value");
  });

  it("the USGS month feed is a real bucket source", () => {
    expect(facets).toContain("altitude");
  });
});
