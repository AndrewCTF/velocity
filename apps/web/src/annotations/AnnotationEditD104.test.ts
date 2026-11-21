// D104: annotation selection — editable title (label) and notes (note).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, "AnnotationPanel.tsx"), "utf8");
const store = readFileSync(path.join(here, "annotationStore.ts"), "utf8");

describe("AnnotationEdit D104", () => {
  it("label is editable on the draft, note is the stored field", () => {
    expect(panel).toContain("draft.label");
    expect(panel).toContain("Label (optional)");
    expect(store).toContain("note?: string");
  });

  it("the update path writes both fields", () => {
    expect(store).toContain("update: (id: string, patch:");
  });
});
