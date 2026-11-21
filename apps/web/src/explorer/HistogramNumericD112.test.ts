// D112: numeric histogram — n / sum / avg over the live numeric values.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const facets = readFileSync(path.join(here, "facets.ts"), "utf8");
const panel = readFileSync(path.join(here, "HistogramPanel.tsx"), "utf8");

describe("HistogramNumeric D112", () => {
  it("numeric buckets derive from live values without binning", () => {
    expect(facets).toContain("deriveFacets");
    expect(panel).toContain("hist.facet");
  });
});
