import { beforeEach, describe, expect, it } from "vitest";
import {
  getRealtimeVoicePreference,
  setRealtimeVoicePreference,
} from "./realtimeVoicePreference";

describe("realtime voice preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns a stable default snapshot", () => {
    expect(getRealtimeVoicePreference()).toBe(getRealtimeVoicePreference());
    expect(getRealtimeVoicePreference()).toMatchObject({
      presentationMode: "debug",
      model: "gpt-realtime-2.1",
      transcriptionModel: "gpt-realtime-whisper",
      voice: "marin",
      speed: 1,
      turnDetection: "server_vad",
      interruptResponse: true,
      createResponse: true,
    });
  });

  it("persists an updated configuration without storing a secret", () => {
    const preference = {
      ...getRealtimeVoicePreference(),
      model: "gpt-realtime-2.1",
      transcriptionModel: "gpt-live-transcribe",
      voice: "cedar",
      speed: 1.25,
      presentationMode: "subtle" as const,
      turnDetection: "semantic_vad" as const,
      eagerness: "high" as const,
    };
    setRealtimeVoicePreference(preference);
    expect(getRealtimeVoicePreference()).toBe(preference);
    expect(
      window.localStorage.getItem("goose:openai-realtime-voice-options"),
    ).not.toContain("apiKey");
  });

  it("falls back to normal speed when persisted speed is out of range", () => {
    window.localStorage.setItem(
      "goose:openai-realtime-voice-options",
      JSON.stringify({ speed: 2 }),
    );

    expect(getRealtimeVoicePreference().speed).toBe(1);
  });

  it("rounds and clamps persisted integer-only settings", () => {
    window.localStorage.setItem(
      "goose:openai-realtime-voice-options",
      JSON.stringify({
        prefixPaddingMs: -20.4,
        silenceDurationMs: 3_500.6,
        idleTimeoutMs: 1_499.5,
        maxOutputTokens: 4_500.2,
      }),
    );

    expect(getRealtimeVoicePreference()).toMatchObject({
      prefixPaddingMs: 0,
      silenceDurationMs: 3_000,
      idleTimeoutMs: 1_500,
      maxOutputTokens: 4_096,
    });
  });
});
