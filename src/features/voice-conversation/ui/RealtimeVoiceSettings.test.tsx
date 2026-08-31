import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/shared/i18n";
import { renderWithProviders } from "@/test/render";
import { RealtimeVoiceSettings } from "./RealtimeVoiceSettings";

const realtimeApiMocks = vi.hoisted(() => ({
  getStatus: vi.fn(() =>
    Promise.resolve({
      voiceConfigured: true,
      configurationSource: "keychain" as const,
      baseUrlSource: "default" as const,
    }),
  ),
  saveApiKey: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/shared/api/openaiRealtime", () => ({
  getOpenAiRealtimeStatus: realtimeApiMocks.getStatus,
  saveOpenAiRealtimeApiKey: realtimeApiMocks.saveApiKey,
}));

describe("RealtimeVoiceSettings", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    realtimeApiMocks.getStatus.mockClear();
    realtimeApiMocks.saveApiKey.mockClear();
    await i18n.changeLanguage("en");
  });

  it("shows recommended model, transcription, voice, and turn controls", () => {
    renderWithProviders(<RealtimeVoiceSettings />);

    expect(
      screen.getByRole("combobox", { name: "Realtime model" }),
    ).toHaveTextContent("gpt-realtime-2.1");
    expect(
      screen.getByRole("combobox", { name: "Transcription model" }),
    ).toHaveTextContent("gpt-realtime-whisper");
    expect(screen.getByRole("combobox", { name: "Voice" })).toHaveTextContent(
      "Marin",
    );
    expect(
      screen.getByRole("combobox", { name: "Turn detection" }),
    ).toHaveTextContent("Server VAD");
    expect(
      screen.getByRole("switch", { name: "Interrupt when I speak" }),
    ).toBeChecked();
  });

  it("reveals advanced session controls without replacing raw overrides", async () => {
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
    expect(screen.getByLabelText("Advanced session options")).toHaveValue("{}");
  });
});
