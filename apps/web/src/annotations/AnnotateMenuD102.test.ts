// D102: annotate menu — the five shape kinds the Annotate tool really places.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, "AnnotationPanel.tsx"), "utf8");
const toolbar = readFileSync(
  path.join(here, "../globe/GlobeToolbar.tsx"),
  "utf8",
);

describe("AnnotateMenu D102", () => {
  it("the panel offers text, line, polygon, box and circle kinds", () => {
    expect(panel).toContain('{ id: "text", icon: Type, label: "Text" }');
    expect(panel).toContain('{ id: "line", icon: Minus, label: "Line" }');
    expect(panel).toContain('{ id: "polygon", icon: Pentagon, label: "Polygon" }');
    expect(panel).toContain('{ id: "rect", icon: Square, label: "Box" }');
    expect(panel).toContain('{ id: "circle", icon: Circle, label: "Circle" }');
  });

  it("the toolbar annotate tool places each kind with its draw call", () => {
    expect(toolbar).toContain('tool === "annotate"');
    expect(toolbar).toContain("draw.drawCircle");
    expect(toolbar).toContain("draw.drawPolygon");
    expect(toolbar).toContain("draw.drawRect");
    expect(toolbar).toContain("draw.drawPolyline");
  });
});
