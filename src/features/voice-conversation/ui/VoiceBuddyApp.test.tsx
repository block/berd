import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listen: vi.fn(),
  openSession: vi.fn(),
  setMuted: vi.fn(),
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
  stopVoiceConversationFromBuddy: mocks.stop,
}));

import { VoiceBuddyApp } from "./VoiceBuddyApp";

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
    mocks.listen.mockReset().mockResolvedValue(vi.fn());
    mocks.openSession.mockReset().mockResolvedValue(undefined);
    mocks.setMuted.mockReset().mockResolvedValue(undefined);
    mocks.stop.mockReset().mockResolvedValue(undefined);
  });

  it("opens the owner and exposes mute and hang-up controls", async () => {
    const user = userEvent.setup();
    render(<VoiceBuddyApp />);

    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledOnce());
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
