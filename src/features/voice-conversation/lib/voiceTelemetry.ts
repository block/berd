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

interface ActiveVoiceConversationTelemetry
  extends VoiceConversationTelemetryContext {
  startedAt: number;
  userUtteranceCount: number;
  assistantResponseCount: number;
  requestedEndReason: BerdVoiceConversationEndReason | null;
}

let activeConversation: ActiveVoiceConversationTelemetry | null = null;

/** Starts aggregate telemetry only after voice startup succeeds. */
export function trackVoiceConversationStarted(
  context: VoiceConversationTelemetryContext,
): void {
  if (activeConversation) return;
  activeConversation = {
    ...context,
    startedAt: Date.now(),
    userUtteranceCount: 0,
    assistantResponseCount: 0,
    requestedEndReason: null,
  };
  track(
    berdVoiceConversationStarted({
      input_backend: context.inputBackend,
      output_backend: context.outputBackend,
      voice_mode: context.voiceMode,
    }),
  );
}

export function trackVoiceUserUtterance(): void {
  if (activeConversation) activeConversation.userUtteranceCount += 1;
}

export function trackVoiceAssistantResponse(): void {
  if (activeConversation) activeConversation.assistantResponseCount += 1;
}

/** Preserves the initiating action while asynchronous shutdown completes. */
export function requestVoiceConversationEnd(
  reason: BerdVoiceConversationEndReason,
): void {
  if (activeConversation) activeConversation.requestedEndReason = reason;
}

export function clearRequestedVoiceConversationEnd(): void {
  if (activeConversation) activeConversation.requestedEndReason = null;
}

/** Emits one self-contained end record; repeated terminal signals are ignored. */
export function trackVoiceConversationEnded(
  fallbackReason: BerdVoiceConversationEndReason,
): void {
  const conversation = activeConversation;
  if (!conversation) return;
  activeConversation = null;
  track(
    berdVoiceConversationEnded({
      input_backend: conversation.inputBackend,
      output_backend: conversation.outputBackend,
      voice_mode: conversation.voiceMode,
      duration_ms: Math.max(0, Date.now() - conversation.startedAt),
      user_utterance_count: conversation.userUtteranceCount,
      assistant_response_count: conversation.assistantResponseCount,
      end_reason: conversation.requestedEndReason ?? fallbackReason,
    }),
  );
}

export function resetVoiceTelemetryForTest(): void {
  activeConversation = null;
}
