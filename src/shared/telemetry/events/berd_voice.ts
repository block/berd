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
  input_backend: BerdVoiceConversationBackend;
  output_backend: BerdVoiceConversationBackend;
  voice_mode: BerdVoiceConversationMode;
  /** Starting playback multiplier; omitted when the backend rate is unavailable. */
  tts_rate?: number | null;
}

export interface BerdVoiceConversationEndedParams
  extends BerdVoiceConversationContextParams {
  duration_ms: number;
  user_utterance_count: number;
  assistant_response_count: number;
  end_reason: BerdVoiceConversationEndReason;
}

function contextParameters(
  params: BerdVoiceConversationContextParams,
): Event["parameters"] {
  return {
    input_backend: params.input_backend,
    output_backend: params.output_backend,
    voice_mode: params.voice_mode,
    ...(params.tts_rate == null ? {} : { tts_rate: String(params.tts_rate) }),
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
      duration_ms: String(params.duration_ms),
      user_utterance_count: String(params.user_utterance_count),
      assistant_response_count: String(params.assistant_response_count),
      end_reason: params.end_reason,
    },
  };
}
