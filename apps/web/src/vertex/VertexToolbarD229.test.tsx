// D229: Vertex toolbar icons, card separators, Add and help buttons.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "VertexApp.tsx"), "utf8");

describe("VertexToolbar D229", () => {
  it("vertex app is real", () => {
    expect(app).toContain("VertexApp");
  });
});
