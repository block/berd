import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
import type { Message } from "@/shared/types/messages";
import { VirtualMessageTimelineGate } from "../VirtualMessageTimelineGate";
import type { MessageTimelineBubbleCallbacks } from "../messageTimelineShared";

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
    loadedTranscript: { id: string };
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the virtual timeline by default in production builds", () => {
    vi.stubEnv("DEV", false);

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

  it("honors an owning surface's explicit classic renderer policy", () => {
    expect(
      setExperimentEnabled(TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID, true),
    ).toBe(true);

    render(
      <VirtualMessageTimelineGate
        sessionId="canvas-session"
        messages={[message("user-1")]}
        rendererPolicy="classic"
      />,
    );

    expect(screen.getByTestId("legacy-message-timeline")).toBeInTheDocument();
    expect(
      screen.queryByTestId("virtual-message-timeline"),
    ).not.toBeInTheDocument();
    expect(mocks.virtualTimelineSpy).not.toHaveBeenCalled();
  });

  it("replaces loaded transcript state when the virtual renderer is toggled", () => {
    expect(
      setExperimentEnabled(TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID, true),
    ).toBe(true);

    render(
      <VirtualMessageTimelineGate
        sessionId="session-1"
        messages={[message("user-1")]}
      />,
    );
    const firstLoadedTranscript =
      mocks.virtualTimelineSpy.mock.lastCall?.[0].loadedTranscript;

    act(() => {
      expect(
        setExperimentEnabled(TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID, false),
      ).toBe(true);
    });
    expect(screen.getByTestId("legacy-message-timeline")).toBeInTheDocument();

    act(() => {
      expect(
        setExperimentEnabled(TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID, true),
      ).toBe(true);
    });
    const replacementLoadedTranscript =
      mocks.virtualTimelineSpy.mock.lastCall?.[0].loadedTranscript;

    expect(screen.getByTestId("virtual-message-timeline")).toBeInTheDocument();
    expect(replacementLoadedTranscript).not.toBe(firstLoadedTranscript);
    expect(replacementLoadedTranscript?.id).not.toBe(firstLoadedTranscript?.id);
  });

  it("passes shared message-bubble callbacks through both experiment states", () => {
    const callbackProps = {
      onRetryMessage: vi.fn(),
      onEditMessage: vi.fn(),
      onSendMcpAppMessage: vi.fn(),
      onForkFromMessage: vi.fn(),
      onRunShellCommand: vi.fn(),
      onEditProject: vi.fn(),
    } satisfies MessageTimelineBubbleCallbacks;

    expect(
      setExperimentEnabled(TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID, false),
    ).toBe(true);

    const legacyRender = render(
      <VirtualMessageTimelineGate
        sessionId="session-1"
        messages={[message("user-1")]}
        {...callbackProps}
      />,
    );

    expect(mocks.legacyTimelineSpy).toHaveBeenCalledWith(
      expect.objectContaining(callbackProps),
    );
    expect(mocks.virtualTimelineSpy).not.toHaveBeenCalled();
    legacyRender.unmount();
    mocks.legacyTimelineSpy.mockClear();

    expect(
      setExperimentEnabled(TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID, true),
    ).toBe(true);

    render(
      <VirtualMessageTimelineGate
        sessionId="session-1"
        messages={[message("user-1")]}
        {...callbackProps}
      />,
    );

    expect(mocks.virtualTimelineSpy).toHaveBeenCalledWith(
      expect.objectContaining(callbackProps),
    );
    expect(mocks.legacyTimelineSpy).not.toHaveBeenCalled();
  });
});
