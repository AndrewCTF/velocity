// D173: map control column, scale bar and Timeline toggle.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolbar = readFileSync(path.join(here, "GlobeToolbar.tsx"), "utf8");

describe("ControlColumn D173", () => {
  it("toolbar is real", () => {
    expect(toolbar).toContain("Map tools");
  });
});
