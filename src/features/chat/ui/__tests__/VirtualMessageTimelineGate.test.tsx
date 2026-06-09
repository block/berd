import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
import type { Message } from "@/shared/types/messages";
import { VirtualMessageTimelineGate } from "../VirtualMessageTimelineGate";

const mocks = vi.hoisted(() => ({
  legacyTimelineSpy: vi.fn(),
  virtualTimelineSpy: vi.fn(),
}));

vi.mock("../MessageTimeline", () => ({
  MessageTimeline: (props: { messages: Message[]; footer?: ReactNode }) => {
    mocks.legacyTimelineSpy(props);
    return (
      <div data-testid="legacy-message-timeline">
        {props.messages.map((message) => (
          <div key={message.id}>{message.id}</div>
        ))}
        {props.footer}
      </div>
    );
  },
}));

vi.mock("../VirtualMessageTimeline", () => ({
  VirtualMessageTimeline: (props: {
    sessionId: string;
    messages: Message[];
    footer?: ReactNode;
  }) => {
    mocks.virtualTimelineSpy(props);
    return (
      <div data-testid="virtual-message-timeline">
        <span>{props.sessionId}</span>
        {props.messages.map((message) => (
          <div key={message.id}>{message.id}</div>
        ))}
        {props.footer}
      </div>
    );
  },
}));

function message(id: string): Message {
  return {
    id,
    role: "user",
    created: Date.UTC(2026, 5, 4, 12, 0, 0),
    content: [{ type: "text", text: id }],
    metadata: { userVisible: true },
  };
}

describe("VirtualMessageTimelineGate", () => {
  beforeEach(() => {
    localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
    mocks.legacyTimelineSpy.mockClear();
    mocks.virtualTimelineSpy.mockClear();
  });

  it("uses the legacy timeline while the virtual renderer experiment is explicitly disabled", () => {
    expect(
      setExperimentEnabled(TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID, false),
    ).toBe(true);

    render(
      <VirtualMessageTimelineGate
        sessionId="session-1"
        messages={[message("user-1")]}
        footer={<div data-testid="footer" />}
      />,
    );

    expect(screen.getByTestId("legacy-message-timeline")).toBeInTheDocument();
    expect(
      screen.queryByTestId("virtual-message-timeline"),
    ).not.toBeInTheDocument();
    expect(mocks.legacyTimelineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({ id: "user-1" })],
      }),
    );
    expect(mocks.virtualTimelineSpy).not.toHaveBeenCalled();
  });

  it("uses the virtual timeline bridge after opt-in", () => {
    expect(
      setExperimentEnabled(TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID, true),
    ).toBe(true);

    render(
      <VirtualMessageTimelineGate
        sessionId="session-1"
        messages={[message("user-1")]}
      />,
    );

    expect(screen.getByTestId("virtual-message-timeline")).toBeInTheDocument();
    expect(
      screen.queryByTestId("legacy-message-timeline"),
    ).not.toBeInTheDocument();
    expect(mocks.virtualTimelineSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        messages: [expect.objectContaining({ id: "user-1" })],
      }),
    );
    expect(mocks.legacyTimelineSpy).not.toHaveBeenCalled();
  });
});
