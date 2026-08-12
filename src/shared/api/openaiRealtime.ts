import { invoke } from "@tauri-apps/api/core";
import { getRendererInstance } from "@/shared/lib/rendererInstance";
import { shareInFlight } from "@/shared/lib/shareInFlight";

export interface OpenAiRealtimeStatus {
  configured: boolean;
  transcriptionModel: string;
}

export interface OpenAiRealtimeSession {
  clientSecret: string;
  transcriptionModel: string;
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
