import { beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/shared/telemetry/client", () => ({ track }));

import {
  clearRequestedVoiceConversationEnd,
  requestVoiceConversationEnd,
  resetVoiceTelemetryForTest,
  trackVoiceAssistantResponse,
  trackVoiceConversationEnded,
  trackVoiceConversationStarted,
  trackVoiceUserUtterance,
} from "./voiceTelemetry";

const context = {
  inputBackend: "macos" as const,
  outputBackend: "siri" as const,
  voiceMode: "chained" as const,
};

describe("voice conversation telemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    track.mockReset();
    resetVoiceTelemetryForTest();
  });

  it("emits one self-contained lifecycle with aggregate counts", () => {
    trackVoiceConversationStarted(context);
    trackVoiceConversationStarted(context);
    trackVoiceUserUtterance();
    trackVoiceUserUtterance();
    trackVoiceAssistantResponse();
    vi.advanceTimersByTime(2_500);
    requestVoiceConversationEnd("controls-dismissed");
    trackVoiceConversationEnded("clean-shutdown");
    trackVoiceConversationEnded("error");

    expect(track).toHaveBeenCalledTimes(2);
    expect(track.mock.calls[0][0]).toMatchObject({
      name: "berd_voice_conversation_started",
      parameters: {
        input_backend: "macos",
        output_backend: "siri",
        voice_mode: "chained",
      },
    });
    expect(track.mock.calls[1][0]).toEqual({
      name: "berd_voice_conversation_ended",
      parameters: {
        input_backend: "macos",
        output_backend: "siri",
        voice_mode: "chained",
        duration_ms: "2500",
        user_utterance_count: "2",
        assistant_response_count: "1",
        end_reason: "controls-dismissed",
      },
    });
  });

  it("clears a failed stop intent before a later terminal event", () => {
    trackVoiceConversationStarted(context);
    requestVoiceConversationEnd("user");
    clearRequestedVoiceConversationEnd();
    trackVoiceConversationEnded("error");

    expect(track.mock.calls[1][0].parameters.end_reason).toBe("error");
  });
});
