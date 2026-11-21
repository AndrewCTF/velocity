import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding, OnboardingHint, hasOnboarded } from "./Onboarding.js";

// A first visit on a Pixel 7 was blocked by a modal tour whose Skip button was
// 39x20, then by the local-AI wizard. On a phone the tour is a hint over the
// map: no dialog role, no backdrop, one 44px button, and it still counts as the
// tour having been seen. The tour itself is unchanged above the breakpoint.

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("OnboardingHint", () => {
  it("is a status over the map, not a dialog", () => {
    render(<OnboardingHint onClose={() => {}} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[aria-modal]")).toBeNull();
  });

  // It is shown on "/" (a tab bar) and on "/2d" (a Panels button), so it
  // names where the controls are, which is true of both, not a control name.
  it("says where the panels are, with no em dash", () => {
    render(<OnboardingHint onClose={() => {}} />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/bottom of the screen/);
    expect(text).not.toContain("—");
  });

  it("Got it closes it and remembers, so it does not come back", () => {
    const onClose = vi.fn();
    render(<OnboardingHint onClose={onClose} />);
    expect(hasOnboarded()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(hasOnboarded()).toBe(true);
  });
});

describe("Onboarding (above the breakpoint)", () => {
  it("is still the modal tour", () => {
    render(<Onboarding onClose={() => {}} />);
    expect(
      screen.getByRole("dialog", { name: "Welcome to Velocity" }),
    ).toHaveAttribute("aria-modal", "true");
  });
});
