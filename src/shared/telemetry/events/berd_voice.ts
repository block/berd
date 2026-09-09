// Vendored-style typed telemetry event factories. Berd's event modules are
// maintained locally; keep these names and parameter shapes aligned with the
// versioned allowlist in squareup/berd-monitoring.

import type { Event } from "./event";

export type BerdVoiceConversationBackend =
  | "parakeet"
  | "macos"
  | "pocket"
  | "siri"
  | "openai";
export type BerdVoiceConversationMode = "chained" | "openai-realtime";
export type BerdVoiceConversationEndReason =
  | "user"
  | "replacement"
  | "controls-dismissed"
  | "clean-shutdown"
  | "error";

export interface BerdVoiceConversationContextParams {
  inputBackend: BerdVoiceConversationBackend;
  outputBackend: BerdVoiceConversationBackend;
  voiceMode: BerdVoiceConversationMode;
}

export interface BerdVoiceConversationEndedParams
  extends BerdVoiceConversationContextParams {
  durationMs: number;
  userUtteranceCount: number;
  assistantResponseCount: number;
  endReason: BerdVoiceConversationEndReason;
}

function contextParameters(
  params: BerdVoiceConversationContextParams,
): Event["parameters"] {
  return {
    input_backend: params.inputBackend,
    output_backend: params.outputBackend,
    voice_mode: params.voiceMode,
  };
}

/** Counts a voice conversation only after its selected runtime starts. */
export function berdVoiceConversationStarted(
  params: BerdVoiceConversationContextParams,
): Event {
  return {
    name: "berd_voice_conversation_started",
    parameters: contextParameters(params),
  };
}

/** Records aggregate engagement without a conversation or human identifier. */
export function berdVoiceConversationEnded(
  params: BerdVoiceConversationEndedParams,
): Event {
  return {
    name: "berd_voice_conversation_ended",
    parameters: {
      ...contextParameters(params),
      duration_ms: String(params.durationMs),
      user_utterance_count: String(params.userUtteranceCount),
      assistant_response_count: String(params.assistantResponseCount),
      end_reason: params.endReason,
    },
  };
}
