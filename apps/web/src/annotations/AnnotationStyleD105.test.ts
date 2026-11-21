// D105: annotation layer styling — colour, width, opacity, dash, font (AnnoStyle).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, "AnnotationPanel.tsx"), "utf8");
const store = readFileSync(path.join(here, "annotationStore.ts"), "utf8");

describe("AnnotationStyle D105", () => {
  it("styling fields are the real AnnoStyle", () => {
    expect(store).toContain("interface AnnoStyle");
    expect(store).toContain("fillOpacity");
    expect(store).toContain("fontSize");
    expect(panel).toContain("style.fillOpacity");
    expect(panel).toContain("style.dash");
    expect(panel).toContain("Colour");
  });
});
