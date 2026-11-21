// D94: draw mode bar with inline instruction (each tool names its next click).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolbar = readFileSync(path.join(here, "GlobeToolbar.tsx"), "utf8");

describe("DrawBar D94", () => {
  it("each tool carries an inline instruction", () => {
    expect(toolbar).toContain('hint: "Click points for a running distance');
    expect(toolbar).toContain('hint: "Click two corners for a box');
    expect(toolbar).toContain('hint: "Click the map to drop labelled markers"');
  });

  it("the instruction renders on the tool buttons", () => {
    expect(toolbar).toContain("title={`${t.label} · ${t.hint}`}");
  });
});
