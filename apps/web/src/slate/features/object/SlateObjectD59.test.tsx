// D59: Selection drill-down — Back to list, series rows, series menu.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "SlateObject.tsx"), "utf8");
const css = readFileSync(path.join(here, "object.css"), "utf8");
const shell = readFileSync(path.join(here, "../../SlateShell.tsx"), "utf8");

describe("SlateObject D59", () => {
  it("renders Back to list above the object header", () => {
    expect(src).toContain('data-testid="d59-back-to-list"');
    expect(src).toContain("Back to list");
    expect(shell).toContain("onBackToList={() => setObjOpen(false)}");
  });

  it("series rows are the ADS-B fields the feed carries", () => {
    expect(src).toContain("@Barometric altitude");
    expect(src).toContain("@Ground speed");
    expect(src).toContain("@Track");
    expect(src).toContain('data-testid="d59-series-rows"');
  });

  it("the series menu trigger exists", () => {
    expect(src).toContain('data-testid="d59-series-menu"');
    expect(src).toContain('aria-label="Series menu"');
  });

  it("D59 styles are scoped under .slate-shell", () => {
    expect(css).toContain(".sl-back-to-list");
    expect(css).toContain(".sl-series-rows");
    expect(css).toContain(".sl-series-more");
  });
});
