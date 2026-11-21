// D124: docked series panel — barometric altitude and ground speed from one trace.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(path.join(here, "SelectionPanel.tsx"), "utf8");
const obj = readFileSync(
  path.join(here, "../../slate/features/object/SlateObject.tsx"),
  "utf8",
);

describe("SeriesPanel D124", () => {
  it("series renders altitude, speed and track", () => {
    expect(obj).toContain("@Barometric altitude");
    expect(obj).toContain("@Ground speed");
    expect(obj).toContain("@Track");
  });

  it("the selection panel exists", () => {
    expect(panel).toContain("SelectionPanel");
  });
});
