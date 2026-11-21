import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { setLiveLayersHidden } from "../globe/liveVisibility.js";
import { TitleBar } from "./TitleBar.js";

// The document line said "live" over a replay of 2025: it read the clock's
// play state, and a replay plays too.

afterEach(() => act(() => setLiveLayersHidden(false)));

describe("TitleBar document line", () => {
  it("says replay while a replay owns the map, and live again after", () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <TitleBar />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("live")).toBeInTheDocument();
    act(() => setLiveLayersHidden(true));
    expect(screen.getByText("replay")).toBeInTheDocument();
    expect(screen.queryByText("live")).toBeNull();
    act(() => setLiveLayersHidden(false));
    expect(screen.getByText("live")).toBeInTheDocument();
  });
});
