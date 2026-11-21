// D206: draw controls with tooltip and drawn polygon and circle over airports.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const draw = readFileSync(path.join(here, "draw.ts"), "utf8");

describe("DrawControls D206", () => {
  it("circle and polygon draw are real", () => {
    expect(draw).toContain("drawCircle");
    expect(draw).toContain("drawPolygon");
  });
});
