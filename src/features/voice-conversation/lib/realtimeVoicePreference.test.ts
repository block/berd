import { beforeEach, describe, expect, it } from "vitest";
import {
  getRealtimeVoicePreference,
  parseRealtimeSessionOverrides,
  setRealtimeVoicePreference,
} from "./realtimeVoicePreference";

describe("realtime voice preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("returns a stable default snapshot", () => {
    expect(getRealtimeVoicePreference()).toBe(getRealtimeVoicePreference());
    expect(getRealtimeVoicePreference()).toMatchObject({
      model: "gpt-realtime",
      voice: "marin",
      speed: 1,
    });
  });

  it("persists an updated configuration without storing a secret", () => {
    const preference = {
      model: "gpt-realtime-2.1",
      transcriptionModel: "gpt-4o-mini-transcribe",
      voice: "cedar",
      speed: 1.25,
      sessionOverridesText: '{"audio":{"input":{"turn_detection":null}}}',
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

  it("accepts only JSON objects as advanced session overrides", () => {
    expect(parseRealtimeSessionOverrides('{"max_output_tokens":128}')).toEqual({
      max_output_tokens: 128,
    });
    expect(() => parseRealtimeSessionOverrides("[]")).toThrow("JSON object");
  });
});
