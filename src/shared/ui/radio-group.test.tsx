import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RadioGroup, RadioGroupCard, RadioGroupTile } from "./radio-group";

function renderCards({ preventDisabled = false } = {}) {
  return render(
    <RadioGroup defaultValue="automatic" aria-label="Playback behavior">
      <RadioGroupCard
        id="automatic"
        value="automatic"
        label="Automatic"
        description="Choose based on the audio output."
      />
      <RadioGroupCard
        id="prevent"
        value="prevent"
        label="Prevent feedback"
        description="Pause listening during playback."
        disabled={preventDisabled}
      />
    </RadioGroup>,
  );
}

describe("RadioGroupCard", () => {
  it("exposes selected state and activates from the full label", async () => {
    const user = userEvent.setup();
    renderCards();
    const automatic = screen.getByRole("radio", { name: "Automatic" });
    const prevent = screen.getByRole("radio", { name: "Prevent feedback" });

    expect(automatic).toBeChecked();
    expect(prevent).not.toBeChecked();
    expect(automatic).toHaveAccessibleDescription(
      "Choose based on the audio output.",
    );

    await user.click(screen.getByText("Prevent feedback"));

    expect(automatic).not.toBeChecked();
    expect(prevent).toBeChecked();
  });

  it("provides a full-row focus-visible treatment", async () => {
    const user = userEvent.setup();
    renderCards();

    await user.tab();

    const automatic = screen.getByRole("radio", { name: "Automatic" });
    expect(automatic).toHaveFocus();
    expect(automatic.closest('[data-slot="radio-group-card"]')).toHaveClass(
      "has-[[data-slot=radio-group-item]:focus-visible]:ring-[3px]",
      "has-[[data-slot=radio-group-item]:focus-visible]:border-ring",
    );
  });

  it("prevents label activation when disabled", async () => {
    const user = userEvent.setup();
    renderCards({ preventDisabled: true });
    const automatic = screen.getByRole("radio", { name: "Automatic" });
    const prevent = screen.getByRole("radio", { name: "Prevent feedback" });

    expect(prevent).toBeDisabled();
    await user.click(screen.getByText("Prevent feedback"));

    expect(automatic).toBeChecked();
    expect(prevent).not.toBeChecked();
    expect(prevent).toHaveClass("disabled:opacity-100");
    expect(prevent.closest('[data-slot="radio-group-card"]')).toHaveClass(
      "has-[[data-slot=radio-group-item][data-disabled][data-state=unchecked]]:hover:bg-transparent",
      "has-[[data-slot=radio-group-item][data-disabled][data-state=checked]]:hover:bg-muted",
    );
  });

  it("selects visual-only tiles by their accessible name without a radio dot", async () => {
    render(
      <RadioGroup defaultValue="bird" aria-label="Activity indicator">
        <RadioGroupTile value="bird" label="Distant bird">
          <span aria-hidden="true">bird</span>
        </RadioGroupTile>
        <RadioGroupTile value="beak" label="Berd beak">
          <span aria-hidden="true">beak</span>
        </RadioGroupTile>
      </RadioGroup>,
    );
    const beak = screen.getByRole("radio", { name: "Berd beak" });
    expect(beak).toHaveAttribute("title", "Berd beak");
    expect(
      document.querySelector("[data-slot=radio-group-indicator]"),
    ).toBeNull();
    await userEvent.click(beak);
    expect(beak).toHaveAttribute("data-state", "checked");
    expect(screen.getByRole("radio", { name: "Distant bird" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });
});
