import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { TranscriptAgentWorkPayload } from "@/features/chat/transcript/projection/transcriptItemTypes";
import { renderWithProviders } from "@/test/render";
import { AgentWorkPanel } from "../AgentWorkPanel";
import { useAgentStore } from "@/features/agents/stores/agentStore";

beforeEach(() => {
  useAgentStore.setState({ personas: [] });
});

describe("AgentWorkPanel", () => {
  it("shows a capped facepile for active named delegates in previous steps", () => {
    const content = [
      {
        type: "thinking" as const,
        text: "Planning",
      },
      {
        type: "toolRequest" as const,
        id: "delegate-rivet",
        name: "delegate",
        toolName: "delegate",
        arguments: { source: "Rivet", instructions: "Review the code" },
        status: "in_progress" as const,
      },
      {
        type: "toolRequest" as const,
        id: "delegate-trace",
        name: "delegate",
        toolName: "delegate",
        arguments: { source: "Trace", instructions: "Run the tests" },
        status: "pending" as const,
      },
      {
        type: "toolRequest" as const,
        id: "delegate-scout",
        name: "delegate",
        toolName: "delegate",
        arguments: { source: "Scout", instructions: "Check the UX" },
        status: "in_progress" as const,
      },
      {
        type: "toolRequest" as const,
        id: "delegate-lens",
        name: "delegate",
        toolName: "delegate",
        arguments: { source: "Lens", instructions: "Check accessibility" },
        status: "in_progress" as const,
      },
    ];
    const payload: TranscriptAgentWorkPayload = {
      workId: "work-delegates",
      message: {
        id: "assistant-delegates",
        role: "assistant",
        created: Date.UTC(2026, 8, 2, 15, 0),
        content,
      },
      content,
      isActiveWork: true,
      hasFinalAnswer: false,
      thoughtCount: 1,
      toolCount: 4,
      textCount: 0,
    };

    const { container } = renderWithProviders(
      <AgentWorkPanel payload={payload} />,
    );

    const facepile = container.querySelector('[data-active-agent-facepile=""]');
    expect(facepile).toHaveAccessibleName(
      "Rivet, Trace, Scout, and Lens are working",
    );
    expect(
      facepile?.querySelectorAll("[data-agent-identity-avatar]"),
    ).toHaveLength(3);
    expect(facepile).toHaveTextContent("+1");
  });

  it.each([
    "send_message",
    "close_agent",
    "interrupt_agent",
  ])("does not describe pending %s activity as active work", (toolName) => {
    const content = [
      { type: "thinking" as const, text: "Planning" },
      {
        type: "toolRequest" as const,
        id: `activity-${toolName}`,
        name: toolName,
        toolName,
        arguments: { target: "Rivet", message: "Check this" },
        status: "in_progress" as const,
      },
      { type: "text" as const, text: "Continuing" },
      { type: "text" as const, text: "Still working" },
    ];
    const payload: TranscriptAgentWorkPayload = {
      workId: `work-${toolName}`,
      message: {
        id: `assistant-${toolName}`,
        role: "assistant",
        created: Date.UTC(2026, 8, 2, 15, 0),
        content,
      },
      content,
      isActiveWork: true,
      hasFinalAnswer: false,
      thoughtCount: 1,
      toolCount: 1,
      textCount: 2,
    };

    const { container } = renderWithProviders(
      <AgentWorkPanel payload={payload} />,
    );
    expect(
      container.querySelector('[data-active-agent-facepile=""]'),
    ).toBeNull();
  });

  it("keeps an async delegate active until its task reaches a terminal response", () => {
    const delegateRequest = {
      type: "toolRequest" as const,
      id: "delegate-rivet",
      name: "delegate",
      toolName: "delegate",
      arguments: {
        source: "Rivet",
        instructions: "Review the code",
        async: true,
      },
      status: "completed" as const,
    };
    const delegateResponse = {
      type: "toolResponse" as const,
      id: "delegate-rivet",
      name: "delegate",
      result: "Task 20260902_72 started in background",
      isError: false,
    };
    const baseContent = [
      { type: "thinking" as const, text: "Preparing research" },
      delegateRequest,
      delegateResponse,
      { type: "thinking" as const, text: "Waiting for research" },
      { type: "text" as const, text: "Continuing" },
    ];
    const makePayload = (
      content: TranscriptAgentWorkPayload["content"],
    ): TranscriptAgentWorkPayload => ({
      workId: "work-async-delegate",
      message: {
        id: "assistant-async-delegate",
        role: "assistant",
        created: Date.UTC(2026, 8, 2, 15, 0),
        content: [...content],
      },
      content,
      isActiveWork: true,
      hasFinalAnswer: false,
      thoughtCount: 1,
      toolCount: 2,
      textCount: 1,
    });

    const { container, rerender } = renderWithProviders(
      <AgentWorkPanel payload={makePayload(baseContent)} />,
    );
    expect(
      container.querySelector('[data-active-agent-facepile=""]'),
    ).toHaveAccessibleName("Rivet is working");

    const failedWaitContent = [
      ...baseContent,
      {
        type: "toolRequest" as const,
        id: "load-rivet-failed",
        name: "load",
        toolName: "load",
        arguments: { source: "20260902_72" },
        status: "completed" as const,
      },
      {
        type: "toolResponse" as const,
        id: "load-rivet-failed",
        name: "load",
        result: "Unable to wait for task",
        isError: true,
      },
    ];
    rerender(<AgentWorkPanel payload={makePayload(failedWaitContent)} />);
    expect(
      container.querySelector('[data-active-agent-facepile=""]'),
    ).toHaveAccessibleName("Rivet is working");

    const terminalContent = [
      ...failedWaitContent,
      {
        type: "toolRequest" as const,
        id: "load-rivet-complete",
        name: "load",
        toolName: "load",
        arguments: { source: "20260902_72" },
        status: "completed" as const,
      },
      {
        type: "toolResponse" as const,
        id: "load-rivet-complete",
        name: "load",
        result: "Review complete",
        isError: false,
      },
    ];
    rerender(<AgentWorkPanel payload={makePayload(terminalContent)} />);
    expect(
      container.querySelector('[data-active-agent-facepile=""]'),
    ).toBeNull();
  });

  it("does not show completed delegates in the active facepile", () => {
    const content = [
      {
        type: "toolRequest" as const,
        id: "delegate-rivet",
        name: "delegate",
        toolName: "delegate",
        arguments: { source: "Rivet" },
        status: "completed" as const,
      },
      { type: "text" as const, text: "Continuing" },
      { type: "thinking" as const, text: "Checking results" },
      { type: "text" as const, text: "Still working" },
    ];
    const payload: TranscriptAgentWorkPayload = {
      workId: "work-completed-delegate",
      message: {
        id: "assistant-completed-delegate",
        role: "assistant",
        created: Date.UTC(2026, 8, 2, 15, 0),
        content,
      },
      content,
      isActiveWork: true,
      hasFinalAnswer: false,
      thoughtCount: 1,
      toolCount: 1,
      textCount: 2,
    };

    const { container } = renderWithProviders(
      <AgentWorkPanel payload={payload} />,
    );

    expect(
      container.querySelector('[data-active-agent-facepile=""]'),
    ).toBeNull();
  });

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
