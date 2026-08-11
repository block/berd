import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionCardActionButton } from "@/shared/ui/session-card-action-button";

/**
 * These assert the recipe's class contract rather than computed styles: jsdom
 * does not evaluate Tailwind, so `group-hover:` / `data-[state=open]:` variants
 * never resolve. What is worth guarding is that the wrapper — not the caller —
 * is the thing carrying each state.
 */
describe("SessionCardActionButton", () => {
  const getButton = () => screen.getByRole("button", { name: "Options" });

  it("keeps the named icon-xs geometry instead of shrinking the hit target", () => {
    render(<SessionCardActionButton aria-label="Options" />);

    expect(getButton()).toHaveClass("h-7", "w-7");
    expect(getButton().className).not.toMatch(/\bsize-5\b/);
  });

  it("rests hidden and out of reach until the card is engaged", () => {
    render(<SessionCardActionButton aria-label="Options" />);

    expect(getButton()).toHaveClass("invisible", "opacity-0");
  });

  it("reveals on card hover and on focus within the card", () => {
    render(<SessionCardActionButton aria-label="Options" />);

    expect(getButton()).toHaveClass(
      "group-hover:visible",
      "group-hover:opacity-100",
      "group-focus-within:visible",
      "group-focus-within:opacity-100",
    );
  });

  it("stays revealed while its menu is open", () => {
    render(<SessionCardActionButton aria-label="Options" open />);

    expect(getButton()).toHaveClass("visible", "opacity-100");
    expect(getButton()).not.toHaveClass("invisible");
    expect(getButton()).not.toHaveClass("opacity-0");
  });

  it("also honors an uncontrolled Radix trigger's own open state", () => {
    render(<SessionCardActionButton aria-label="Options" />);

    expect(getButton()).toHaveClass(
      "data-[state=open]:visible",
      "aria-expanded:visible",
    );
  });

  it("owns its color states so the theme stays with the design system", () => {
    render(<SessionCardActionButton aria-label="Options" />);

    // From ghost + icon-xs: token colors, no fill in any state.
    expect(getButton()).toHaveClass(
      "text-muted-foreground",
      "hover:text-foreground",
      "data-[state=open]:text-foreground",
      "bg-transparent",
      "hover:bg-transparent",
    );
  });

  it("lets callers add positioning without losing the recipe", () => {
    render(
      <SessionCardActionButton
        aria-label="Options"
        className="absolute right-6 top-6 z-10"
      />,
    );

    expect(getButton()).toHaveClass("absolute", "right-6", "top-6", "z-10");
    expect(getButton()).toHaveClass("invisible", "text-muted-foreground");
  });

  it("defaults to type=button so it never submits a surrounding form", () => {
    render(<SessionCardActionButton aria-label="Options" />);

    expect(getButton()).toHaveAttribute("type", "button");
  });
});
