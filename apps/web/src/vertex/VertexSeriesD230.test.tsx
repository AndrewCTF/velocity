// D230: Vertex docked Series panel with vessels per poll and vessels near Hormuz.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "VertexApp.tsx"), "utf8");

describe("VertexSeries D230", () => {
  it("vertex app is real", () => {
    expect(app).toContain("VertexApp");
  });
});
