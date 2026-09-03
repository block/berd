import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VoiceConversationStatus } from "@/features/voice-conversation/api/voiceConversation";
import { getRendererInstance } from "@/shared/lib/rendererInstance";
import { shareInFlight } from "@/shared/lib/shareInFlight";

export interface OpenAiRealtimeStatus {
  configured: boolean;
}

export async function createOpenAiRealtimeVoiceSession(
  model?: string,
): Promise<OpenAiRealtimeSession> {
  return invoke("create_openai_realtime_voice_session", { model });
}

export interface OpenAiRealtimeSession {
  clientSecret: string;
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
