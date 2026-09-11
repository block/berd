import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/shared/i18n";
import { renderWithProviders } from "@/test/render";
import { RealtimeVoiceSettings } from "./RealtimeVoiceSettings";

const openAiVoiceMocks = vi.hoisted(() => ({
  clearApiKey: vi.fn(() => Promise.resolve()),
  getStatus: vi.fn(() => Promise.resolve({ sttConfigured: true })),
  listenToSettings: vi.fn(() => Promise.resolve(() => undefined)),
  setApiKey: vi.fn(() => Promise.resolve()),
}));

vi.mock("../api/openAiVoice", () => ({
  clearOpenAiSttApiKey: openAiVoiceMocks.clearApiKey,
  getOpenAiVoiceStatus: openAiVoiceMocks.getStatus,
  listenToOpenAiVoiceSettings: openAiVoiceMocks.listenToSettings,
  setOpenAiSttApiKey: openAiVoiceMocks.setApiKey,
}));

describe("RealtimeVoiceSettings", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
  });

  it("shows only GPT Live's supported voice and presentation controls", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RealtimeVoiceSettings />);

    expect(
      screen.getByRole("button", {
        name: "Choose a voice: Marin (default)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Playback speed" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Realtime model" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Advanced" }));

    expect(
      screen.getByRole("combobox", { name: "Conversation presentation" }),
    ).toHaveTextContent("Debug — show agent routing");
    expect(
      screen.queryByRole("combobox", { name: "Realtime model" }),
    ).not.toBeInTheDocument();
  });

  it("stores the Realtime key through the shared OpenAI voice credential path", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RealtimeVoiceSettings />);

    await user.type(screen.getByLabelText("OpenAI API key"), " sk-shared ");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(openAiVoiceMocks.setApiKey).toHaveBeenCalledWith(" sk-shared ");
  });
});
