// D98: modify toolbar — Escape returns to pan, Clear area ends the modify.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolbar = readFileSync(path.join(here, "GlobeToolbar.tsx"), "utf8");

describe("ModifyToolbar D98", () => {
  it("Escape returns to pan (the modify exit)", () => {
    expect(toolbar).toContain('if (useMapTools.getState().tool !== "pan") setTool("pan")');
  });

  it("Clear area drops the drawn shape", () => {
    expect(toolbar).toContain('aria-label="Clear area"');
    expect(toolbar).toContain("setArea(null)");
  });
});
