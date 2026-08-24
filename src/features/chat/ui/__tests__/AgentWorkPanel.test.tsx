import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TranscriptAgentWorkPayload } from "@/features/chat/transcript/projection/transcriptItemTypes";
import { renderWithProviders } from "@/test/render";
import { AgentWorkPanel } from "../AgentWorkPanel";

describe("AgentWorkPanel", () => {
  it("renders independent speech states for progress text", () => {
    const content = [
      {
        type: "text" as const,
        text: "Already spoken.",
        speech: { status: "spoken" as const },
      },
      {
        type: "text" as const,
        text: "Speaking now.",
        speech: { status: "speaking" as const },
      },
    ];
    const payload: TranscriptAgentWorkPayload = {
      workId: "work-1",
      message: {
        id: "assistant-1",
        role: "assistant",
        created: Date.UTC(2026, 7, 19, 15, 0),
        content,
      },
      content,
      isActiveWork: true,
      hasFinalAnswer: false,
      thoughtCount: 0,
      toolCount: 0,
      textCount: 2,
    };

    const { container } = renderWithProviders(
      <AgentWorkPanel payload={payload} />,
    );

    expect(
      container.querySelector('[data-voice-speech-status="spoken"]'),
    ).toHaveTextContent("Spoken");
    expect(
      container.querySelector('[data-voice-speech-status="speaking"]'),
    ).toHaveTextContent("Speaking");
    expect(screen.getByText("Already spoken.")).toBeInTheDocument();
    expect(screen.getByText("Speaking now.")).toBeInTheDocument();
  });

  it("preserves adjacent interrupted blocks with distinct cutoffs", () => {
    const content = [
      {
        type: "text" as const,
        text: "First heard. First unheard.",
        speech: {
          status: "interrupted" as const,
          spokenThrough: "First heard.".length,
        },
      },
      {
        type: "text" as const,
        text: "Second heard. Second unheard.",
        speech: {
          status: "interrupted" as const,
          spokenThrough: "Second heard.".length,
        },
      },
    ];
    const payload: TranscriptAgentWorkPayload = {
      workId: "work-1",
      message: {
        id: "assistant-1",
        role: "assistant",
        created: Date.UTC(2026, 7, 19, 15, 0),
        content,
      },
      content,
      isActiveWork: true,
      hasFinalAnswer: false,
      thoughtCount: 0,
      toolCount: 0,
      textCount: 2,
    };

    const { container } = renderWithProviders(
      <AgentWorkPanel payload={payload} />,
    );
    const blocks = container.querySelectorAll(
      '[data-voice-speech-status="interrupted"]',
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.querySelector("[data-voice-unspoken]")).toHaveTextContent(
      "First unheard.",
    );
    expect(blocks[1]?.querySelector("[data-voice-unspoken]")).toHaveTextContent(
      "Second unheard.",
    );
  });
});
