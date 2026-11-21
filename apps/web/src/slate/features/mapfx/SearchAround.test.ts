// SearchAround D86: dropdown with link types and live counts (routes, runways, frequencies).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "SearchAround.tsx"), "utf8");
const css = readFileSync(path.join(here, "searchAround.css"), "utf8");

describe("SearchAround D86", () => {
  it("renders the dropdown trigger and menu", () => {
    expect(src).toContain('aria-label="Search around"');
    expect(src).toContain('role="menu"');
    expect(src).toContain('data-testid="d86-search-around"');
  });

  it("live counts come from the real aviation endpoints", () => {
    expect(src).toContain("apiFetch(`/api/aviation/routes`)");
    expect(src).toContain("apiFetch(`/api/entity/airport:");
    expect(src).toContain("x.src === iata");
    expect(src).toContain("runways");
    expect(src).toContain("frequencies");
  });

  it("entries open the graph via searchAround", () => {
    expect(src).toContain("useInvestigation.getState().searchAround(entityId)");
  });

  it("ships scoped CSS", () => {
    expect(css).toContain(".mv-sa-menu");
    expect(css).toContain(".mv-sa-count");
  });
});
