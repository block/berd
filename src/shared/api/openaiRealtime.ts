import { invoke } from "@tauri-apps/api/core";

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
