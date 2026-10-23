// QuiverApp draws real buckets from GET /api/history/timeseries and keeps the
// reason when the archive is off. apiFetch is mocked at the transport boundary.
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuiverApp } from "./QuiverApp.js";

vi.mock("../transport/http.js", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../transport/http.js";
const mockedFetch = vi.mocked(apiFetch);

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe("QuiverApp", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    localStorage.clear();
  });

  it("renders the latest bucket, its delta and the archive stats", async () => {
    mockedFetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/history/timeseries"))
        return json({
          bucket_sec: 60,
          buckets: [
            { t: 1792719000, aircraft: 100, vessel: 10, total: 110 },
            { t: 1792719060, aircraft: 120, vessel: 12, total: 132 },
          ],
        });
      return json({ enabled: true, backend: "sqlite", retention_hours: 168 });
    });
    const { container } = render(<QuiverApp />);
    await waitFor(() => expect(screen.getAllByText("132").length).toBeGreaterThan(0));
    expect(screen.getByText("+22")).toBeTruthy();
    expect(screen.getByText("sqlite")).toBeTruthy();
    expect(screen.getByText("168 h")).toBeTruthy();
    expect(container.querySelector("svg path")).not.toBeNull();
  });

  it("states the degraded reason and the HTTP code instead of drawing", async () => {
    mockedFetch.mockImplementation(async (path: string) =>
      path.startsWith("/api/history/timeseries")
        ? json({ bucket_sec: 60, buckets: [], degraded: true })
        : json({}, 503),
    );
    render(<QuiverApp />);
    await waitFor(() =>
      expect(screen.getAllByText(/History is off in this profile \(HTTP 200, degraded\)/).length).toBe(2),
    );
    expect(screen.getByText("Archive stats unavailable (HTTP 503).")).toBeTruthy();
  });
});
