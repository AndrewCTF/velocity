// D154: choropleth display editor — Mean aggregation of AIS speed.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = readFileSync(path.join(here, "PollGeoJsonAdapter.ts"), "utf8");

describe("Choropleth D154", () => {
  it("poll adapter is the choropleth path", () => {
    expect(adapter).toContain("PollGeoJsonAdapter");
  });
});
