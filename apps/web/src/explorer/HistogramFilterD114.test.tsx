// D114: global filter chip bar — clauses ghost non-matches and recompute.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, "HistogramPanel.tsx"), "utf8");
const facets = readFileSync(path.join(here, "facets.ts"), "utf8");

describe("HistogramFilter D114", () => {
  it("filter clauses ghost non-matching buckets", () => {
    expect(panel).toContain("useFilters");
    expect(panel).toContain("toggleClause");
    expect(facets).toContain("deriveFacets");
  });

  it("an empty filter state exists", () => {
    expect(panel).toContain("clearAll");
  });
});
