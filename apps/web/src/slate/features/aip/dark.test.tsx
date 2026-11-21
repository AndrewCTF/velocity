// The dark AIP pages: pure layout maths, stage grouping, and that every
// rendered control either runs or says why it cannot.
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../../transport/http.js", () => ({
  apiFetch: vi.fn(
    async () => new Response(JSON.stringify({ detail: "x" }), { status: 503 }),
  ),
}));
vi.mock("./plateGlobe.jpg", () => ({ default: "g.jpg" }));
vi.mock("./sceneHormuz.jpg", () => ({ default: "s.jpg" }));

import { BoardView, stageGroups } from "./Board.js";
import { TitanView } from "./Titan.js";
import { MapView, coverK } from "./MapApp.js";
import type { WItem } from "./dataB.js";

const item = (kind: WItem["kind"], id: string): WItem => ({
  kind,
  id,
  title: id,
  link: "",
  icon: "ship",
  shape: "c",
  color: "#fff",
  t: 0,
  ll: [56, 26],
  ref: id,
});

describe("stageGroups", () => {
  it("places kinds in their recorded stage and sorts the biggest group first", () => {
    const items = [
      item("sar", "a"),
      item("jam", "b"),
      item("sar", "c"),
      item("quake", "d"),
      item("ofac", "e"),
      item("ofac", "f"),
    ];
    expect(stageGroups(items, 0).map(([n, v]) => [n, v.length])).toEqual([
      ["SAR dark candidates", 2],
      ["GPS jamming", 1],
    ]);
    expect(stageGroups(items, 1).map(([n, v]) => [n, v.length])).toEqual([
      ["Registry matches", 2],
      ["Earthquakes", 1],
    ]);
    expect(stageGroups(items, 2)).toEqual([]);
  });
});

describe("map plate", () => {
  it("covers the pane at every size and keeps the centre at the pane centre", () => {
    for (const [w, h] of [
      [900, 500],
      [1800, 1250],
      [2200, 1300],
    ] as const) {
      const k = coverK(w, h, 1494, 816);
      expect(k * 1494).toBeGreaterThanOrEqual(w - 1e-6);
      expect(k * 816).toBeGreaterThanOrEqual(h - 1e-6);
      expect(new MapView(w, h, 700, 760, k).px(700, 760)).toEqual([
        w / 2,
        h / 2,
      ]);
    }
  });
  it("inside() is pane-relative, with a margin", () => {
    const v = new MapView(100, 50, 0, 0, 1);
    expect(v.inside(1, 1)).toBe(true);
    expect(v.inside(100, 25)).toBe(false);
    expect(v.inside(5, 5, 10)).toBe(false);
  });
});

describe("dark pages", () => {
  it("board reaches the other pages and gives a reason for each dead control", () => {
    const seen: string[] = [];
    render(<BoardView nav={(v) => seen.push(v)} />);
    fireEvent.click(screen.getByRole("button", { name: "Open the map" }));
    fireEvent.click(screen.getByRole("button", { name: "Ground station" }));
    expect(seen).toEqual(["map", "titan"]);
    expect(
      screen
        .getByRole("button", { name: "Target board" })
        .getAttribute("aria-current"),
    ).toBe("page");
    cleanup();
  });
  it("ground station tabs switch and Power management says why it is off", () => {
    render(<TitanView nav={() => {}} />);
    const power = screen.getByRole("tab", {
      name: /Power management/,
    }) as HTMLButtonElement;
    expect(power.disabled).toBe(true);
    expect(power.title).toMatch(/power-management/);
    fireEvent.click(screen.getByRole("tab", { name: /Software management/ }));
    expect(
      screen
        .getByRole("tab", { name: /Software management/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    cleanup();
  });
});
