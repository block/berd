import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingTourDialog } from "./OnboardingTourDialog";

const themeState = vi.hoisted(() => ({ isDark: false }));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  useTheme: () => themeState,
}));

describe("OnboardingTourDialog", () => {
  beforeEach(() => {
    themeState.isDark = false;
  });

  it("uses the dark Home artwork in dark mode", () => {
    themeState.isDark = true;

    render(<OnboardingTourDialog open={true} onOpenChange={vi.fn()} />);

    expect(
      document
        .querySelector("[data-onboarding-tour-home-image]")
        ?.getAttribute("src"),
    ).toContain("tour-1-dark.png");
  });

  it("advances through five steps and finishes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onComplete = vi.fn();

    render(
      <OnboardingTourDialog
        open={true}
        onOpenChange={onOpenChange}
        onComplete={onComplete}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveClass("dark:bg-card");
    expect(document.querySelector("[data-onboarding-tour-copy]")).toHaveClass(
      "dark:bg-card",
    );

    expect(
      screen.getByRole("heading", { name: "Your canvas, your home" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 of 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toHaveClass(
      "bg-accent",
      "rounded-[10px]",
      "text-sm",
    );
    const homeImage = document.querySelector(
      "[data-onboarding-tour-home-image]",
    );
    expect(homeImage).toBeInTheDocument();
    expect(homeImage?.getAttribute("src")).toContain("tour-1.png");
    expect(homeImage).toHaveStyle({ transformOrigin: "100% 0%" });
    expect(
      document.querySelector("[data-onboarding-tour-home-frame]"),
    ).toHaveClass(
      "inset-x-8",
      "top-8",
      "bottom-0",
      "overflow-visible",
      "rounded-t-xl",
    );
    expect(homeImage).toHaveClass("object-contain", "object-right-top");
    const lightTexture = document.querySelector(
      "[data-onboarding-tour-texture]",
    );
    expect(lightTexture?.getAttribute("src")).toContain("texture.png");
    expect(
      document.querySelector("[data-onboarding-tour-dark-inverter]"),
    ).toHaveClass("hidden", "bg-white", "mix-blend-difference", "dark:block");

    const artwork = document.querySelector("[data-onboarding-tour-background]");
    const nextButton = screen.getByRole("button", { name: "Next tour step" });
    expect(artwork).toContainElement(nextButton);
    expect(nextButton).toHaveClass(
      "bg-surface-glass-strong",
      "text-surface-glass-strong-fg",
      "shadow-[var(--shadow-chat)]",
      "backdrop-blur-md",
    );
    await user.click(nextButton);
    const secondStepHeading = screen.getByRole("heading", {
      name: "All your AI providers in one place",
    });
    expect(secondStepHeading).toHaveFocus();
    expect(artwork).toContainElement(
      screen.getByRole("button", { name: "Previous tour step" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Previous tour step" }),
    );
    expect(
      screen.getByRole("heading", { name: "Your canvas, your home" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Previous tour step" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next tour step" }));
    expect(
      document.querySelectorAll("[data-onboarding-tour-provider]"),
    ).toHaveLength(5);
    expect(screen.getByText("Amp")).toHaveClass("sr-only");
    expect(
      document.querySelector("[data-onboarding-tour-provider]"),
    ).toHaveClass("size-24");

    await user.click(screen.getByRole("button", { name: "Next tour step" }));
    expect(
      document.querySelectorAll("[data-onboarding-tour-chat-bubble]"),
    ).toHaveLength(2);
    expect(
      document.querySelector("[data-onboarding-tour-chat-bubble]")
        ?.parentElement,
    ).toHaveClass("px-16");
    await user.click(screen.getByRole("button", { name: "Next tour step" }));
    expect(
      screen.getByRole("heading", { name: "Agents have joined the chat" }),
    ).toBeInTheDocument();
    const agentsImage = document.querySelector(
      "[data-onboarding-tour-agents-image]",
    );
    expect(agentsImage?.getAttribute("src")).toContain("tour-4-agents.png");
    expect(agentsImage).toHaveClass("object-contain", "max-h-[270px]");

    await user.click(screen.getByRole("button", { name: "Next tour step" }));
    expect(
      screen.getByRole("heading", {
        name: "Teach Berd a new trick with skills",
      }),
    ).toBeInTheDocument();
    const skillPills = document.querySelectorAll(
      "[data-onboarding-tour-skill]",
    );
    expect(skillPills).toHaveLength(5);
    expect(screen.getByText("research")).toHaveClass(
      "rounded-full",
      "text-[1.625rem]",
      "smooth-shadow-sm",
    );
    expect(screen.getByText("writing")).toBeInTheDocument();
    expect(screen.getByText("planning")).toBeInTheDocument();
    expect(screen.getByText("code-search")).toBeInTheDocument();
    expect(screen.getByText("summarize")).toBeInTheDocument();
    expect(screen.queryByText("goose-help")).not.toBeInTheDocument();
    expect(skillPills[0]?.parentElement).toHaveClass(
      "top-1/2",
      "left-8",
      "-translate-y-1/2",
      "items-start",
    );
    expect(
      screen.queryByRole("button", { name: "Next tour step" }),
    ).not.toBeInTheDocument();

    const doneButton = screen.getByRole("button", { name: "Done" });
    expect(doneButton).toHaveClass("bg-accent", "rounded-[10px]", "text-sm");
    await user.click(doneButton);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not complete the tour from its close button", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onComplete = vi.fn();

    render(
      <OnboardingTourDialog
        open={true}
        onOpenChange={onOpenChange}
        onComplete={onComplete}
      />,
    );

    const closeButton = screen.getByRole("button", { name: "Close tour" });
    expect(closeButton).toHaveAttribute("data-slot", "dialog-close");
    expect(closeButton).toHaveClass(
      "bg-surface-glass-strong",
      "text-surface-glass-strong-fg",
    );

    await user.click(closeButton);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
