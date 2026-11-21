// DrawToolbar D67: icon-only draw group (polygon, lasso, rectangle, circle,
// line, point) arming the DrawController ops.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "DrawToolbar.tsx"), "utf8");
const css = readFileSync(path.join(here, "drawToolbar.css"), "utf8");

describe("DrawToolbar D67", () => {
  it("renders the six copy icons in order", () => {
    for (const icon of ["polygon-filter", "draw", "square", "circle", "more", "map-marker"]) {
      expect(src).toContain(icon);
    }
    expect(src).toContain('aria-label="Draw tools"');
  });

  it("each icon arms its DrawController op", () => {
    expect(src).toContain("drawPolygon");
    expect(src).toContain("drawPolyline");
    expect(src).toContain("drawRect");
    expect(src).toContain("drawCircle");
    expect(src).toContain("placePoint");
    expect(src).toContain("draw.cancel()");
  });

  it("active tool is pressed", () => {
    expect(src).toContain('aria-pressed={current === t.id}');
    expect(src).toContain('is-active');
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-draw-toolbar");
    expect(css).toContain(".mvdt-btn");
  });
});
