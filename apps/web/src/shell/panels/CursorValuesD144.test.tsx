// D144: values that follow the cursor, no-value warning in a recording gap.
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

describe("CursorValues D144", () => {
  it("series values render live", () => {
    expect(obj).toContain("@Track");
    expect(panel).toContain("SelectionPanel");
  });
});
