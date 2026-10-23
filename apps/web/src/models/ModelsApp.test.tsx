// ModelsApp renders the registry from GET /api/ai/models and says so plainly
// when nothing is installed. apiFetch is mocked at the transport boundary.
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsApp } from "./ModelsApp.js";
import type { ModelsResponse } from "../settings/localAi/types.js";

vi.mock("../transport/http.js", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../transport/http.js";
const mockedFetch = vi.mocked(apiFetch);

function json(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

const engines = {
  llamacpp: { installed: true, version: "9964", running: false },
  vllm: { installed: false, version: null, running: false },
  ollama: { installed: true, version: null, running: true },
};

function route(models: ModelsResponse | null, status = 200): void {
  mockedFetch.mockImplementation(async (path: string) => {
    if (path === "/api/ai/models") return json(models, status);
    return json({}, 404);
  });
}

describe("ModelsApp", () => {
  beforeEach(() => mockedFetch.mockReset());

  it("lists installed models and shows the selected one's detail", async () => {
    route({
      engines,
      active: { main: "k1", selection: null },
      hot: [],
      installed: [
        {
          key: "k1",
          repo_id: "unsloth/Qwen3.5-9B-GGUF",
          quant: "UD-Q4_K_XL",
          filename: "q.gguf",
          size_bytes: 6 * 1024 ** 3,
          tier: "8b",
          roles: ["main"],
          hot: false,
        },
      ],
      catalog: [],
    });
    render(<ModelsApp />);
    await waitFor(() =>
      expect(screen.getAllByText("unsloth/Qwen3.5-9B-GGUF").length).toBeGreaterThan(1),
    );
    expect(screen.getAllByText("6.0 GB").length).toBeGreaterThan(0);
  });

  it("says nothing is installed, and keeps the HTTP code on failure", async () => {
    route({ engines, active: { main: null, selection: null }, hot: [], installed: [], catalog: [] });
    const { unmount } = render(<ModelsApp />);
    await waitFor(() => expect(screen.getByText(/No models installed yet/)).toBeTruthy());
    unmount();
    route(null, 503);
    render(<ModelsApp />);
    await waitFor(() => expect(screen.getByText(/HTTP 503/)).toBeTruthy());
  });
});
