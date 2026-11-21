// D165: choropleth of admin-1 regions by percent of degraded aircraft.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = readFileSync(path.join(here, "PollGeoJsonAdapter.ts"), "utf8");
const registry = readFileSync(path.join(here, "../../registry/defaults.ts"), "utf8");

describe("AdminChoropleth D165", () => {
  it("poll adapter and jamming feed are real", () => {
    expect(adapter).toContain("PollGeoJsonAdapter");
    expect(registry).toContain("/api/jamming/nacp");
  });
});
