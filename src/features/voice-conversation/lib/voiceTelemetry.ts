import {
  startVoiceTelemetry,
  setVoiceTelemetryReportable,
  incrementVoiceUserUtterances,
  incrementVoiceAssistantResponses,
  requestVoiceTelemetryEnd,
  clearVoiceTelemetryEnd,
  endVoiceTelemetry,
  type VoiceConversationTelemetryContext,
} from "../api/voiceTelemetry";
export type { VoiceConversationTelemetryContext } from "../api/voiceTelemetry";
import {
  getRendererInstance,
  type RendererInstance,
} from "@/shared/lib/rendererInstance";
import { track } from "@/shared/telemetry/client";
import {
  berdVoiceConversationEnded,
  berdVoiceConversationStarted,
  type BerdVoiceConversationEndReason,
} from "@/shared/telemetry/events";

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

/** Starts aggregate telemetry only after voice startup succeeds. */
export function trackVoiceConversationStarted(
  context: VoiceConversationTelemetryContext,
): void {
  enqueue(async (renderer) => {
    const started = await startVoiceTelemetry(renderer, context);
    if (!started) return;
    const reportable = track(
      berdVoiceConversationStarted({
        input_backend: context.inputBackend,
        output_backend: context.outputBackend,
        voice_mode: context.voiceMode,
      }),
    );
    await setVoiceTelemetryReportable(renderer, reportable);
  });
}

export function trackVoiceUserUtterance(): void {
  enqueue(async (renderer) => {
    await incrementVoiceUserUtterances(renderer);
  });
}

export function trackVoiceAssistantResponse(): void {
  enqueue(async (renderer) => {
    await incrementVoiceAssistantResponses(renderer);
  });
}

/** Preserves the initiating action while asynchronous shutdown completes. */
export function requestVoiceConversationEnd(
  reason: BerdVoiceConversationEndReason,
): void {
  enqueue(async (renderer) => {
    await requestVoiceTelemetryEnd(renderer, reason);
  });
}

export function clearRequestedVoiceConversationEnd(): void {
  enqueue(async (renderer) => {
    await clearVoiceTelemetryEnd(renderer);
  });
}

/** Emits one self-contained end record; repeated terminal signals are ignored. */
export function trackVoiceConversationEnded(
  fallbackReason: BerdVoiceConversationEndReason,
): void {
  enqueue(async () => {
    const conversation = await endVoiceTelemetry(fallbackReason);
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
