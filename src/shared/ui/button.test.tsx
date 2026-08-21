import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IconArrowDown, IconArrowNarrowLeft } from "@tabler/icons-react";
import { AgentTileButton } from "./agent-tile-button";
import { Button } from "./button";
import { CanvasNavButton } from "./canvas-nav-button";
import { ComposerActionButton } from "./composer-action-button";
import { GlassButton } from "./glass-button";
import { JumpToLatestButton } from "./jump-to-latest-button";
import { TopBarIconButton } from "./top-bar-icon-button";

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

  it("supports compact 24px icon-only buttons", () => {
    render(
      <Button size="icon-xxs" aria-label="Close">
        <IconArrowNarrowLeft data-testid="icon" />
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
      "h-6",
      "w-6",
    );
    expect(screen.getByTestId("icon")).toHaveClass("size-3.5");
  });

  it("applies icon button sizing to arrow icons with width-like icon names", () => {
    render(
      <Button size="icon-sm" aria-label="Jump to latest">
        <IconArrowDown data-testid="icon" />
      </Button>,
    );

    expect(screen.getByTestId("icon")).toHaveClass("size-3.5");
  });

  it("applies top-bar icon sizing through the shared icon button logic", () => {
    render(
      <TopBarIconButton aria-label="Search">
        <IconArrowDown data-testid="icon" />
      </TopBarIconButton>,
    );

    const button = screen.getByRole("button", { name: "Search" });

    expect(button.className).toContain(
      "size-[var(--spacing-app-top-bar-control)]",
    );
    expect(button.className).toContain(
      "[&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-[length:var(--text-app-top-bar-icon)]",
    );
    expect(screen.getByTestId("icon")).toHaveClass(
      "size-[length:var(--text-app-top-bar-icon)]",
    );
  });

  it("applies pill icon button sizing from the size variant", () => {
    render(
      <Button size="icon-pill-sm" aria-label="Send">
        <IconArrowDown data-testid="icon" />
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Send" });

    expect(button).toHaveClass("h-8", "w-10");
    expect(screen.getByTestId("icon")).toHaveClass("size-4");
  });

  it("keeps the jump-to-latest label unselectable", () => {
    render(<JumpToLatestButton>Jump to latest</JumpToLatestButton>);

    expect(screen.getByRole("button", { name: "Jump to latest" })).toHaveClass(
      "select-none",
    );
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

  it("renders the composer action chrome recipe over the subtle base", () => {
    render(<ComposerActionButton>Branch</ComposerActionButton>);

    const button = screen.getByRole("button", { name: "Branch" });
    expect(button).toHaveClass(
      "bg-surface-composer-action",
      "hover:bg-surface-composer-action-hover",
      "active:bg-surface-composer-action-active",
    );
  });

  it("disables active feedback animation for reduced motion", () => {
    render(
      <ComposerActionButton visualState="active">
        Listening
      </ComposerActionButton>,
    );

    expect(screen.getByRole("button", { name: "Listening" })).toHaveClass(
      "animate-pulse",
      "motion-reduce:animate-none",
    );
  });

  it("owns destructive composer action interaction states", () => {
    render(
      <ComposerActionButton visualState="destructive">
        Hang up
      </ComposerActionButton>,
    );

    expect(screen.getByRole("button", { name: "Hang up" })).toHaveClass(
      "bg-destructive",
      "hover:bg-destructive/90",
      "active:bg-destructive/90",
    );
  });

  it("renders the alert variant inheriting the surrounding alert color", () => {
    render(<Button variant="alert">Edit project</Button>);

    const button = screen.getByRole("button", { name: "Edit project" });
    expect(button).toHaveClass(
      "border-current/30",
      "bg-transparent",
      "text-current",
      "hover:bg-current/10",
    );
  });

  it("renders the strong glass recipe over the subtle base", () => {
    render(<GlassButton>View</GlassButton>);

    const button = screen.getByRole("button", { name: "View" });
    expect(button).toHaveClass(
      "bg-surface-glass-strong",
      "text-surface-glass-strong-fg",
      "backdrop-blur-md",
    );
  });

  it("renders the canvas nav recipe over the primary base", () => {
    render(<CanvasNavButton aria-label="Close">×</CanvasNavButton>);

    const button = screen.getByRole("button", { name: "Close" });
    // The primary base owns fill, hover, focus, and disabled behavior; the
    // recipe only adds the floating chrome (shadow, unselectable label).
    expect(button).toHaveClass(
      "bg-primary",
      "text-primary-foreground",
      "select-none",
      "shadow-[var(--shadow-chat)]",
    );
  });

  it("renders the agent tile chrome recipe over the subtle base", () => {
    render(<AgentTileButton>View</AgentTileButton>);

    const button = screen.getByRole("button", { name: "View" });
    expect(button).toHaveClass(
      "bg-surface-agent-tile-action-bg",
      "text-surface-agent-tile-action-fg",
      "hover:bg-surface-agent-tile-action-bg-hover",
      "hover:text-surface-agent-tile-action-fg-hover",
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

  it("keeps a tooltip reachable when the button is disabled", async () => {
    const user = userEvent.setup();
    render(
      <Button disabled tooltip="Unavailable while saving">
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    const tooltipTrigger = button.parentElement;

    expect(tooltipTrigger).not.toBeNull();
    if (!tooltipTrigger) throw new Error("Expected a tooltip trigger wrapper");

    expect(button).toBeDisabled();
    expect(tooltipTrigger).toHaveAttribute("data-button-tooltip-trigger", "");
    expect(tooltipTrigger).toHaveAttribute("tabindex", "0");
    expect(tooltipTrigger).toHaveAttribute("aria-disabled", "true");
    expect(tooltipTrigger).toHaveAccessibleName("Unavailable while saving");

    await user.hover(tooltipTrigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Unavailable while saving",
    );
  });

  it("uses a caller-provided accessible name on a disabled tooltip wrapper", () => {
    render(
      <Button disabled tooltip="Unavailable" aria-label="Save changes">
        Save
      </Button>,
    );

    expect(
      screen.getByRole("button", { name: "Save changes" }).parentElement,
    ).toHaveAccessibleName("Save changes");
  });

  it("preserves an explicit tab order on a disabled tooltip wrapper", () => {
    render(
      <Button disabled tooltip="Unavailable" tabIndex={-1}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.parentElement).toHaveAttribute("tabindex", "-1");
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

  it("keeps aria-disabled buttons focusable while blocking clicks", () => {
    const onClick = vi.fn();

    render(
      <Button aria-disabled="true" onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });

    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
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

describe("destructive intent flag", () => {
  it("applies the red fill recipe on primary", () => {
    render(
      <Button variant="primary" destructive>
        Delete
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
      "bg-destructive",
      "text-destructive-foreground",
      "hover:bg-destructive/90",
    );
  });

  it("applies the quiet red recipe on ghost", () => {
    render(
      <Button variant="ghost" destructive>
        Delete
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
      "text-destructive",
      "hover:bg-destructive/10",
      "hover:text-destructive",
    );
  });

  it("applies the red border recipe on outline", () => {
    render(
      <Button variant="outline" destructive>
        Delete
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
      "border-destructive/30",
      "text-destructive",
      "hover:bg-destructive/8",
    );
  });

  it("ignores the flag on unsupported variants", () => {
    render(
      <Button variant="link" destructive>
        Remove
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Remove" });
    expect(button).not.toHaveClass("text-destructive");
    expect(button).toHaveClass("text-primary");
  });
});

describe("flush recipe flag", () => {
  it("applies the text-raise recipe on ghost", () => {
    render(
      <Button variant="ghost" flush>
        Show more
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Show more" })).toHaveClass(
      "text-muted-foreground",
      "hover:bg-transparent",
      "hover:text-foreground",
    );
  });

  it("ignores flush on unsupported variants", () => {
    render(
      <Button variant="subtle" flush>
        Compact
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Compact" });
    expect(button).toHaveClass("bg-accent");
    expect(button).not.toHaveClass("hover:bg-transparent");
  });
});

describe("subtle variant", () => {
  it("renders the soft fill recipe without a border", () => {
    render(<Button variant="subtle">Compact context</Button>);

    const button = screen.getByRole("button", { name: "Compact context" });
    expect(button).toHaveClass(
      "bg-accent",
      "text-accent-foreground",
      "hover:bg-accent-hover",
    );
    expect(button).not.toHaveClass("border-input");
  });

  it("applies the red tinted fill with the destructive flag", () => {
    render(
      <Button variant="subtle" destructive>
        Delete
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
      "bg-destructive/10",
      "text-destructive",
      "hover:bg-destructive/16",
    );
  });
});

describe("link variant defaults", () => {
  it("collapses to text height without padding", () => {
    render(<Button variant="link">Shortcuts</Button>);

    expect(screen.getByRole("button", { name: "Shortcuts" })).toHaveClass(
      "h-auto",
      "p-0",
      "underline-offset-4",
    );
  });
});

describe("preserveWidth duplicate label layers (BOT-1466)", () => {
  it("hides inactive layers outright when idle and loading labels match", () => {
    render(
      <Button preserveWidth loadingLabel="Try Again" feedbackState="idle">
        Try Again
      </Button>,
    );

    const layers = Array.from(
      screen.getByRole("button").querySelectorAll("[aria-hidden]"),
    );
    const inactive = layers.filter(
      (layer) => layer.getAttribute("aria-hidden") === "true",
    );

    expect(inactive.length).toBeGreaterThan(0);
    for (const layer of inactive) {
      // invisible removes the layer from the paint pass, so a mid-fade can
      // never show two offset copies of the same string.
      expect(layer).toHaveClass("invisible");
      expect(layer).not.toHaveClass("transition-opacity");
    }
  });

  it("keeps the opacity cross-fade when labels are distinct", () => {
    render(
      <Button preserveWidth loadingLabel="Checking..." feedbackState="idle">
        Check for Updates
      </Button>,
    );

    const layers = Array.from(
      screen.getByRole("button").querySelectorAll("[aria-hidden]"),
    );

    for (const layer of layers) {
      expect(layer).toHaveClass("transition-opacity");
      expect(layer).not.toHaveClass("invisible");
    }
  });
});
