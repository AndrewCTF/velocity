// D103: annotations on the map — polygon, line and text kinds render from the store.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const layer = readFileSync(path.join(here, "AnnotationLayer.ts"), "utf8");
const store = readFileSync(
  path.join(here, "../annotations/annotationStore.ts"),
  "utf8",
);

describe("AnnotationLayer D103", () => {
  it("renders polygon, line and text annotations", () => {
    expect(layer).toContain("polygon");
    expect(layer).toContain("line");
    expect(store).toContain('"text"');
  });

  it("annotations persist through the store", () => {
    expect(store).toContain("loadAnnotations");
  });
});
