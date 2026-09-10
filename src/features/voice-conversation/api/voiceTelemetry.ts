import { getPocketVoiceStatus } from "./pocketVoice";
import { getSiriVoiceStatus } from "./siriVoice";
import { getOpenAiVoiceStatus } from "./openAiVoice";
import { invoke } from "@tauri-apps/api/core";
import type { RendererInstance } from "@/shared/lib/rendererInstance";
import type {
  BerdVoiceConversationEndReason,
  BerdVoiceConversationMode,
} from "@/shared/telemetry/events";
import type { VoiceInputBackend } from "../lib/voiceInputPreference";
import type { VoiceOutputBackend } from "../lib/voiceOutputPreference";

export interface VoiceConversationTelemetryContext {
  inputBackend: VoiceInputBackend;
  outputBackend: VoiceOutputBackend;
  voiceMode: BerdVoiceConversationMode;
  ttsRate?: number | null;
}

export interface CompletedVoiceConversationTelemetry {
  inputBackend: VoiceInputBackend;
  outputBackend: VoiceOutputBackend;
  voiceMode: BerdVoiceConversationMode;
  ttsRate?: number | null;
  durationMs: number;
  userUtteranceCount: number;
  assistantResponseCount: number;
  endReason: BerdVoiceConversationEndReason;
  reportable: boolean;
}

function ownerRequest(renderer: RendererInstance) {
  return {
    rendererId: renderer.rendererId,
    rendererEpoch: renderer.rendererEpoch,
  };
}

export function startVoiceTelemetry(
  renderer: RendererInstance,
  context: VoiceConversationTelemetryContext,
): Promise<boolean> {
  return invoke("start_voice_conversation_telemetry", {
    request: { ...ownerRequest(renderer), ...context },
  });
}
export function setVoiceTelemetryReportable(
  renderer: RendererInstance,
  reportable: boolean,
): Promise<void> {
  return invoke("set_voice_conversation_telemetry_reportable", {
    request: ownerRequest(renderer),
    reportable,
  });
}
export function incrementVoiceUserUtterances(
  renderer: RendererInstance,
): Promise<void> {
  return invoke("increment_voice_conversation_user_utterances", {
    request: ownerRequest(renderer),
  });
}
export function incrementVoiceAssistantResponses(
  renderer: RendererInstance,
): Promise<void> {
  return invoke("increment_voice_conversation_assistant_responses", {
    request: ownerRequest(renderer),
  });
}
export function requestVoiceTelemetryEnd(
  renderer: RendererInstance,
  reason: BerdVoiceConversationEndReason,
): Promise<void> {
  return invoke("request_voice_conversation_telemetry_end", {
    request: ownerRequest(renderer),
    reason,
  });
}
export function clearVoiceTelemetryEnd(
  renderer: RendererInstance,
): Promise<void> {
  return invoke("clear_voice_conversation_telemetry_end", {
    request: ownerRequest(renderer),
  });
}
export function endVoiceTelemetry(
  renderer: RendererInstance,
  fallbackReason: BerdVoiceConversationEndReason,
): Promise<CompletedVoiceConversationTelemetry | null> {
  return invoke("end_voice_conversation_telemetry", {
    request: { ...ownerRequest(renderer), fallbackReason },
  });
}

// Read the selected backend's configured playback multiplier without changing it.
export async function getVoiceTtsRate(
  backend: VoiceOutputBackend,
): Promise<number | null> {
  try {
    const status =
      backend === "pocket"
        ? await getPocketVoiceStatus()
        : backend === "siri"
          ? await getSiriVoiceStatus("")
          : await getOpenAiVoiceStatus();
    return status.playbackSpeed;
  } catch {
    return null;
  }
}
