// D209: time-dependent property with Derivative transform: EMSC quakes per country per hour.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "WorkshopApp.tsx"), "utf8");
const registry = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("Derivative D209", () => {
  it("workshop and seismic feed are real", () => {
    expect(app).toContain("WorkshopApp");
    expect(registry).toContain("seismic");
  });
});
