import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { StagedQuoteItem } from "@/shared/types/messages";
import { ChatInput } from "./chatInputTestUtils";

vi.mock("../../hooks/useVoiceDictation", () => ({
  useAnyVoiceDictationActive: () => false,
  useVoiceDictation: () => ({
    isEnabled: false,
    isRecording: false,
    isTranscribing: false,
    isStarting: vi.fn(() => false),
    stopRecording: vi.fn(),
    toggleRecording: vi.fn(),
  }),
}));

function makeQuote(id = "quote-1"): StagedQuoteItem {
  return {
    id,
    kind: "quote",
    excerpt: "a memorable earlier passage",
    sources: [
      {
        messageId: "message-1",
        role: "assistant",
        contentBlockIndex: 0,
        start: 0,
        end: 27,
      },
    ],
  };
}

describe("ChatInput quotes control", () => {
  it("shows the staged quote chip and sends staged items by default", async () => {
    const onSend = vi.fn().mockReturnValue(true);
    render(<ChatInput onSend={onSend} stagedItems={[makeQuote()]} />);

    expect(screen.getByText("a memorable earlier passage")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "what about this?" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
    const sendOptions = onSend.mock.calls[0][3];
    expect(sendOptions?.userMessageMetadata?.stagedItems).toHaveLength(1);
  });

  it("neither shows nor sends staged quotes when quotes are disabled", async () => {
    const onSend = vi.fn().mockReturnValue(true);
    render(
      <ChatInput
        onSend={onSend}
        stagedItems={[makeQuote()]}
        controls={{ quotes: false }}
      />,
    );

    expect(
      screen.queryByText("a memorable earlier passage"),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "what about this?" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
    const sendOptions = onSend.mock.calls[0][3];
    expect(sendOptions?.userMessageMetadata?.stagedItems).toBeUndefined();
  });
});
