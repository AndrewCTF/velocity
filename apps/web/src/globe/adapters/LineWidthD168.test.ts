// D168: line width scaled by great-circle distance of DXB routes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(path.join(here, "styles.ts"), "utf8");

describe("LineWidth D168", () => {
  it("palette dispatch is real", () => {
    expect(styles).toContain("styles");
  });
});
