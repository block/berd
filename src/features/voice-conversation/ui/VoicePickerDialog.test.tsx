import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { VoicePickerDialog } from "./VoicePickerDialog";

describe("VoicePickerDialog", () => {
  it.each([
    ["the selected voice", "Aaron", "Aaron"],
    ["the empty selection", null, "No voice selected"],
  ])("exposes %s to the trigger", (_case, selectedVoice, description) => {
    renderWithProviders(
      <VoicePickerDialog selectedVoice={selectedVoice}>
        <div>Voice choices</div>
      </VoicePickerDialog>,
    );

    expect(
      screen.getByRole("button", { name: "Choose a voice" }),
    ).toHaveAccessibleDescription(description);
  });
});
