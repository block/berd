import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { VoicePickerDialog } from "./VoicePickerDialog";

describe("VoicePickerDialog", () => {
  it.each([
    ["the selected voice", "Aaron", "Aaron", "Choose a voice: Aaron", "Aaron"],
    [
      "the empty selection",
      null,
      "Choose…",
      "Choose a voice: Choose…",
      "No voice selected",
    ],
  ])("exposes %s to the trigger", (_case, selectedVoice, visibleValue, accessibleName, description) => {
    renderWithProviders(
      <VoicePickerDialog selectedVoice={selectedVoice}>
        <div>Voice choices</div>
      </VoicePickerDialog>,
    );

    const trigger = screen.getByRole("button", { name: accessibleName });
    expect(trigger).toHaveAccessibleName(new RegExp(visibleValue));
    expect(trigger).toHaveTextContent(visibleValue);
    expect(trigger).toHaveAccessibleDescription(description);
    expect(
      document.querySelector('[data-slot="settings-row-description"]'),
    ).toBeNull();
  });

  it("scrolls the selected voice into view when the picker opens", async () => {
    const scrollIntoView = vi.fn();
    renderWithProviders(
      <VoicePickerDialog selectedVoice="Aaron">
        <div
          data-voice-selected="true"
          ref={(element) => {
            if (element) element.scrollIntoView = scrollIntoView;
          }}
        >
          Aaron choice
        </div>
      </VoicePickerDialog>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Choose a voice: Aaron" }),
    );
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }),
    );
  });
});
