import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OnboardingShell } from "./OnboardingShell";

describe("OnboardingShell", () => {
  it("provides a native window drag strip above onboarding controls", () => {
    const { container } = render(
      <OnboardingShell title="Welcome" onBack={() => {}}>
        <div>Content</div>
      </OnboardingShell>,
    );

    const dragStrip = container.querySelector(
      '[data-tauri-drag-region="deep"]',
    );
    expect(dragStrip).toHaveClass("top-0", "h-[var(--spacing-app-top-bar)]");
    expect(screen.getByRole("button", { name: "Go back" })).not.toHaveAttribute(
      "data-tauri-drag-region",
    );
  });

  it("does not steal focus when a mounted step rerenders", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <OnboardingShell title={<span>Installing Codex</span>}>
        <button type="button">Sign in</button>
      </OnboardingShell>,
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    rerender(
      <OnboardingShell title={<span>Installing Codex</span>}>
        <button type="button">Sign in</button>
      </OnboardingShell>,
    );

    expect(screen.getByRole("button", { name: "Sign in" })).toHaveFocus();
  });

  it("focuses its heading when a step mounts", () => {
    render(
      <OnboardingShell title="Choose a provider">
        <div>Options</div>
      </OnboardingShell>,
    );

    expect(
      screen.getByRole("heading", { name: "Choose a provider" }),
    ).toHaveFocus();
  });
});
