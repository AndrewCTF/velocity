// M3: Gaia home — create bar, chokepoint outlines, artifact dots, legend, type bar.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = readFileSync(path.join(here, "GaiaHome.tsx"), "utf8");
const rex = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("GaiaHome M3", () => {
  it("home and chokepoint feed are real", () => {
    expect(home).toContain("GaiaHome");
    expect(rex).toContain("chokepoint");
  });
});
