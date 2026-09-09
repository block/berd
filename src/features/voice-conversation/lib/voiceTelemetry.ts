import { invoke } from "@tauri-apps/api/core";
import {
  getRendererInstance,
  type RendererInstance,
} from "@/shared/lib/rendererInstance";
import { track } from "@/shared/telemetry/client";
import {
  berdVoiceConversationEnded,
  berdVoiceConversationStarted,
  type BerdVoiceConversationEndReason,
  type BerdVoiceConversationMode,
} from "@/shared/telemetry/events";
import type { VoiceInputBackend } from "./voiceInputPreference";
import type { VoiceOutputBackend } from "./voiceOutputPreference";

export interface VoiceConversationTelemetryContext {
  inputBackend: VoiceInputBackend;
  outputBackend: VoiceOutputBackend;
  voiceMode: BerdVoiceConversationMode;
}

interface CompletedVoiceConversationTelemetry {
  inputBackend: VoiceInputBackend;
  outputBackend: VoiceOutputBackend;
  voiceMode: BerdVoiceConversationMode;
  durationMs: number;
  userUtteranceCount: number;
  assistantResponseCount: number;
  endReason: BerdVoiceConversationEndReason;
  reportable: boolean;
}

let pendingOperation: Promise<void> = Promise.resolve();

function enqueue(
  operation: (renderer: RendererInstance) => Promise<void>,
): void {
  const renderer = getRendererInstance();
  pendingOperation = pendingOperation
    .then(() => renderer)
    .then(operation)
    .catch((error) => {
      console.warn("Voice conversation telemetry accounting failed", error);
    });
}

function ownerRequest(renderer: RendererInstance) {
  return {
    rendererId: renderer.rendererId,
    rendererEpoch: renderer.rendererEpoch,
  };
}

/** Starts aggregate telemetry only after voice startup succeeds. */
export function trackVoiceConversationStarted(
  context: VoiceConversationTelemetryContext,
): void {
  enqueue(async (renderer) => {
    const started = await invoke<boolean>(
      "start_voice_conversation_telemetry",
      {
        request: {
          ...ownerRequest(renderer),
          inputBackend: context.inputBackend,
          outputBackend: context.outputBackend,
          voiceMode: context.voiceMode,
        },
      },
    );
    if (!started) return;
    const reportable = track(
      berdVoiceConversationStarted({
        input_backend: context.inputBackend,
        output_backend: context.outputBackend,
        voice_mode: context.voiceMode,
      }),
    );
    await invoke("set_voice_conversation_telemetry_reportable", {
      request: ownerRequest(renderer),
      reportable,
    });
  });
}

export function trackVoiceUserUtterance(): void {
  enqueue(async (renderer) => {
    await invoke("increment_voice_conversation_user_utterances", {
      request: ownerRequest(renderer),
    });
  });
}

export function trackVoiceAssistantResponse(): void {
  enqueue(async (renderer) => {
    await invoke("increment_voice_conversation_assistant_responses", {
      request: ownerRequest(renderer),
    });
  });
}

/** Preserves the initiating action while asynchronous shutdown completes. */
export function requestVoiceConversationEnd(
  reason: BerdVoiceConversationEndReason,
): void {
  enqueue(async (renderer) => {
    await invoke("request_voice_conversation_telemetry_end", {
      request: ownerRequest(renderer),
      reason,
    });
  });
}

export function clearRequestedVoiceConversationEnd(): void {
  enqueue(async (renderer) => {
    await invoke("clear_voice_conversation_telemetry_end", {
      request: ownerRequest(renderer),
    });
  });
}

/** Emits one self-contained end record; repeated terminal signals are ignored. */
export function trackVoiceConversationEnded(
  fallbackReason: BerdVoiceConversationEndReason,
): void {
  enqueue(async () => {
    const conversation =
      await invoke<CompletedVoiceConversationTelemetry | null>(
        "end_voice_conversation_telemetry",
        { request: { fallbackReason } },
      );
    if (!conversation?.reportable) return;
    track(
      berdVoiceConversationEnded({
        input_backend: conversation.inputBackend,
        output_backend: conversation.outputBackend,
        voice_mode: conversation.voiceMode,
        duration_ms: conversation.durationMs,
        user_utterance_count: conversation.userUtteranceCount,
        assistant_response_count: conversation.assistantResponseCount,
        end_reason: conversation.endReason,
      }),
    );
  });
}

export async function flushVoiceTelemetryForTest(): Promise<void> {
  await pendingOperation;
}

export function resetVoiceTelemetryForTest(): void {
  pendingOperation = Promise.resolve();
}
