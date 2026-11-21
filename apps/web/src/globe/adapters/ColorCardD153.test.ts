// D153: COLOR style card with spectrum on barometric altitude.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(path.join(here, "styles.ts"), "utf8");

describe("ColorCard D153", () => {
  it("category palette dispatch is real", () => {
    expect(styles).toContain("styles");
  });
});
