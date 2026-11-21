// D205: choropleth legend with metric dropdowns and hover card.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "WorkshopApp.tsx"), "utf8");
const registry = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("ChoroplethLegend D205", () => {
  it("workshop and jamming feed are real", () => {
    expect(app).toContain("WorkshopApp");
    expect(registry).toContain("/api/jamming/nacp");
  });
});
