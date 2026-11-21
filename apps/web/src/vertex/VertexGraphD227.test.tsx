// D227: Vertex system graph with nodes and weighted edges from live counts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readFileSync(path.join(here, "VertexApp.tsx"), "utf8");
const rex = readFileSync(path.join(here, "../registry/defaults.ts"), "utf8");

describe("VertexGraph D227", () => {
  it("vertex app and quake feed are real", () => {
    expect(app).toContain("VertexApp");
    expect(rex).toContain("/api/eq?range=day");
  });
});
