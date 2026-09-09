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
  reportable: boolean;
  ownerToken: string;
}

const ACTIVE_CONVERSATION_STORAGE_KEY =
  "goose:voice-conversation-telemetry-active-v1";
const OWNER_TOKEN_SESSION_KEY = "goose:voice-conversation-telemetry-owner-v1";

let activeConversation: ActiveVoiceConversationTelemetry | null = null;

function elapsedTimeNow(): number {
  // Comparable across renderer time origins while remaining monotonic within
  // each renderer after it starts.
  return performance.timeOrigin + performance.now();
}

function currentOwnerToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(OWNER_TOKEN_SESSION_KEY);
  } catch {
    return null;
  }
}

function createOwnerToken(): string {
  const token = crypto.randomUUID();
  try {
    window.sessionStorage.setItem(OWNER_TOKEN_SESSION_KEY, token);
  } catch {
    // The in-memory aggregate still covers this renderer's lifecycle.
  }
  return token;
}

function persistActiveConversation(): void {
  if (typeof window === "undefined") return;
  try {
    if (activeConversation) {
      window.localStorage.setItem(
        ACTIVE_CONVERSATION_STORAGE_KEY,
        JSON.stringify(activeConversation),
      );
    } else {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    }
  } catch {
    // Renderer-local state still covers the normal single-window lifecycle.
  }
}

function restoreActiveConversation(): ActiveVoiceConversationTelemetry | null {
  if (activeConversation || typeof window === "undefined")
    return activeConversation;
  try {
    const stored = window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    if (!stored) return null;
    const candidate = JSON.parse(stored) as ActiveVoiceConversationTelemetry;
    if (
      typeof candidate.startedAt !== "number" ||
      typeof candidate.userUtteranceCount !== "number" ||
      typeof candidate.assistantResponseCount !== "number" ||
      typeof candidate.reportable !== "boolean" ||
      typeof candidate.ownerToken !== "string"
    ) {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
      return null;
    }
    activeConversation = candidate;
    return candidate;
  } catch {
    return null;
  }
}

function conversationForOwnerUpdate(): ActiveVoiceConversationTelemetry | null {
  const conversation = restoreActiveConversation();
  return conversation?.ownerToken === currentOwnerToken() ? conversation : null;
}

/** Starts aggregate telemetry only after voice startup succeeds. */
export function trackVoiceConversationStarted(
  context: VoiceConversationTelemetryContext,
): void {
  if (conversationForOwnerUpdate()) return;
  activeConversation = {
    ...context,
    startedAt: elapsedTimeNow(),
    userUtteranceCount: 0,
    assistantResponseCount: 0,
    requestedEndReason: null,
    reportable: false,
    ownerToken: createOwnerToken(),
  };
  activeConversation.reportable = track(
    berdVoiceConversationStarted({
      input_backend: context.inputBackend,
      output_backend: context.outputBackend,
      voice_mode: context.voiceMode,
    }),
  );
  persistActiveConversation();
}

export function trackVoiceUserUtterance(): void {
  const conversation = conversationForOwnerUpdate();
  if (!conversation?.reportable) return;
  conversation.userUtteranceCount += 1;
  persistActiveConversation();
}

export function trackVoiceAssistantResponse(): void {
  const conversation = conversationForOwnerUpdate();
  if (!conversation?.reportable) return;
  conversation.assistantResponseCount += 1;
  persistActiveConversation();
}

/** Preserves the initiating action while asynchronous shutdown completes. */
export function requestVoiceConversationEnd(
  reason: BerdVoiceConversationEndReason,
): void {
  const conversation = conversationForOwnerUpdate();
  if (!conversation) return;
  conversation.requestedEndReason = reason;
  persistActiveConversation();
}

export function clearRequestedVoiceConversationEnd(): void {
  const conversation = conversationForOwnerUpdate();
  if (!conversation) return;
  conversation.requestedEndReason = null;
  persistActiveConversation();
}

/** Emits one self-contained end record; repeated terminal signals are ignored. */
export function trackVoiceConversationEnded(
  fallbackReason: BerdVoiceConversationEndReason,
): void {
  const conversation = restoreActiveConversation();
  if (!conversation) return;
  activeConversation = null;
  persistActiveConversation();
  if (!conversation.reportable) return;
  track(
    berdVoiceConversationEnded({
      input_backend: conversation.inputBackend,
      output_backend: conversation.outputBackend,
      voice_mode: conversation.voiceMode,
      duration_ms: Math.max(0, elapsedTimeNow() - conversation.startedAt),
      user_utterance_count: conversation.userUtteranceCount,
      assistant_response_count: conversation.assistantResponseCount,
      end_reason: conversation.requestedEndReason ?? fallbackReason,
    }),
  );
}

export function resetVoiceTelemetryForTest(): void {
  activeConversation = null;
  persistActiveConversation();
  try {
    window.sessionStorage.removeItem(OWNER_TOKEN_SESSION_KEY);
  } catch {
    // Tests can replace storage with an unavailable implementation.
  }
}

export function resetVoiceTelemetryMemoryForTest(): void {
  activeConversation = null;
  try {
    window.sessionStorage.removeItem(OWNER_TOKEN_SESSION_KEY);
  } catch {
    // Tests can replace storage with an unavailable implementation.
  }
}
