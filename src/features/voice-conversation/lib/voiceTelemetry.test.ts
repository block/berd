import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@/shared/telemetry/events";

const mocks = vi.hoisted(() => ({
  track: vi.fn((_event: Event): boolean => true),
}));
vi.mock("@/shared/telemetry/client", () => ({ track: mocks.track }));

import {
  clearRequestedVoiceConversationEnd,
  requestVoiceConversationEnd,
  resetVoiceTelemetryForTest,
  resetVoiceTelemetryMemoryForTest,
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
    mocks.track.mockReset().mockReturnValue(true);
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

    expect(mocks.track).toHaveBeenCalledTimes(2);
    expect(mocks.track.mock.calls[0][0]).toMatchObject({
      name: "berd_voice_conversation_started",
      parameters: {
        input_backend: "macos",
        output_backend: "siri",
        voice_mode: "chained",
      },
    });
    expect(mocks.track.mock.calls[1][0]).toEqual({
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

    expect(mocks.track.mock.calls[1][0].parameters.end_reason).toBe("error");
  });
  it("finishes a lifecycle after its owner renderer is destroyed", () => {
    trackVoiceConversationStarted(context);
    trackVoiceUserUtterance();
    resetVoiceTelemetryMemoryForTest();
    trackVoiceConversationEnded("clean-shutdown");

    expect(mocks.track.mock.calls[1][0].parameters).toMatchObject({
      user_utterance_count: "1",
      end_reason: "clean-shutdown",
    });
  });

  it("lets a new renderer replace stale lifecycle storage", () => {
    trackVoiceConversationStarted(context);
    resetVoiceTelemetryMemoryForTest();
    trackVoiceConversationStarted({
      inputBackend: "parakeet",
      outputBackend: "pocket",
      voiceMode: "chained",
    });
    trackVoiceConversationEnded("user");

    expect(mocks.track).toHaveBeenCalledTimes(3);
    expect(mocks.track.mock.calls[2][0].parameters).toMatchObject({
      input_backend: "parakeet",
      output_backend: "pocket",
    });
  });

  it("does not let another renderer add to the owner's aggregate", () => {
    trackVoiceConversationStarted(context);
    resetVoiceTelemetryMemoryForTest();
    trackVoiceUserUtterance();
    trackVoiceAssistantResponse();
    trackVoiceConversationEnded("clean-shutdown");

    expect(mocks.track.mock.calls[1][0].parameters).toMatchObject({
      user_utterance_count: "0",
      assistant_response_count: "0",
    });
  });

  it("does not emit an end aggregate when the start is rejected", () => {
    mocks.track.mockReturnValueOnce(false);
    trackVoiceConversationStarted(context);
    trackVoiceUserUtterance();
    trackVoiceConversationEnded("user");

    expect(mocks.track).toHaveBeenCalledOnce();
  });
});
