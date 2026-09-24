import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/shared/i18n";
import { renderWithProviders } from "@/test/render";
import { RealtimeVoiceSettings } from "./RealtimeVoiceSettings";

const openAiVoiceMocks = vi.hoisted(() => ({
  clearApiKey: vi.fn(() => Promise.resolve()),
  getStatus: vi.fn(() => Promise.resolve({ realtimeConfigured: true })),
  getEndpoints: vi.fn(() =>
    Promise.resolve({ realtime: null, stt: null, tts: null }),
  ),
  setEndpoint: vi.fn(() => Promise.resolve()),
  listenToSettings: vi.fn(() => Promise.resolve(() => undefined)),
  setApiKey: vi.fn(() => Promise.resolve()),
}));

vi.mock("../api/openAiVoice", () => ({
  clearOpenAiRealtimeApiKey: openAiVoiceMocks.clearApiKey,
  getOpenAiVoiceEndpoints: openAiVoiceMocks.getEndpoints,
  setOpenAiVoiceEndpoint: openAiVoiceMocks.setEndpoint,
  getOpenAiVoiceStatus: openAiVoiceMocks.getStatus,
  listenToOpenAiVoiceSettings: openAiVoiceMocks.listenToSettings,
  setOpenAiRealtimeApiKey: openAiVoiceMocks.setApiKey,
}));

describe("RealtimeVoiceSettings", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
  });

  it("keeps the voice primary and provider tuning under Advanced", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RealtimeVoiceSettings />);

    expect(
      screen.getByRole("button", {
        name: "Choose a voice: Marin (default)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Playback speed" }),
    ).toHaveTextContent("1×");
    expect(
      screen.queryByRole("combobox", { name: "Realtime model" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Interrupt when I speak" }),
    ).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Advanced" }));

    expect(
      screen.getByRole("combobox", { name: "Realtime model" }),
    ).toHaveTextContent("gpt-realtime-2.1 (default)");
    expect(
      screen.getByRole("combobox", { name: "STT model" }),
    ).toHaveTextContent("gpt-realtime-whisper (default)");
    expect(
      screen.getByRole("combobox", { name: "Turn detection" }),
    ).toHaveTextContent("Server VAD (default)");
    expect(
      screen.getByRole("combobox", { name: "Conversation presentation" }),
    ).toHaveTextContent("Debug — show agent routing");
  });

  it("shows the default realtime URL above its URL-scoped key", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RealtimeVoiceSettings />);

    expect(screen.getByLabelText("Realtime endpoint URL")).toHaveAttribute(
      "placeholder",
      "wss://api.openai.com/v1/realtime",
    );
    await user.type(
      screen.getByLabelText("Realtime endpoint URL"),
      "ws://127.0.0.1:18870/v1/realtime",
    );
    await user.click(screen.getByRole("button", { name: "Save URL" }));
    expect(openAiVoiceMocks.setEndpoint).toHaveBeenCalledWith(
      "realtime",
      "ws://127.0.0.1:18870/v1/realtime",
    );

    await user.type(screen.getByLabelText("OpenAI API key"), " sk-shared ");
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

  it("rounds and clamps integer-only advanced controls", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RealtimeVoiceSettings />);

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.change(screen.getByLabelText("Maximum response tokens"), {
      target: { value: "5000.4" },
    });
    fireEvent.change(screen.getByLabelText("End pause (ms)"), {
      target: { value: "250.7" },
    });
    fireEvent.change(screen.getByLabelText("Speech lead-in (ms)"), {
      target: { value: "-20" },
    });
    fireEvent.change(screen.getByLabelText("Idle timeout (ms)"), {
      target: { value: "1499.5" },
    });

    expect(
      JSON.parse(
        window.localStorage.getItem("goose:openai-realtime-voice-options") ??
          "{}",
      ),
    ).toMatchObject({
      maxOutputTokens: 4_096,
      silenceDurationMs: 251,
      prefixPaddingMs: 0,
      idleTimeoutMs: 1_500,
    });
  });
});
