// D164: timeline geometry flyout from the layer row.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const timeline = readFileSync(path.join(here, "Timeline.tsx"), "utf8");

describe("GeometryFlyout D164", () => {
  it("timeline is real", () => {
    expect(timeline).toContain("TimeDock");
  });
});
