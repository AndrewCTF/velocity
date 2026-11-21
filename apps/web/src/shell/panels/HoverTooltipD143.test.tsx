// D143: grouped hover tooltip on series lines for two aircraft.
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

describe("HoverTooltip D143", () => {
  it("series lines render altitude and speed", () => {
    expect(obj).toContain("@Barometric altitude");
    expect(obj).toContain("@Ground speed");
    expect(panel).toContain("SelectionPanel");
  });
});
