import { beforeEach, describe, expect, it } from "vitest";
import {
  getVoiceConversationMode,
  setVoiceConversationMode,
} from "./voiceConversationModePreference";

describe("voice conversation mode preference", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to the existing chained pipeline", () => {
    expect(getVoiceConversationMode()).toBe("chained");
  });

  it("persists OpenAI Realtime mode", () => {
    setVoiceConversationMode("openai-realtime");
    expect(getVoiceConversationMode()).toBe("openai-realtime");
  });
});
