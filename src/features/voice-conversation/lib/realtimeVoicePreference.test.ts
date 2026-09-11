import { beforeEach, describe, expect, it } from "vitest";

import {
  getDefaultRealtimeVoicePreference,
  getRealtimeVoicePreference,
  setRealtimeVoicePreference,
} from "./realtimeVoicePreference";

describe("GPT Live preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("stores only voice and presentation", () => {
    setRealtimeVoicePreference({ voice: "marin", presentationMode: "subtle" });
    expect(getRealtimeVoicePreference()).toEqual({
      voice: "marin",
      presentationMode: "subtle",
    });
  });

  it("ignores obsolete Realtime fields from existing storage", () => {
    window.localStorage.setItem(
      "goose:openai-realtime-voice-options",
      JSON.stringify({
        voice: "cedar",
        model: "old",
        turnDetection: "server_vad",
      }),
    );
    expect(getRealtimeVoicePreference()).toEqual({
      ...getDefaultRealtimeVoicePreference(),
      voice: "cedar",
    });
  });
});
