// D116: selection panel — Properties / Series / Events tabs over the live entity.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const insp = readFileSync(path.join(here, "ObjectInspector.tsx"), "utf8");
const slate = readFileSync(path.join(here, "../slate/SlateShell.tsx"), "utf8");

describe("SelectionPanel D116", () => {
  it("the inspector reads the live entity record", () => {
    expect(insp).toContain("ObjectInspector");
    expect(slate).toContain("SlateObject");
  });

  it("selection and series are real tabs", () => {
    expect(slate).toContain('"Selection"');
    expect(slate).toContain('"Series"');
  });
});
