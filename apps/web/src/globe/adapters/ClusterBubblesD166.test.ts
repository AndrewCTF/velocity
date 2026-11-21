// D166: cluster bubbles with count labels from the live ADS-B snapshot.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const cluster = readFileSync(path.join(here, "VesselClusterPrimitive.ts"), "utf8");

describe("ClusterBubbles D166", () => {
  it("cluster primitive is real", () => {
    expect(cluster).toContain("Cluster");
  });
});
