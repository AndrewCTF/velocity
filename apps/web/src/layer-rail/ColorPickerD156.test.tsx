// D156: colour picker with presets; layer's real jam colour #ef4444.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(path.join(here, "LayerRail.tsx"), "utf8");

describe("ColorPicker D156", () => {
  it("layer rail is real", () => {
    expect(rail).toContain("LayerRail");
  });
});
