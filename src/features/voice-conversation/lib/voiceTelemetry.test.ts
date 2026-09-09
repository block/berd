import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@/shared/telemetry/events";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  renderer: { rendererId: "renderer-test", rendererEpoch: 7 },
  track: vi.fn((_event: Event): boolean => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/shared/lib/rendererInstance", () => ({
  getRendererInstance: () => Promise.resolve({ ...mocks.renderer }),
}));
vi.mock("@/shared/telemetry/client", () => ({ track: mocks.track }));

import {
  clearRequestedVoiceConversationEnd,
  flushVoiceTelemetryForTest,
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
  ttsRate: 1.25,
};

type NativeAggregate = {
  owner: typeof mocks.renderer;
  reportable: boolean;
  userUtteranceCount: number;
  assistantResponseCount: number;
  requestedEndReason: string | null;
} | null;

function installNativeAccounting() {
  let aggregate: NativeAggregate = null;
  mocks.invoke.mockImplementation(async (command, args) => {
    const request = args?.request;
    if (command === "start_voice_conversation_telemetry") {
      if (aggregate) return false;
      aggregate = {
        owner: {
          rendererId: request.rendererId,
          rendererEpoch: request.rendererEpoch,
        },
        reportable: false,
        userUtteranceCount: 0,
        assistantResponseCount: 0,
        requestedEndReason: null,
      };
      return true;
    }
    if (command === "set_voice_conversation_telemetry_reportable") {
      if (aggregate) aggregate.reportable = args.reportable;
      return;
    }
    if (command === "end_voice_conversation_telemetry") {
      if (!aggregate) return null;
      const completed = {
        inputBackend: "macos",
        outputBackend: "siri",
        voiceMode: "chained",
        ttsRate: 1.25,
        durationMs: 2500,
        userUtteranceCount: aggregate.userUtteranceCount,
        assistantResponseCount: aggregate.assistantResponseCount,
        endReason: aggregate.requestedEndReason ?? request.fallbackReason,
        reportable: aggregate.reportable,
      };
      aggregate = null;
      return completed;
    }
    if (
      !aggregate ||
      aggregate.owner.rendererId !== request.rendererId ||
      aggregate.owner.rendererEpoch !== request.rendererEpoch
    )
      return;
    if (command === "increment_voice_conversation_user_utterances")
      aggregate.userUtteranceCount += 1;
    if (command === "increment_voice_conversation_assistant_responses")
      aggregate.assistantResponseCount += 1;
    if (command === "request_voice_conversation_telemetry_end")
      aggregate.requestedEndReason = args.reason;
    if (command === "clear_voice_conversation_telemetry_end")
      aggregate.requestedEndReason = null;
  });
}

describe("voice conversation telemetry", () => {
  beforeEach(() => {
    mocks.track.mockReset().mockReturnValue(true);
    mocks.invoke.mockReset();
    mocks.renderer.rendererId = "renderer-test";
    mocks.renderer.rendererEpoch = 7;
    resetVoiceTelemetryForTest();
    installNativeAccounting();
  });

  it("emits one self-contained lifecycle with aggregate counts", async () => {
    trackVoiceConversationStarted(context);
    trackVoiceUserUtterance();
    trackVoiceUserUtterance();
    trackVoiceAssistantResponse();
    requestVoiceConversationEnd("controls-dismissed");
    trackVoiceConversationEnded("clean-shutdown");
    trackVoiceConversationEnded("error");
    await flushVoiceTelemetryForTest();

    expect(mocks.track).toHaveBeenCalledTimes(2);
    expect(mocks.track.mock.calls[1][0]).toEqual({
      name: "berd_voice_conversation_ended",
      parameters: {
        input_backend: "macos",
        output_backend: "siri",
        voice_mode: "chained",
        tts_rate: "1.25",
        duration_ms: "2500",
        user_utterance_count: "2",
        assistant_response_count: "1",
        end_reason: "controls-dismissed",
      },
    });
  });

  it("clears a failed stop intent before a later terminal event", async () => {
    trackVoiceConversationStarted(context);
    requestVoiceConversationEnd("user");
    clearRequestedVoiceConversationEnd();
    trackVoiceConversationEnded("error");
    await flushVoiceTelemetryForTest();
    expect(mocks.track.mock.calls[1][0].parameters.end_reason).toBe("error");
  });

  it("keeps accounting when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    trackVoiceConversationStarted(context);
    trackVoiceUserUtterance();
    trackVoiceConversationEnded("user");
    await flushVoiceTelemetryForTest();
    expect(mocks.track.mock.calls[1][0].parameters.user_utterance_count).toBe(
      "1",
    );
  });

  it("ignores updates from a non-owning renderer", async () => {
    trackVoiceConversationStarted(context);
    mocks.renderer.rendererId = "replacement-renderer";
    mocks.renderer.rendererEpoch = 8;
    trackVoiceUserUtterance();
    trackVoiceAssistantResponse();
    trackVoiceConversationEnded("clean-shutdown");
    await flushVoiceTelemetryForTest();
    expect(mocks.track.mock.calls[1][0].parameters).toMatchObject({
      user_utterance_count: "0",
      assistant_response_count: "0",
    });
  });

  it("does not emit an end aggregate when the start is rejected", async () => {
    mocks.track.mockReturnValueOnce(false);
    trackVoiceConversationStarted(context);
    trackVoiceUserUtterance();
    trackVoiceConversationEnded("user");
    await flushVoiceTelemetryForTest();
    expect(mocks.track).toHaveBeenCalledOnce();
  });
});
