// WorkshopApp renders widgets from real endpoints, persists module edits, and
// keeps the HTTP code when an endpoint fails. apiFetch is mocked at the boundary.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkshopApp } from "./WorkshopApp.js";

vi.mock("../transport/http.js", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../transport/http.js";
const mockedFetch = vi.mocked(apiFetch);

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe("WorkshopApp", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    localStorage.clear();
  });

  it("renders the live count, the empty maps sentence, and a filtered table", async () => {
    mockedFetch.mockImplementation(async (path: string) => {
      if (path === "/api/status") return json({ aircraft_count: 16308 });
      if (path === "/api/maps") return json([]);
      if (path.startsWith("/api/history/timeseries"))
        return json({ bucket_sec: 60, buckets: [], degraded: true });
      return json({
        total: 2,
        categories: ["sar", "space"],
        sources: [
          { category: "sar", name: "Sentinel-1", auth: "none" },
          { category: "space", name: "CelesTrak", auth: "none" },
        ],
      });
    });
    render(<WorkshopApp />);
    await waitFor(() => expect(screen.getByText("16308")).toBeTruthy());
    expect(await screen.findByText("No saved maps yet (HTTP 200, 0 maps).")).toBeTruthy();
    expect(screen.getByText(/History is off in this profile \(HTTP 200, degraded\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Source table" }));
    expect(await screen.findByText("CelesTrak")).toBeTruthy();
    fireEvent.change(await screen.findByDisplayValue("All categories"), { target: { value: "sar" } });
    await waitFor(() => expect(screen.queryByText("CelesTrak")).toBeNull());
    expect(screen.getByText("Sentinel-1")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Module name"), { target: { value: "Watch floor" } });
    const saved = JSON.parse(localStorage.getItem("velocity.workshop.modules.v1")!) as { name: string; widgets: unknown[] }[];
    expect(saved[0]!.name).toBe("Watch floor");
    expect(saved[0]!.widgets.length).toBe(4);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.queryByLabelText("Module name")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("keeps the HTTP code when status fails", async () => {
    mockedFetch.mockImplementation(async (path: string) =>
      path === "/api/status" ? json({}, 503) : json([]),
    );
    render(<WorkshopApp />);
    expect(await screen.findByText("Platform status unavailable (HTTP 503).")).toBeTruthy();
  });
});
