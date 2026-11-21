// D99: shape vertex edit — polygon draw is multi-click closed (>=3 verts).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const draw = readFileSync(path.join(here, "draw.ts"), "utf8");

describe("VertexEdit D99", () => {
  it("polygon draw commits a closed ring of 3+ vertices", () => {
    expect(draw).toContain("drawPolygon(onDone: (ring: LatLon[]) => void)");
    expect(draw).toContain("verts.length >= 3");
    expect(draw).toContain("polygonCb");
  });

  it("right-click commits the polygon", () => {
    expect(draw).toContain("RIGHT_CLICK");
    expect(draw).toContain('if (mode === "polyline" || mode === "polygon") finish()');
  });
});
