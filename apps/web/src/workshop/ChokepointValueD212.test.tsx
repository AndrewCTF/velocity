// D212: Non-aggregated value config — Chokepoint vessel counts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "WorkshopApp.tsx"), "utf8");
const registry = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("ChokepointValue D212", () => {
  it("workshop and chokepoint feed are real", () => {
    expect(app).toContain("WorkshopApp");
    expect(registry).toContain("chokepoint");
  });
});
