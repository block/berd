import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listen: vi.fn(),
  openSession: vi.fn(),
  sendToMenuBar: vi.fn(),
  setMuted: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarMediaState: () => ({ media: undefined }),
}));
vi.mock("@/features/voice-conversation/api/voiceConversation", () => ({
  getVoiceConversationStatus: mocks.getStatus,
  listenToVoiceConversation: mocks.listen,
  openVoiceConversationSession: mocks.openSession,
  sendVoiceConversationToMenuBar: mocks.sendToMenuBar,
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
    window.history.replaceState({}, "", "/?voiceBuddy=1&menuBar=1");
    mocks.getStatus.mockReset().mockResolvedValue(runningStatus);
    mocks.listen.mockReset().mockResolvedValue(vi.fn());
    mocks.openSession.mockReset().mockResolvedValue(undefined);
    mocks.sendToMenuBar.mockReset().mockResolvedValue(undefined);
    mocks.setMuted.mockReset().mockResolvedValue(undefined);
    mocks.stop.mockReset().mockResolvedValue(undefined);
  });

  it("opens the owner and exposes mute, hang-up, and macOS menu controls", async () => {
    const user = userEvent.setup();
    render(<VoiceBuddyApp />);

    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledOnce());
    await user.click(
      screen.getByRole("button", {
        name: "composer.voiceConversation.buddy.openSession",
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "composer.voiceConversation.muteMicrophone",
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "composer.voiceConversation.buddy.hangUp",
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "composer.voiceConversation.buddy.sendToMenuBar",
      }),
    );

    expect(mocks.openSession).toHaveBeenCalledOnce();
    expect(mocks.setMuted).toHaveBeenCalledWith(true, runningStatus);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.sendToMenuBar).toHaveBeenCalledOnce();
  });

  it("omits the menu-bar control on Windows and Linux", async () => {
    window.history.replaceState({}, "", "/?voiceBuddy=1");
    render(<VoiceBuddyApp />);

    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("button", {
        name: "composer.voiceConversation.buddy.sendToMenuBar",
      }),
    ).not.toBeInTheDocument();
  });
});
