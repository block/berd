import { track } from "@/shared/telemetry/client";
import {
  berdVoiceConversationEnded,
  berdVoiceConversationStarted,
  type BerdVoiceConversationBackend,
  type BerdVoiceConversationEndReason,
  type BerdVoiceConversationMode,
} from "@/shared/telemetry/events";

export interface VoiceConversationTelemetryContext {
  inputBackend: BerdVoiceConversationBackend;
  outputBackend: BerdVoiceConversationBackend;
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
  track(berdVoiceConversationStarted(context));
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
      inputBackend: conversation.inputBackend,
      outputBackend: conversation.outputBackend,
      voiceMode: conversation.voiceMode,
      durationMs: Math.max(0, Date.now() - conversation.startedAt),
      userUtteranceCount: conversation.userUtteranceCount,
      assistantResponseCount: conversation.assistantResponseCount,
      endReason: conversation.requestedEndReason ?? fallbackReason,
    }),
  );
}

export function resetVoiceTelemetryForTest(): void {
  activeConversation = null;
}
