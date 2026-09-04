import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VoiceConversationStatus } from "@/features/voice-conversation/api/voiceConversation";
import { getRendererInstance } from "@/shared/lib/rendererInstance";
import { shareInFlight } from "@/shared/lib/shareInFlight";

export interface OpenAiRealtimeStatus {
  configured: boolean;
}

export interface OpenAiRealtimeSession {
  clientSecret: string;
}

export interface OpenAiRealtimeRuntimeEvent {
  sessionId: string;
  event: Record<string, unknown>;
}

export function startOpenAiRealtimeSpokespersonRuntime(
  sessionId: string,
  options: unknown,
): Promise<void> {
  return invoke("start_openai_realtime_spokesperson_runtime", {
    sessionId,
    options,
  });
}

export function sendOpenAiRealtimeSpokespersonRuntimeEvent(
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  return invoke("send_openai_realtime_spokesperson_runtime_event", {
    sessionId,
    event,
  });
}

export function stopOpenAiRealtimeSpokespersonRuntime(
  sessionId: string,
): Promise<void> {
  return invoke("stop_openai_realtime_spokesperson_runtime", { sessionId });
}

export function listenToOpenAiRealtimeSpokespersonRuntime(
  listener: (event: OpenAiRealtimeRuntimeEvent) => void,
): Promise<UnlistenFn> {
  return listen<OpenAiRealtimeRuntimeEvent>(
    "openai-realtime-runtime-event",
    ({ payload }) => listener(payload),
  );
}

export function createOpenAiRealtimeExpertInstructions(
  sessionId: string,
  initialCursor: number,
  callId: string,
): Promise<string> {
  return invoke("create_openai_realtime_expert_instructions", {
    sessionId,
    initialCursor,
    callId,
  });
}

export function createOpenAiRealtimeHandoffToolOutput(
  callId: string,
  handoffId: string,
): Promise<Record<string, unknown>> {
  return invoke("create_openai_realtime_handoff_tool_output", {
    callId,
    handoffId,
  });
}

export function createOpenAiRealtimeInvalidToolOutput(
  callId: string,
  toolName: string,
  error: string,
): Promise<Record<string, unknown>> {
  return invoke("create_openai_realtime_invalid_tool_output", {
    callId,
    toolName,
    error,
  });
}

export type OpenAiRealtimeTranscriptSeedTurn =
  | { role: "user"; text: string }
  | { role: "spokesperson"; text: string; interrupted: boolean }
  | { role: "expert"; text: string };

export function createOpenAiRealtimeTranscriptSeed(
  turns: OpenAiRealtimeTranscriptSeedTurn[],
  maxItems: number,
  sessionId?: string,
): Promise<Record<string, unknown>[]> {
  return invoke("create_openai_realtime_transcript_seed", {
    turns,
    maxItems,
    sessionId,
  });
}

export type OpenAiRealtimeProtocolEvent =
  | {
      type: "transcript.started";
      itemId: string;
      speaker: "user" | "spokesperson";
    }
  | {
      type: "transcript.updated";
      itemId: string;
      speaker: "user" | "spokesperson";
      text: string;
    }
  | {
      type: "transcript.finalized";
      id: number;
      itemId: string;
      speaker: "user" | "spokesperson";
      text: string;
      interrupted: boolean;
      evidence: "provider_final" | "provider_delta" | "host_played_frames";
      expertMessage: string;
    }
  | {
      type: "handoff";
      responseId?: string;
      callId: string;
      message: string;
    }
  | {
      type: "tool_call.invalid";
      callId: string;
      toolName: string;
      error: string;
    }
  | { type: "spokesperson.playback_interrupted"; responseId: string };

export interface OpenAiRealtimeReduction {
  protocolEvents: OpenAiRealtimeProtocolEvent[];
  clientEvents: Record<string, unknown>[];
  completedHandoffIds: string[];
  failedHandoffIds: string[];
}

export interface OpenAiRealtimeCoordinatorResult {
  status: "sent" | "interrupting" | "queued";
  events: Record<string, unknown>[];
}

export type OpenAiRealtimePipeMessage = {
  id: number;
  sender: "master" | "emissary";
  recipient: "master" | "emissary";
  senderCursor: number;
  message: string;
};

export type OpenAiRealtimePipeExchange =
  | {
      accepted: true;
      outbound: OpenAiRealtimePipeMessage;
      cursor: number;
    }
  | {
      accepted: false;
      reason: "pipe_busy" | "stale_cursor";
      cursor: number;
    };

export function startOpenAiRealtimeSpokespersonProtocol(
  sessionId: string,
  initialCursor: number,
): Promise<void> {
  return invoke("start_openai_realtime_spokesperson_protocol", {
    sessionId,
    initialCursor,
  });
}

export function enqueueOpenAiRealtimeSpokespersonMessage(
  sessionId: string,
  message: string,
): Promise<OpenAiRealtimePipeExchange> {
  return invoke("enqueue_openai_realtime_spokesperson_message", {
    sessionId,
    message,
  });
}

export function sendOpenAiRealtimeExpertPipeMessage(
  sessionId: string,
  cursor: number,
  message: string,
): Promise<OpenAiRealtimePipeExchange> {
  return invoke("send_openai_realtime_expert_pipe_message", {
    sessionId,
    cursor,
    message,
  });
}

export function getOpenAiRealtimeExpertPipeCursor(
  sessionId: string,
): Promise<number> {
  return invoke("get_openai_realtime_expert_pipe_cursor", { sessionId });
}

export function registerOpenAiRealtimeHandoff(
  sessionId: string,
  handoffId: string,
  cursor: number,
  message: string,
): Promise<string> {
  return invoke<string>("register_openai_realtime_handoff", {
    sessionId,
    handoffId,
    cursor,
    message,
  });
}

export function unknownOpenAiRealtimeHandoffIds(
  sessionId: string,
  handoffIds: string[],
): Promise<string[]> {
  return invoke("unknown_openai_realtime_handoff_ids", {
    sessionId,
    handoffIds,
  });
}

export function markOpenAiRealtimeHandoffsResolving(
  sessionId: string,
  handoffIds: string[],
): Promise<void> {
  return invoke("mark_openai_realtime_handoffs_resolving", {
    sessionId,
    handoffIds,
  });
}

export function dismissOpenAiRealtimeHandoffs(
  sessionId: string,
  handoffIds: string[],
): Promise<void> {
  return invoke("dismiss_openai_realtime_handoffs", {
    sessionId,
    handoffIds,
  });
}

export type OpenAiRealtimeHandoffReminder =
  | { status: "none" }
  | {
      status: "reminder";
      handoffIds: string[];
      attempt: number;
      requests: string;
      message: string;
    }
  | { status: "exhausted"; handoffIds: string[]; message: string };

export function completeOpenAiRealtimeExpertTurn(
  sessionId: string,
  retryingHandoffIds: string[],
  maxAttempts: number,
): Promise<OpenAiRealtimeHandoffReminder> {
  return invoke("complete_openai_realtime_expert_turn", {
    sessionId,
    retryingHandoffIds,
    maxAttempts,
  });
}

export function reduceOpenAiRealtimeSpokespersonEvent(
  sessionId: string,
  event: unknown,
): Promise<OpenAiRealtimeReduction> {
  return invoke("reduce_openai_realtime_spokesperson_event", {
    sessionId,
    event,
  });
}

export function requestOpenAiRealtimeExpertMessage(
  sessionId: string,
  message: {
    message: string;
    mode: "context" | "say";
    eventId?: string;
    resolvedHandoffIds?: string[];
  },
): Promise<OpenAiRealtimeCoordinatorResult> {
  return invoke("request_openai_realtime_expert_message", {
    sessionId,
    message,
  });
}

export function requestOpenAiRealtimeToolOutput(
  sessionId: string,
  event: Record<string, unknown>,
  requestResponse: boolean,
): Promise<OpenAiRealtimeCoordinatorResult> {
  return invoke("request_openai_realtime_tool_output", {
    sessionId,
    event,
    requestResponse,
  });
}

export function requestOpenAiRealtimeTypedUserMessage(
  sessionId: string,
  text: string,
): Promise<OpenAiRealtimeCoordinatorResult> {
  return invoke("request_openai_realtime_typed_user_message", {
    sessionId,
    text,
  });
}

export function stopOpenAiRealtimeSpokespersonProtocol(
  sessionId: string,
): Promise<void> {
  return invoke("stop_openai_realtime_spokesperson_protocol", { sessionId });
}

export type OpenAiRealtimeVoiceControl = {
  sessionId: string;
  revision: number;
  action: "stop" | "mute";
  muted?: boolean;
};

const REALTIME_CONTROL_EVENT = "voice-conversation:realtime-control";

export function listenToOpenAiRealtimeVoiceControls(
  listener: (control: OpenAiRealtimeVoiceControl) => void,
): Promise<UnlistenFn> {
  return listen<OpenAiRealtimeVoiceControl>(REALTIME_CONTROL_EVENT, (event) =>
    listener(event.payload),
  );
}

export function startOpenAiRealtimeVoiceControls(
  sessionId: string,
): Promise<VoiceConversationStatus> {
  return invoke("start_openai_realtime_voice_controls", { sessionId });
}

export function getOpenAiRealtimeVoiceControlsStatus(): Promise<VoiceConversationStatus> {
  return invoke("get_openai_realtime_voice_controls_status");
}

export function rebindOpenAiRealtimeVoiceControls(
  previousSessionId: string,
  sessionId: string,
  expectedRevision: number,
): Promise<VoiceConversationStatus> {
  return invoke("rebind_openai_realtime_voice_controls", {
    request: { previousSessionId, sessionId, expectedRevision },
  });
}

export function showOpenAiRealtimeVoiceControls(
  sessionId: string,
  expectedRevision: number,
): Promise<void> {
  return invoke("show_openai_realtime_voice_controls", {
    sessionId,
    expectedRevision,
  });
}

export function setOpenAiRealtimeVoiceControlsSuppressed(
  sessionId: string,
  expectedRevision: number,
  suppressed: boolean,
): Promise<void> {
  return invoke("set_openai_realtime_voice_controls_suppressed", {
    request: { sessionId, expectedRevision, suppressed },
  });
}

export function publishOpenAiRealtimeVoiceActivity(
  sessionId: string,
  expectedRevision: number,
  activity:
    | "user-speaking"
    | "user-idle"
    | "assistant-speaking"
    | "assistant-idle",
): Promise<void> {
  return invoke("publish_openai_realtime_voice_activity", {
    request: { sessionId, expectedRevision, activity },
  });
}

export function publishOpenAiRealtimeVoiceMicrophoneMuted(
  sessionId: string,
  expectedRevision: number,
  muted: boolean,
): Promise<void> {
  return invoke("publish_openai_realtime_voice_microphone_muted", {
    request: { sessionId, expectedRevision, muted },
  });
}

export function requestOpenAiRealtimeVoiceControl(
  sessionId: string,
  expectedRevision: number,
  action: "stop" | "mute",
  muted?: boolean,
): Promise<void> {
  return invoke("request_openai_realtime_voice_control", {
    request: { sessionId, expectedRevision, action, muted },
  });
}

export function stopOpenAiRealtimeVoiceControls(
  sessionId: string,
  expectedRevision: number,
): Promise<void> {
  return invoke("stop_openai_realtime_voice_controls", {
    sessionId,
    expectedRevision,
  });
}

// Multiple dictation hooks check the status on mount in the same tick and pass
// `{ coalesce: true }` instead of issuing duplicate IPC calls.
export const getOpenAiRealtimeStatus = shareInFlight(
  (): Promise<OpenAiRealtimeStatus> => invoke("get_openai_realtime_status"),
);

export async function createOpenAiRealtimeSession(): Promise<OpenAiRealtimeSession> {
  return invoke("create_openai_realtime_session");
}

export async function claimVoiceDictationMicrophone(
  ownerId: string,
): Promise<void> {
  const { rendererId, rendererEpoch } = await getRendererInstance();
  return invoke("claim_voice_dictation_microphone", {
    rendererId,
    rendererEpoch,
    ownerId,
  });
}

export async function releaseVoiceDictationMicrophone(
  ownerId: string,
): Promise<void> {
  const { rendererId, rendererEpoch } = await getRendererInstance();
  return invoke("release_voice_dictation_microphone", {
    rendererId,
    rendererEpoch,
    ownerId,
  });
}
