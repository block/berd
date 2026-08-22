import { render, screen } from "@testing-library/react";
import { Mic } from "lucide-react";
import { describe, expect, it } from "vitest";

import { VoiceConversationButton } from "@/shared/ui/voice-conversation-button";

describe("VoiceConversationButton", () => {
  it("uses the semantic speaking treatment with reduced-motion protection", () => {
    const { rerender } = render(
      <VoiceConversationButton
        type="button"
        speaking
        aria-label="Mute microphone"
      >
        <Mic />
      </VoiceConversationButton>,
    );

    const button = screen.getByRole("button", { name: "Mute microphone" });
    expect(button).toHaveAttribute("data-speaking", "true");
    expect(button).toHaveClass(
      "bg-primary/15",
      "text-primary",
      "ring-2",
      "motion-safe:animate-pulse",
    );

    rerender(
      <VoiceConversationButton
        type="button"
        disabled
        aria-label="Mute microphone"
      >
        <Mic />
      </VoiceConversationButton>,
    );
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("data-speaking");
    expect(button).not.toHaveClass("motion-safe:animate-pulse");
  });
});
