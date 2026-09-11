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

export interface OpenAiRealtimeGptLiveSessionOptions {
  voice?: string;
}

export function startOpenAiRealtimeGptLiveRuntime(
  sessionId: string,
  initialCursor: number,
  callId: string,
  options: OpenAiRealtimeGptLiveSessionOptions,
): Promise<void> {
  return invoke("start_openai_realtime_gpt_live_runtime", {
    sessionId,
    initialCursor,
    callId,
    options,
  });
}

export function sendOpenAiRealtimeGptLiveRuntimeEvent(
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  return invoke("send_openai_realtime_gpt_live_runtime_event", {
    sessionId,
    event,
  });
}

export function stopOpenAiRealtimeGptLiveRuntime(
  sessionId: string,
): Promise<void> {
  return invoke("stop_openai_realtime_gpt_live_runtime", { sessionId });
}

export function releaseOpenAiRealtimeGptLiveRuntime(
  sessionId: string,
): Promise<void> {
  return invoke("release_openai_realtime_gpt_live_runtime", { sessionId });
}

export interface OpenAiRealtimeTtsConfigurationSnapshot {
  revision: number;
  backend: "openai";
  model: string;
  voice: string;
  rate: number;
}

export function updateOpenAiRealtimeGptLiveSettings(
  sessionId: string,
  expectedRevision: number,
  voice: string,
  speed: number,
): Promise<OpenAiRealtimeTtsConfigurationSnapshot> {
  return invoke("update_openai_realtime_gpt_live_settings", {
    sessionId,
    expectedRevision,
    voice,
    speed,
  });
}

export function listenToOpenAiRealtimeGptLiveRuntime(
  listener: (event: OpenAiRealtimeRuntimeEvent) => void,
): Promise<UnlistenFn> {
  return listen<OpenAiRealtimeRuntimeEvent>(
    "openai-realtime-runtime-event",
    ({ payload }) => listener(payload),
  );
}

export function createOpenAiRealtimeBackendInstructions(
  sessionId: string,
  initialCursor: number,
  callId: string,
): Promise<string> {
  return invoke("create_openai_realtime_backend_instructions", {
    sessionId,
    initialCursor,
    callId,
  });
}

export type OpenAiRealtimeTranscriptSeedTurn =
  | { role: "user"; text: string }
  | { role: "gpt_live"; text: string; interrupted: boolean }
  | { role: "backend"; text: string };

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
      speaker: "user" | "gpt_live";
    }
  | {
      type: "transcript.updated";
      itemId: string;
      speaker: "user" | "gpt_live";
      text: string;
    }
  | {
      type: "transcript.finalized";
      id: number;
      itemId: string;
      speaker: "user" | "gpt_live";
      text: string;
      interrupted: boolean;
      evidence: "provider_final" | "provider_delta" | "host_played_frames";
      backendMessage: string;
    }
  | {
      type: "transcript.settled";
      itemId: string;
      speaker: "user" | "gpt_live";
      text: string;
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
  | { type: "gpt_live.playback_interrupted"; responseId: string };

export interface OpenAiRealtimeReduction {
  protocolEvents: OpenAiRealtimeProtocolEvent[];
  clientEvents: Record<string, unknown>[];
  backendDelivery?: OpenAiRealtimeBackendDelivery;
  acceptedHandoffs: Array<{ handoffId: string; message: string }>;
}

export interface OpenAiRealtimeBackendDelivery {
  events: OpenAiRealtimeBackendDeliveryEvent[];
  displayText: string;
  handoffIds: string[];
}

export interface OpenAiRealtimeBackendDeliveryEvent {
  cursor: number;
  role: "user" | "gpt_live" | "gpt_live_interrupted" | "handoff";
  text: string;
  handoffId?: string;
}

export type GptLiveAppendResult =
  | {
      accepted: true;
      cursor: number;
    }
  | {
      accepted: false;
      reason: "pipe_busy" | "stale_cursor" | "unknown_delegation";
      cursor: number;
    };

export function appendOpenAiRealtimeBackendResult(
  sessionId: string,
  cursor: number,
  message: string,
  channel: "commentary" | "thinking",
  delegationId?: string,
): Promise<GptLiveAppendResult> {
  return invoke("append_openai_realtime_backend_result", {
    sessionId,
    cursor,
    message,
    channel,
    delegationId,
  });
}

export function reduceOpenAiRealtimeGptLiveEvent(
  sessionId: string,
  event: unknown,
): Promise<OpenAiRealtimeReduction> {
  return invoke("reduce_openai_realtime_gpt_live_event", {
    sessionId,
    event,
  });
}

export function requestOpenAiRealtimeTypedUserMessage(
  sessionId: string,
  text: string,
): Promise<Record<string, unknown>[]> {
  return invoke("request_openai_realtime_typed_user_message", {
    sessionId,
    text,
  });
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
