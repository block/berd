import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listen: vi.fn(),
  openSession: vi.fn(),
  setMuted: vi.fn(),
  show: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/voice-conversation/api/voiceConversation", () => ({
  getVoiceConversationStatus: mocks.getStatus,
  listenToVoiceConversation: mocks.listen,
  openVoiceConversationSession: mocks.openSession,
  setVoiceConversationMicrophoneMuted: mocks.setMuted,
  showVoiceConversationControls: mocks.show,
  stopVoiceConversationFromBuddy: mocks.stop,
}));

import { VoiceBuddyApp } from "./VoiceBuddyApp";

let voiceEventListener: ((event: Record<string, unknown>) => void) | undefined;

const runningStatus = {
  available: true,
  unavailableReason: null,
  lifecycle: "running" as const,
  sessionId: "session-a",
  ownerWindowLabel: "main",
  microphoneMuted: false,
  revision: 3,
};

describe("VoiceBuddyApp", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/?voiceBuddy=1");
    mocks.getStatus.mockReset().mockResolvedValue(runningStatus);
    voiceEventListener = undefined;
    mocks.listen.mockReset().mockImplementation(async (listener) => {
      voiceEventListener = listener;
      return vi.fn();
    });
    mocks.openSession.mockReset().mockResolvedValue(undefined);
    mocks.setMuted.mockReset().mockResolvedValue(undefined);
    mocks.show.mockReset().mockResolvedValue(undefined);
    mocks.stop.mockReset().mockResolvedValue(undefined);
  });

  it("shows live user and assistant speaking activity", async () => {
    render(<VoiceBuddyApp />);

    await waitFor(() => expect(voiceEventListener).toBeDefined());
    act(() => {
      voiceEventListener?.({
        type: "activity",
        sessionId: "session-a",
        activity: "user-speaking",
        revision: 4,
      });
    });
    const muteButton = screen.getByRole("button", {
      name: "toolbar.voiceConversation.muteMicrophone",
    });
    expect(muteButton).toHaveClass(
      "bg-primary/15",
      "ring-2",
      "motion-safe:animate-pulse",
    );

    act(() => {
      voiceEventListener?.({
        type: "activity",
        sessionId: "session-a",
        activity: "assistant-speaking",
        revision: 5,
      });
    });
    const openButton = screen.getByRole("button", {
      name: "toolbar.voiceConversation.buddy.openSession",
    });
    expect(openButton).toHaveClass(
      "bg-primary/15",
      "ring-2",
      "motion-safe:animate-pulse",
    );
    expect(openButton.querySelector('[role="img"]')).not.toHaveClass(
      "motion-safe:animate-pulse",
    );
    expect(muteButton).not.toHaveClass("motion-safe:animate-pulse");

    act(() => {
      voiceEventListener?.({
        type: "activity",
        sessionId: "session-a",
        activity: "user-speaking",
        revision: 6,
      });
      voiceEventListener?.({
        type: "activity",
        sessionId: "session-a",
        activity: "user-idle",
        revision: 6,
      });
    });
    expect(muteButton).not.toHaveClass("bg-primary/15", "ring-2");
    expect(screen.getByRole("status")).toHaveTextContent(
      "toolbar.voiceConversation.buddy.listening",
    );
  });

  it("waits for listener registration and status hydration before showing", async () => {
    let resolveStatus: ((status: typeof runningStatus) => void) | undefined;
    mocks.getStatus.mockReturnValueOnce(
      new Promise<typeof runningStatus>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    render(<VoiceBuddyApp />);

    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());
    expect(mocks.show).not.toHaveBeenCalled();
    act(() => resolveStatus?.(runningStatus));
    await waitFor(() =>
      expect(mocks.show).toHaveBeenCalledWith("session-a", 3),
    );
    act(() => {
      voiceEventListener?.({
        type: "activity",
        sessionId: "session-a",
        activity: "assistant-speaking",
        revision: 2,
      });
    });
    expect(
      screen
        .getByRole("button", {
          name: "toolbar.voiceConversation.buddy.openSession",
        })
        .querySelector('[role="img"]'),
    ).not.toHaveClass("motion-safe:animate-pulse");
  });

  it("opens the owner and exposes mute and hang-up controls", async () => {
    const user = userEvent.setup();
    render(<VoiceBuddyApp />);

    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.show).toHaveBeenCalledOnce());
    const avatar = screen.getByRole("button", {
      name: "toolbar.voiceConversation.buddy.openSession",
    });
    await user.click(avatar);
    await user.click(
      screen.getByRole("button", {
        name: "toolbar.voiceConversation.muteMicrophone",
      }),
    );
    expect(mocks.openSession).toHaveBeenCalledOnce();
    expect(mocks.setMuted).toHaveBeenCalledWith(true, runningStatus);
  });

  it("hangs up the voice conversation", async () => {
    const user = userEvent.setup();
    render(<VoiceBuddyApp />);

    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledOnce());
    await user.click(
      screen.getByRole("button", {
        name: "toolbar.voiceConversation.buddy.hangUp",
      }),
    );

    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("reports an owner-opening failure", async () => {
    const user = userEvent.setup();
    mocks.openSession.mockRejectedValueOnce(new Error("owner unavailable"));
    render(<VoiceBuddyApp />);

    await user.click(
      await screen.findByRole("button", {
        name: "toolbar.voiceConversation.buddy.openSession",
      }),
    );

    const error = await screen.findByRole("status");
    expect(error).toHaveTextContent("owner unavailable");
    expect(error).toHaveClass("sr-only");
    expect(screen.getByTitle("Error: owner unavailable")).toBeInTheDocument();
  });
});
