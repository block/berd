import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IconArrowDown, IconArrowNarrowLeft } from "@tabler/icons-react";
import { Button } from "./button";

describe("Button", () => {
  it("applies the button size to unsized icons", () => {
    render(
      <Button size="sm" leftIcon={<IconArrowNarrowLeft data-testid="icon" />}>
        Back
      </Button>,
    );

    expect(screen.getByTestId("icon")).toHaveClass("size-3");
  });

  it("preserves an explicit icon class size", () => {
    render(
      <Button
        size="sm"
        leftIcon={<IconArrowNarrowLeft data-testid="icon" className="size-4" />}
      >
        Back
      </Button>,
    );

    expect(screen.getByTestId("icon")).toHaveClass("size-4");
    expect(screen.getByTestId("icon")).not.toHaveClass("size-3");
  });

  it("preserves an explicit icon size prop", () => {
    render(
      <Button
        size="sm"
        leftIcon={<IconArrowNarrowLeft data-testid="icon" size={18} />}
      >
        Back
      </Button>,
    );

    expect(screen.getByTestId("icon")).toHaveAttribute("width", "18");
    expect(screen.getByTestId("icon")).toHaveAttribute("height", "18");
    expect(screen.getByTestId("icon")).not.toHaveClass("size-3");
  });

  it("sets a default nested svg size for icon-only buttons", () => {
    render(
      <Button size="icon-xs" aria-label="Back">
        <IconArrowNarrowLeft data-testid="icon" />
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Back" });

    expect(screen.getByTestId("icon")).toHaveClass("size-3");
    expect(button.className).toContain(
      "[&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-3",
    );
  });

  it("applies icon button sizing to arrow icons with width-like icon names", () => {
    render(
      <Button size="icon-sm" aria-label="Jump to latest">
        <IconArrowDown data-testid="icon" />
      </Button>,
    );

    expect(screen.getByTestId("icon")).toHaveClass("size-3.5");
  });

  it("preserves explicit child icon class size on icon-only buttons", () => {
    render(
      <Button size="icon-sm" aria-label="Jump to latest">
        <IconArrowDown data-testid="icon" className="size-4" />
      </Button>,
    );

    expect(screen.getByTestId("icon")).toHaveClass("size-4");
    expect(screen.getByTestId("icon")).not.toHaveClass("size-3.5");
  });

  it("keeps child icons and labels as one inline button row", () => {
    render(
      <Button>
        <IconArrowNarrowLeft data-testid="child-icon" />
        <span>Settings</span>
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Settings" });

    expect(button.firstElementChild).toBe(screen.getByTestId("child-icon"));
    expect(button).toHaveClass("inline-flex", "items-center", "gap-2");
  });

  it("keeps preserve-width child icons and labels in an inline row", () => {
    render(
      <Button preserveWidth>
        <IconArrowNarrowLeft data-testid="child-icon" />
        <span>Settings</span>
      </Button>,
    );

    const activeFeedbackLayer =
      screen.getAllByTestId("child-icon")[0].parentElement;

    expect(activeFeedbackLayer).toHaveClass(
      "inline-flex",
      "items-center",
      "gap-2",
      "whitespace-nowrap",
    );
  });

  it("renders the back variant with its default chevron icon", () => {
    render(
      <Button variant="back" size="sm">
        Back
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Back" });
    const icon = button.querySelector("svg");

    expect(button).toHaveClass(
      "h-8",
      "px-0",
      "text-xs",
      "text-muted-foreground",
    );
    expect(icon).not.toBeNull();
    expect(icon).toHaveClass("size-3");
  });

  it("renders the strong glass variant with strong glass tokens", () => {
    render(<Button variant="glass-strong">View</Button>);

    const button = screen.getByRole("button", { name: "View" });
    expect(button).toHaveClass(
      "bg-surface-glass-strong",
      "text-surface-glass-strong-fg",
      "hover:bg-surface-glass-strong-hover",
    );
  });

  it("disables and marks the button busy while loading", () => {
    render(
      <Button
        feedbackState="loading"
        loadingLabel="Saving"
        loadingVisual="text"
      >
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Saving" });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("data-feedback-state", "loading");
  });

  it("renders success feedback through the main button", () => {
    render(
      <Button feedbackState="success" successLabel="Saved">
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Saved" });

    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("data-feedback-state", "success");
  });

  it("renders feedback inside an asChild target", () => {
    const onClick = vi.fn();

    render(
      <Button
        asChild
        feedbackState="loading"
        loadingLabel="Opening"
        onClick={onClick}
      >
        <a href="/settings">Settings</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Opening" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });

    expect(link).toHaveAttribute("aria-busy", "true");
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).toHaveAttribute("data-feedback-state", "loading");
    expect(link).toHaveClass("pointer-events-none");
    expect(link.dispatchEvent(event)).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("preserves asChild click handlers when idle", () => {
    const onClick = vi.fn();

    render(
      <Button asChild onClick={onClick}>
        <a href="#settings">Settings</a>
      </Button>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Settings" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
