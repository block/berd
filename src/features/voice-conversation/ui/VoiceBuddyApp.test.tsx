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
  getRealtimeStatus: vi.fn(),
  requestRealtimeControl: vi.fn(),
  showRealtime: vi.fn(),
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
vi.mock("@/shared/api/openaiRealtime", () => ({
  getOpenAiRealtimeVoiceControlsStatus: mocks.getRealtimeStatus,
  requestOpenAiRealtimeVoiceControl: mocks.requestRealtimeControl,
  showOpenAiRealtimeVoiceControls: mocks.showRealtime,
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
    mocks.setMuted.mockReset().mockImplementation(async (muted) => ({
      ...runningStatus,
      microphoneMuted: muted,
    }));
    mocks.show.mockReset().mockResolvedValue(undefined);
    mocks.stop.mockReset().mockResolvedValue(undefined);
    mocks.getRealtimeStatus.mockReset().mockResolvedValue(runningStatus);
    mocks.requestRealtimeControl.mockReset().mockResolvedValue(undefined);
    mocks.showRealtime.mockReset().mockResolvedValue(undefined);
  });

  it("uses renderer-owned Realtime controls when opened for that voice mode", async () => {
    window.history.replaceState(
      {},
      "",
      "/?voiceBuddy=1&voiceMode=realtime&voiceRevision=3",
    );
    const user = userEvent.setup();
    render(<VoiceBuddyApp />);

    await waitFor(() =>
      expect(mocks.showRealtime).toHaveBeenCalledWith("session-a", 3),
    );
    expect(mocks.getRealtimeStatus).toHaveBeenCalledOnce();
    expect(mocks.getStatus).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: "toolbar.voiceConversation.muteMicrophone",
      }),
    );
    expect(mocks.requestRealtimeControl).toHaveBeenCalledWith(
      "session-a",
      3,
      "mute",
      true,
    );

    await user.click(
      screen.getByRole("button", {
        name: "toolbar.voiceConversation.buddy.hangUp",
      }),
    );
    expect(mocks.requestRealtimeControl).toHaveBeenCalledWith(
      "session-a",
      3,
      "stop",
    );
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
    expect(muteButton).toHaveAccessibleDescription(
      "toolbar.voiceConversation.buddy.userSpeaking",
    );
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
    expect(openButton).toHaveAccessibleDescription(
      "toolbar.voiceConversation.buddy.assistantSpeaking",
    );
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
    expect(muteButton).not.toHaveAttribute("aria-describedby");
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

  it("keeps a newer mute event over an equal-revision action response", async () => {
    const user = userEvent.setup();
    let resolveMute!: (status: typeof runningStatus) => void;
    mocks.setMuted.mockReturnValueOnce(
      new Promise<typeof runningStatus>((resolve) => {
        resolveMute = resolve;
      }),
    );
    render(<VoiceBuddyApp />);
    await waitFor(() => expect(voiceEventListener).toBeDefined());

    await user.click(
      screen.getByRole("button", {
        name: "toolbar.voiceConversation.muteMicrophone",
      }),
    );
    act(() => {
      voiceEventListener?.({
        type: "microphoneMute",
        sessionId: "session-a",
        muted: false,
        revision: 3,
      });
      resolveMute({ ...runningStatus, microphoneMuted: true });
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "toolbar.voiceConversation.muteMicrophone",
        }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByRole("button", {
        name: "toolbar.voiceConversation.unmuteMicrophone",
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps a mute event that arrives during initial hydration", async () => {
    let resolveStatus!: (status: typeof runningStatus) => void;
    mocks.getStatus.mockReturnValueOnce(
      new Promise<typeof runningStatus>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    render(<VoiceBuddyApp />);
    await waitFor(() => expect(voiceEventListener).toBeDefined());

    act(() => {
      voiceEventListener?.({
        type: "microphoneMute",
        sessionId: "session-a",
        muted: true,
        revision: 3,
      });
      resolveStatus(runningStatus);
    });

    expect(
      await screen.findByRole("button", {
        name: "toolbar.voiceConversation.unmuteMicrophone",
      }),
    ).toBeInTheDocument();
  });

  it("keeps a terminal event that arrives during initial hydration", async () => {
    let resolveStatus!: (status: typeof runningStatus) => void;
    mocks.getStatus.mockReturnValueOnce(
      new Promise<typeof runningStatus>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    render(<VoiceBuddyApp />);
    await waitFor(() => expect(voiceEventListener).toBeDefined());

    act(() => {
      voiceEventListener?.({
        type: "cleanShutdown",
        sessionId: "session-a",
        revision: 3,
      });
      resolveStatus(runningStatus);
    });

    expect(
      await screen.findByRole("button", {
        name: "toolbar.voiceConversation.buddy.openSession",
      }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "toolbar.voiceConversation.buddy.stopped",
    );
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it("does not let an older event invalidate a current mute response", async () => {
    const user = userEvent.setup();
    let resolveMute!: (status: typeof runningStatus) => void;
    mocks.setMuted.mockReturnValueOnce(
      new Promise<typeof runningStatus>((resolve) => {
        resolveMute = resolve;
      }),
    );
    render(<VoiceBuddyApp />);
    await waitFor(() => expect(voiceEventListener).toBeDefined());
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledOnce());

    await user.click(
      screen.getByRole("button", {
        name: "toolbar.voiceConversation.muteMicrophone",
      }),
    );
    act(() => {
      voiceEventListener?.({
        type: "microphoneMute",
        sessionId: "session-a",
        muted: false,
        revision: 2,
      });
      resolveMute({ ...runningStatus, microphoneMuted: true });
    });

    expect(
      await screen.findByRole("button", {
        name: "toolbar.voiceConversation.unmuteMicrophone",
      }),
    ).toBeInTheDocument();
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

    expect(mocks.stop).toHaveBeenCalledWith(runningStatus);
  });

  it("disables surviving controls after terminal shutdown", async () => {
    render(<VoiceBuddyApp />);
    await waitFor(() => expect(voiceEventListener).toBeDefined());

    act(() => {
      voiceEventListener?.({
        type: "cleanShutdown",
        sessionId: "session-a",
        revision: 4,
      });
    });

    expect(
      screen.getByRole("button", {
        name: "toolbar.voiceConversation.buddy.openSession",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "toolbar.voiceConversation.muteMicrophone",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "toolbar.voiceConversation.buddy.hangUp",
      }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "toolbar.voiceConversation.buddy.stopped",
    );
  });

  it("disables surviving controls when terminal cleanup has no session payload", async () => {
    render(<VoiceBuddyApp />);
    await waitFor(() => expect(voiceEventListener).toBeDefined());

    act(() => {
      voiceEventListener?.({
        type: "controlsDismissed",
        revision: 4,
      });
    });

    expect(
      screen.getByRole("button", {
        name: "toolbar.voiceConversation.buddy.openSession",
      }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "toolbar.voiceConversation.buddy.stopped",
    );
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
    expect(error).toHaveTextContent(
      "toolbar.voiceConversation.buddy.errors.open",
    );
    expect(error).toHaveClass("sr-only");
    expect(
      screen.getByTitle("toolbar.voiceConversation.buddy.errors.open"),
    ).toBeInTheDocument();
    expect(screen.queryByText("owner unavailable")).not.toBeInTheDocument();
  });

  it.each([
    {
      action: "toolbar.voiceConversation.muteMicrophone",
      error: "toolbar.voiceConversation.buddy.errors.mute",
      fail: () => mocks.setMuted.mockRejectedValueOnce(new Error("mute ipc")),
    },
    {
      action: "toolbar.voiceConversation.buddy.hangUp",
      error: "toolbar.voiceConversation.buddy.errors.stop",
      fail: () => mocks.stop.mockRejectedValueOnce(new Error("stop ipc")),
    },
  ])("localizes a failed $action action", async ({ action, error, fail }) => {
    const user = userEvent.setup();
    fail();
    render(<VoiceBuddyApp />);

    await user.click(await screen.findByRole("button", { name: action }));

    expect(await screen.findByRole("status")).toHaveTextContent(error);
    expect(screen.queryByText(/ipc/)).not.toBeInTheDocument();
  });

  it("localizes initialization failures", async () => {
    mocks.getStatus.mockRejectedValueOnce(new Error("status ipc"));
    render(<VoiceBuddyApp />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "toolbar.voiceConversation.buddy.errors.initialize",
    );
    expect(screen.queryByText("status ipc")).not.toBeInTheDocument();
  });

  it("localizes failures to reveal the controls", async () => {
    mocks.show.mockRejectedValueOnce(new Error("show ipc"));
    render(<VoiceBuddyApp />);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "toolbar.voiceConversation.buddy.errors.show",
      ),
    );
    expect(screen.queryByText("show ipc")).not.toBeInTheDocument();
  });
});
