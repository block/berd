import { invoke } from "@tauri-apps/api/core";
import { getRendererInstance } from "@/shared/lib/rendererInstance";

export interface OpenAiRealtimeStatus {
  configured: boolean;
  transcriptionModel: string;
}

export interface OpenAiRealtimeSession {
  clientSecret: string;
  transcriptionModel: string;
}

export async function getOpenAiRealtimeStatus(): Promise<OpenAiRealtimeStatus> {
  return invoke("get_openai_realtime_status");
}

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
