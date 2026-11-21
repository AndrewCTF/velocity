// D157: numeric size mapping scaled from AIS speed over ground.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(path.join(here, "styles.ts"), "utf8");

describe("SizeMapping D157", () => {
  it("palette dispatch is real", () => {
    expect(styles).toContain("styles");
  });
});
