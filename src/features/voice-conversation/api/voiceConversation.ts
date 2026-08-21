import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getRendererInstance } from "@/shared/lib/rendererInstance";
import {
  startNativeMicrophone,
  type NativeMicrophone,
} from "../lib/nativeMicrophone";

let activeMicrophone: NativeMicrophone | null = null;
let microphoneGeneration = 0;
let microphoneStart: { generation: number; promise: Promise<void> } | null =
  null;
let microphoneMuted = false;

function stopActiveMicrophone(): void {
  microphoneGeneration += 1;
  activeMicrophone?.stop();
  activeMicrophone = null;
}

async function ensureActiveMicrophone(): Promise<void> {
  if (activeMicrophone) {
    activeMicrophone.setMuted(microphoneMuted);
    return;
  }
  const generation = microphoneGeneration;
  if (microphoneStart?.generation === generation) {
    return microphoneStart.promise;
  }
  const promise = startNativeMicrophone()
    .then((microphone) => {
      if (generation !== microphoneGeneration) {
        microphone.stop();
        return;
      }
      activeMicrophone = microphone;
      microphone.setMuted(microphoneMuted);
    })
    .finally(() => {
      if (microphoneStart?.generation === generation) {
        microphoneStart = null;
      }
    });
  microphoneStart = { generation, promise };
  return promise;
}

export async function reconcileVoiceConversationMicrophone(
  status: VoiceConversationStatus,
): Promise<void> {
  if (status.nativeMicrophoneCapture) {
    stopActiveMicrophone();
    return;
  }
  if (
    status.lifecycle === "running" &&
    status.ownerWindowLabel === getCurrentWindow().label
  ) {
    await ensureActiveMicrophone();
  } else {
    stopActiveMicrophone();
  }
}

export async function setVoiceConversationMicrophoneMuted(
  muted: boolean,
  status: VoiceConversationStatus,
): Promise<void> {
  const previous = microphoneMuted;
  microphoneMuted = muted;
  try {
    if (status.nativeMicrophoneCapture) {
      await invoke("set_native_voice_input_muted", { muted });
      stopActiveMicrophone();
      return;
    }
    await reconcileVoiceConversationMicrophone(status);
  } catch (error) {
    microphoneMuted = previous;
    activeMicrophone?.setMuted(previous);
    throw error;
  }
}

export function stopActiveMicrophoneForTest(): void {
  if (!import.meta.env.DEV) {
    throw new Error("Native microphone test controls are development-only.");
  }
  microphoneMuted = false;
  stopActiveMicrophone();
}

if (import.meta.env.DEV) {
  (
    window as typeof window & {
      __BERD_STOP_NATIVE_MICROPHONE_FOR_TEST__?: () => void;
    }
  ).__BERD_STOP_NATIVE_MICROPHONE_FOR_TEST__ = stopActiveMicrophoneForTest;
}

// Keep these renderer-facing shapes beside the IPC wrapper so they stay aligned
// with the native Tauri command payloads.
export type VoiceConversationLifecycle =
  | "unavailable"
  | "stopped"
  | "starting"
  | "running"
  | "stopping";

export interface VoiceConversationStatus {
  available: boolean;
  unavailableReason: string | null;
  lifecycle: VoiceConversationLifecycle;
  /** Goose ACP session receiving utterances; null while stopped. */
  sessionId: string | null;
  /** Trusted Tauri window allowed to attach capture and send raw PCM. */
  ownerWindowLabel: string | null;
  /** Monotonic native lifecycle revision used to reject stale responses/events. */
  revision: number;
  /** The backend owns the PCM stream so device gestures reach that process. */
  nativeMicrophoneCapture?: boolean;
}

export type VoiceConversationEvent =
  | {
      type: "startup";
      sessionId: string;
      ownerWindowLabel: string;
      line: string;
      revision: number;
      nativeMicrophoneCapture: boolean;
    }
  | {
      type: "user";
      sessionId: string;
      lifecycleId: string;
      id: string;
      text: string;
      revision: number;
      deliveryAttempts: number;
    }
  | {
      type: "activity";
      sessionId: string;
      activity:
        | "user-speaking"
        | "user-idle"
        | "assistant-speaking"
        | "assistant-idle";
      revision: number;
    }
  | {
      type: "inputMute";
      sessionId: string;
      muted: boolean;
      revision: number;
    }
  | {
      type: "cleanShutdown";
      sessionId: string;
      revision: number;
    }
  | {
      type: "error";
      sessionId?: string | null;
      message: string;
      revision: number;
      terminal: boolean;
    };

export const VOICE_CONVERSATION_EVENT = "voice-conversation:event";

export function getVoiceConversationStatus(): Promise<VoiceConversationStatus> {
  return invoke<VoiceConversationStatus>(
    "get_native_voice_conversation_status",
  );
}

export interface PendingVoiceTranscript {
  sessionId: string;
  lifecycleId: string;
  id: string;
  text: string;
  revision: number;
  deliveryAttempts: number;
}

export interface VoiceTranscriptRejection {
  attempts: number;
  terminal: boolean;
}

export function drainVoiceConversationTranscripts(
  sessionId: string,
): Promise<PendingVoiceTranscript[]> {
  return invoke<PendingVoiceTranscript[]>(
    "drain_native_voice_conversation_transcripts",
    { sessionId },
  );
}

export function acknowledgeVoiceConversationTranscript(
  transcript: PendingVoiceTranscript,
): Promise<void> {
  return invoke("acknowledge_native_voice_conversation_transcript", {
    sessionId: transcript.sessionId,
    id: transcript.id,
    revision: transcript.revision,
  });
}

export function rejectVoiceConversationTranscript(
  transcript: PendingVoiceTranscript,
): Promise<VoiceTranscriptRejection> {
  return invoke<VoiceTranscriptRejection>(
    "reject_native_voice_conversation_transcript",
    {
      sessionId: transcript.sessionId,
      id: transcript.id,
      revision: transcript.revision,
    },
  );
}

export async function startVoiceConversation(
  sessionId: string,
): Promise<VoiceConversationStatus> {
  microphoneMuted = false;
  const { rendererId, rendererEpoch } = await getRendererInstance();
  const status = await invoke<VoiceConversationStatus>(
    "start_native_voice_conversation",
    {
      sessionId,
      rendererId,
      rendererEpoch,
    },
  );
  try {
    await reconcileVoiceConversationMicrophone(status);
    return status;
  } catch (error) {
    await invoke("stop_native_voice_conversation", {
      rendererId,
      rendererEpoch,
    }).catch(() => undefined);
    throw error;
  }
}

export async function stopVoiceConversation(): Promise<VoiceConversationStatus> {
  microphoneMuted = false;
  stopActiveMicrophone();
  const { rendererId, rendererEpoch } = await getRendererInstance();
  return invoke<VoiceConversationStatus>("stop_native_voice_conversation", {
    rendererId,
    rendererEpoch,
  });
}

export function listenToVoiceConversation(
  onEvent: (event: VoiceConversationEvent) => void,
): Promise<UnlistenFn> {
  return listen<VoiceConversationEvent>(VOICE_CONVERSATION_EVENT, (event) => {
    if (
      event.payload.type === "cleanShutdown" ||
      (event.payload.type === "error" && event.payload.terminal)
    ) {
      microphoneMuted = false;
      stopActiveMicrophone();
    }
    onEvent(event.payload);
  });
}
