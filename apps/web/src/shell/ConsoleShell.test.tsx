import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ConsoleShell } from "./ConsoleShell.js";
import { useSelection } from "../state/stores.js";

function Boom(): never {
  throw new Error("inspector blew up");
}

describe("ConsoleShell", () => {
  it("renders all five zones with semantic landmarks", () => {
    render(
      <ConsoleShell
        top={<div>top-zone</div>}
        left={<div>left-zone</div>}
        globe={<div data-testid="globe">globe-zone</div>}
        right={<div>right-zone</div>}
        bottom={<div>bottom-zone</div>}
      />,
    );
    expect(screen.getByText("top-zone")).toBeInTheDocument();
    expect(screen.getByText("left-zone")).toBeInTheDocument();
    expect(screen.getByText("right-zone")).toBeInTheDocument();
    expect(screen.getByText("bottom-zone")).toBeInTheDocument();
    expect(screen.getByTestId("globe")).toBeInTheDocument();

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByLabelText("Layers")).toBeInTheDocument();
    expect(screen.getByLabelText("Selection")).toBeInTheDocument();
  });

  it("fullBleed hides the right rail and collapses the footer, keeping both mounted", () => {
    render(
      <ConsoleShell
        top={<div>top-zone</div>}
        left={<div>left-zone</div>}
        globe={<div>globe-zone</div>}
        right={<div>right-zone</div>}
        bottom={<div>bottom-zone</div>}
        fullBleed
      />,
    );
    // Right rail: display:none (hidden from a11y tree + layout) but still mounted.
    const rail = screen.getByText("right-zone").closest("aside");
    expect(rail).not.toBeNull();
    expect(rail!.classList.contains("hidden")).toBe(true);
    // Footer: row collapsed + aria-hidden, Timeline stays mounted.
    const footer = screen.getByText("bottom-zone").closest("footer");
    expect(footer).not.toBeNull();
    expect(footer!.getAttribute("aria-hidden")).toBe("true");
    // The published rail width is zeroed so AppSurface stretches full width.
    const grid = document.querySelector(".csl") as HTMLElement;
    expect(grid.style.getPropertyValue("--rail-right-w")).toBe("0px");
    expect(grid.style.gridTemplateRows).toContain("0px");
  });

  it("without fullBleed the rail is visible and the footer row is 158px", () => {
    render(
      <ConsoleShell
        top={<div>top-zone</div>}
        left={<div>left-zone</div>}
        globe={<div>globe-zone</div>}
        right={<div>right-zone</div>}
        bottom={<div>bottom-zone</div>}
      />,
    );
    const rail = screen.getByLabelText("Selection");
    expect(rail.classList.contains("hidden")).toBe(false);
    const grid = document.querySelector(".csl") as HTMLElement;
    expect(grid.style.gridTemplateRows).toContain("158px");
  });

  // The inspector is the pane behind click-an-entity, the highest-traffic
  // interaction in the console. It rendered `right` raw while its own mobile
  // sibling was wrapped, so one malformed payload black-screened it with no
  // way back. The rest of the shell must survive a throwing inspector.
  describe("a throwing inspector", () => {
    afterEach(() => vi.restoreAllMocks());

    it("degrades to the panel fallback and leaves the rest of the shell up", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      render(
        <ConsoleShell
          top={<div>top-zone</div>}
          left={<div>left-zone</div>}
          globe={<div>globe-zone</div>}
          right={<Boom />}
          bottom={<div>bottom-zone</div>}
        />,
      );
      expect(screen.getByText("panel error")).toBeInTheDocument();
      // The exception text is a stack fragment, not copy: it must not render.
      expect(screen.queryByText(/inspector blew up/)).toBeNull();
      expect(screen.getByText("top-zone")).toBeInTheDocument();
      expect(screen.getByText("left-zone")).toBeInTheDocument();
      expect(screen.getByText("globe-zone")).toBeInTheDocument();
      expect(screen.getByText("bottom-zone")).toBeInTheDocument();
    });
  });
});

// The 2D map on a phone, 2026-10-18. Before: the desktop command bar was the
// phone's top row and ran 94 elements past the right edge, and panels opened
// full-screen from a floating "Panels" button. Now it is the 3D console's
// phone grammar: the map, a floating top row, a tab bar, bottom sheets.
describe("ConsoleShell on a phone", () => {
  function phone(): void {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("max-width: 767px"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    render(
      <ConsoleShell
        top={<div>top-zone</div>}
        left={<div>left-zone</div>}
        globe={<div>globe-zone</div>}
        right={<div>right-zone</div>}
        bottom={<div>bottom-zone</div>}
        phoneLead={<a href="/">lead</a>}
      />,
    );
  }
  const tab = (name: string): HTMLElement =>
    within(
      document.querySelector<HTMLElement>("nav[data-primary-nav]")!,
    ).getByRole("button", { name });

  afterEach(() => {
    act(() => useSelection.getState().select(null));
    vi.unstubAllGlobals();
  });

  it("is the map, a floating top row and a tab bar; the desktop bar and band are gone", () => {
    phone();
    expect(screen.getByText("globe-zone")).toBeInTheDocument();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByText("top-zone")).toBeNull();
    expect(screen.getByText("lead")).toBeInTheDocument();
    expect(
      [...document.querySelectorAll("nav[data-primary-nav] button")].map(
        (b) => b.textContent,
      ),
    ).toEqual(["Layers", "Selection", "Timeline", "Search"]);
  });

  it("opens the command bar as the Search sheet, from its tab or the search pill", () => {
    phone();
    fireEvent.click(tab("Search"));
    expect(screen.getByRole("region", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByText("top-zone")).toBeInTheDocument();
    fireEvent.click(tab("Search"));
    expect(screen.queryByText("top-zone")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Search places/ }));
    expect(screen.getByText("top-zone")).toBeInTheDocument();
  });

  it("keeps the timeline mounted, hidden until its tab asks", () => {
    phone();
    const node = screen.getByText("bottom-zone");
    expect(node.closest(".psheet")).toHaveAttribute("hidden");
    fireEvent.click(tab("Timeline"));
    expect(node.closest(".psheet")).not.toHaveAttribute("hidden");
    expect(screen.getByText("bottom-zone")).toBe(node);
  });

  it("raises the Selection sheet to a peek when a contact is picked", () => {
    phone();
    act(() => useSelection.getState().select("aircraft:abc123"));
    expect(screen.getByRole("region", { name: "Selection" })).toHaveAttribute(
      "data-detent",
      "peek",
    );
    act(() => useSelection.getState().select(null));
    expect(screen.queryByRole("region", { name: "Selection" })).toBeNull();
  });
});
