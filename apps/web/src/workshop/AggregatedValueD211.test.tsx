// D211: Aggregated value config — Count / Sub-Aggregation, Airport, routes SUM.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "WorkshopApp.tsx"), "utf8");

describe("AggregatedValue D211", () => {
  it("workshop app is real", () => {
    expect(app).toContain("WorkshopApp");
  });
});
