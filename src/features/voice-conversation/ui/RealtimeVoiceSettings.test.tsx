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

  it("shows recommended model, transcription, voice, and turn controls", () => {
    renderWithProviders(<RealtimeVoiceSettings />);

    expect(
      screen.getByRole("combobox", { name: "Realtime model" }),
    ).toHaveTextContent("gpt-realtime-2.1 (default)");
    expect(
      screen.getByRole("combobox", { name: "Transcription model" }),
    ).toHaveTextContent("gpt-realtime-whisper (default)");
    expect(screen.getByRole("combobox", { name: "Voice" })).toHaveTextContent(
      "Marin (default)",
    );
    expect(
      screen.getByRole("combobox", { name: "Turn detection" }),
    ).toHaveTextContent("Server VAD (default)");
    expect(
      screen.getByRole("combobox", { name: "Conversation presentation" }),
    ).toHaveTextContent("Debug — show agent routing");
    expect(
      screen.getByRole("switch", { name: "Interrupt when I speak" }),
    ).toBeChecked();
  });

  it("stores the Realtime key through the shared OpenAI voice credential path", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RealtimeVoiceSettings />);

    await user.type(
      screen.getByLabelText("OpenAI Realtime API key"),
      " sk-shared ",
    );
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(openAiVoiceMocks.setApiKey).toHaveBeenCalledWith(" sk-shared ");
  });

  it("reveals the supported advanced session controls", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RealtimeVoiceSettings />);

    await user.click(screen.getByRole("button", { name: "Advanced" }));

    expect(
      screen.getByRole("switch", { name: "Respond automatically" }),
    ).toBeChecked();
    expect(
      screen.getByRole("combobox", { name: "Reasoning effort" }),
    ).toHaveTextContent("Model default");
    expect(
      screen.getByRole("combobox", { name: "Noise reduction" }),
    ).toHaveTextContent("Off");
    expect(
      screen.getByRole("slider", { name: "Voice activation threshold" }),
    ).toBeInTheDocument();
  });
});
