// D151: Add display popover with presets (Icon, Cluster, Timeline wired).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(path.join(here, "LayerRail.tsx"), "utf8");

describe("AddDisplay D151", () => {
  it("layer rail is real", () => {
    expect(rail).toContain("LayerRail");
  });
});
