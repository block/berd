import { createOpenAiRealtimeSpokespersonSessionUpdate } from "@/shared/api/openaiRealtime";

export interface RealtimeEventTransport {
  send(data: string): void;
}

export interface RealtimeEmissarySessionOptions {
  model?: string;
  transcriptionModel?: string;
  transcriptionLanguage?: string;
  transcriptionPrompt?: string;
  voice?: string;
  speed?: number;
  turnDetection?: "server_vad" | "semantic_vad";
  eagerness?: "low" | "medium" | "high" | "auto";
  interruptResponse?: boolean;
  createResponse?: boolean;
  vadThreshold?: number;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  idleTimeoutMs?: number | null;
  noiseReduction?: "off" | "near_field" | "far_field";
  reasoningEffort?: "default" | "none" | "low" | "medium" | "high";
  maxOutputTokens?: number | null;
}

export async function configureRealtimeEmissarySession(
  transport: RealtimeEventTransport,
  options: RealtimeEmissarySessionOptions = {},
): Promise<void> {
  const update = await createOpenAiRealtimeSpokespersonSessionUpdate(options);
  sendRealtimeEvents(transport, [update]);
}

export function sendRealtimeEvents(
  transport: RealtimeEventTransport,
  events: readonly Record<string, unknown>[],
): void {
  for (const event of events) transport.send(JSON.stringify(event));
}

export type MasterMessageMode = "context" | "say";
