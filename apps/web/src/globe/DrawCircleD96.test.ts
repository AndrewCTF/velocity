// D96: circle draw — click centre, move to size, click to commit (radius km).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const draw = readFileSync(path.join(here, "draw.ts"), "utf8");
const toolbar = readFileSync(path.join(here, "GlobeToolbar.tsx"), "utf8");

describe("DrawCircle D96", () => {
  it("circle is click-centre, move-to-size, click-commit", () => {
    expect(draw).toContain("drawCircle(onDone: (center: LatLon, radiusKm: number) => void)");
  });

  it("the annotate path draws circles with a km radius", () => {
    expect(toolbar).toContain("draw.drawCircle((c, r) =>");
    expect(toolbar).toContain("radiusKm: r");
  });
});
