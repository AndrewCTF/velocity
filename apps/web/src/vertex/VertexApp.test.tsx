// VertexApp draws the real feed -> layer edges from /api/status and the layer
// registry, inspects a node, and keeps the HTTP code when the catalog fails.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VertexApp } from "./VertexApp.js";

vi.mock("../transport/http.js", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../transport/http.js";
const mockedFetch = vi.mocked(apiFetch);

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const STATUS = {
  aircraft_count: 16308,
  vessel_count: 70697,
  parked_count: 20000,
  feeds: [
    { name: "ADS-B aircraft (grid)", status: "green", count: 16308, age_s: 1.4 },
    { name: "Made-up feed", status: "unknown" },
  ],
};
const SERIES = {
  bucket_sec: 300,
  buckets: [
    { t: 1792719000, aircraft: 16253, vessel: 4070, total: 20323 },
    { t: 1792719300, aircraft: 16093, vessel: 2742, total: 18835 },
  ],
};

describe("VertexApp", () => {
  beforeEach(() => {
    mockedFetch.mockReset(); // braces: a returned function would run as a cleanup hook
  });

  it("links the ADS-B feed only to the layer polling its endpoint", async () => {
    mockedFetch.mockImplementation(async (path: string) => {
      if (path === "/api/status") return json(STATUS);
      if (path.startsWith("/api/history/timeseries")) return json(SERIES);
      return json({ total: 1, categories: ["sar"], sources: [{ category: "sar", name: "S1", auth: "none" }] });
    });
    const { container } = render(<VertexApp />);
    await waitFor(() =>
      expect(container.querySelector('[data-edge="feed:0>layer:aviation.adsb.global"]')).not.toBeNull(),
    );
    expect(container.querySelectorAll("[data-edge]").length).toBe(1);
    expect(container.querySelector('[data-edge^="feed:1"]')).toBeNull();
    await waitFor(() => expect(screen.getByText("20323")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "ADS-B aircraft (grid)" }));
    expect(screen.getByText("16308")).toBeTruthy();
    expect(screen.getByText("16253")).toBeTruthy();
    expect(screen.getByLabelText("aircraft per 5 min bucket").querySelector("path")).not.toBeNull();
    expect(screen.getByText("Layers fed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Made-up feed" }));
    expect(screen.getByText("not reported")).toBeTruthy();
    expect(screen.getByText(/Made-up feed has no recorded series/)).toBeTruthy();
  });

  it("states the catalog failure with its HTTP code", async () => {
    mockedFetch.mockImplementation(async (path: string) =>
      path === "/api/sources/catalog" ? json({}, 503) : path === "/api/status" ? json(STATUS) : json(SERIES),
    );
    render(<VertexApp />);
    await waitFor(() => expect(screen.getByText("Source catalog unavailable (HTTP 503).")).toBeTruthy());
  });
});
