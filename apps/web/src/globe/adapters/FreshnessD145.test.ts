// D145: opacity by freshness — full while fresh, 0.45 after 120 s stale.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const fresh = readFileSync(path.join(here, "freshness.ts"), "utf8");

describe("Freshness D145", () => {
  it("stale rule is 120 s at 0.45 opacity", () => {
    expect(fresh).toContain("FRESH_POS_S = 120");
    expect(fresh).toContain("STALE_ALPHA = 0.45");
  });
});
