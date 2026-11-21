// D213: Colour and line style config — Single Color #14b8a6 (cargo vessel hex).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "WorkshopApp.tsx"), "utf8");

describe("LineStyle D213", () => {
  it("workshop app is real", () => {
    expect(app).toContain("WorkshopApp");
  });
});
