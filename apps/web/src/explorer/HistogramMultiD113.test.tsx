// D113: histogram multi-select — buckets toggle as clauses; map filters.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, "HistogramPanel.tsx"), "utf8");

describe("HistogramMulti D113", () => {
  it("multi-select uses the shared filter clauses", () => {
    expect(panel).toContain("useFilters");
    expect(panel).toContain("toggleClause");
    expect(panel).toContain('"only"');
  });
});
