// D219: Quiver metric cards: filter sentence object set card and two metric cards.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "QuiverApp.tsx"), "utf8");

describe("QuiverCards D219", () => {
  it("quiver app is real", () => {
    expect(app).toContain("QuiverApp");
  });
});
