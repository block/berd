import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { z } from "zod";
import { getRendererInstance } from "@/shared/lib/rendererInstance";
import {
  startNativeMicrophone,
  type NativeMicrophone,
} from "../lib/nativeMicrophone";

let activeMicrophone: NativeMicrophone | null = null;
let microphoneGeneration = 0;
let microphoneLifecycleRevision = 0;
let microphoneStart: { generation: number; promise: Promise<void> } | null =
  null;
let microphoneMuted = false;
let microphoneMuteIntent = 0;
let microphoneMuteObservationVersion = 0;
let microphoneMuteQueue: Promise<void> = Promise.resolve();
let foregroundSessionGeneration = 0;
let foregroundSessionId: string | null = null;
let foregroundSessionClaim: {
  generation: number;
  sessionId: string | null;
  acknowledgement: Promise<void>;
  superseded: Promise<void>;
  supersede: () => void;
} | null = null;

export class VoiceMicrophoneCaptureError extends Error {
  override readonly name = "VoiceMicrophoneCaptureError";

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
  }
}

export function isVoiceMicrophoneCaptureError(
  error: unknown,
): error is VoiceMicrophoneCaptureError {
  return error instanceof VoiceMicrophoneCaptureError;
}

function resetMicrophoneMuteState(): void {
  microphoneMuteIntent += 1;
  microphoneMuteObservationVersion += 1;
  microphoneMuted = false;
}

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
    .catch((error) => {
      throw new VoiceMicrophoneCaptureError(error);
    })
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
  if (status.revision < microphoneLifecycleRevision) return;
  microphoneLifecycleRevision = status.revision;
  if (microphoneMuted !== status.microphoneMuted) {
    microphoneMuteObservationVersion += 1;
  }
  microphoneMuted = status.microphoneMuted;
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
): Promise<VoiceConversationStatus> {
  const intent = ++microphoneMuteIntent;
  const observationVersion = microphoneMuteObservationVersion;
  const previous = microphoneMuted;
  const appliedOptimistically = activeMicrophone !== null;
  microphoneMuted = muted;
  activeMicrophone?.setMuted(muted);
  const operation = microphoneMuteQueue
    .catch(() => undefined)
    .then(async () => {
      if (!activeMicrophone) {
        await reconcileVoiceConversationMicrophone({
          ...status,
          microphoneMuted,
        });
      }
      if (!appliedOptimistically) {
        activeMicrophone?.setMuted(microphoneMuted);
      }
      const { rendererId, rendererEpoch } = await getRendererInstance();
      const nextStatus = await invoke<VoiceConversationStatus>(
        "set_native_voice_microphone_muted",
        {
          request: {
            sessionId: status.sessionId,
            expectedRevision: status.revision,
            muted,
            rendererId,
            rendererEpoch,
          },
        },
      );
      if (
        intent === microphoneMuteIntent &&
        observationVersion === microphoneMuteObservationVersion
      ) {
        microphoneMuted = nextStatus.microphoneMuted;
        if (
          nextStatus.sessionId !== status.sessionId ||
          nextStatus.revision !== status.revision ||
          nextStatus.microphoneMuted !== muted
        ) {
          await reconcileVoiceConversationMicrophone(nextStatus);
        }
      }
      return nextStatus;
    });
  microphoneMuteQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await operation;
  } catch (error) {
    if (
      intent === microphoneMuteIntent &&
      observationVersion === microphoneMuteObservationVersion
    ) {
      microphoneMuted = previous;
      activeMicrophone?.setMuted(previous);
    }
    throw error;
  }
}

export function stopActiveMicrophoneForTest(): void {
  if (!import.meta.env.DEV) {
    throw new Error("Native microphone test controls are development-only.");
  }
  resetMicrophoneMuteState();
  microphoneLifecycleRevision = 0;
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
  /** Whether microphone samples are currently withheld from recognition. */
  microphoneMuted: boolean;
  /** Monotonic native lifecycle revision used to reject stale responses/events. */
  revision: number;
}

export type VoiceConversationEvent =
  | {
      type: "startup";
      sessionId: string;
      ownerWindowLabel: string;
      line: string;
      revision: number;
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
      type: "microphoneMute";
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
      type: "controlsDismissed";
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
export const VOICE_CONVERSATION_OPEN_SESSION_EVENT =
  "voice-conversation:open-session";
export const FOREGROUND_SESSION_CLAIM_TIMEOUT_MS = 3_000;

export function getVoiceConversationStatus(): Promise<VoiceConversationStatus> {
  return invoke<VoiceConversationStatus>(
    "get_native_voice_conversation_status",
  );
}

export function setVoiceConversationForegroundSession(
  sessionId: string | null,
): Promise<void> {
  const generation = ++foregroundSessionGeneration;
  foregroundSessionId = sessionId;
  const acknowledgement = getRendererInstance().then(
    ({ rendererId, rendererEpoch }) =>
      invoke<void>("set_voice_renderer_foreground_session", {
        request: {
          rendererId,
          rendererEpoch,
          generation,
          sessionId,
        },
      }),
  );
  let supersede!: () => void;
  const superseded = new Promise<void>((resolve) => {
    supersede = resolve;
  });
  const previousClaim = foregroundSessionClaim;
  foregroundSessionClaim = {
    generation,
    sessionId,
    acknowledgement,
    superseded,
    supersede,
  };
  previousClaim?.supersede();
  return acknowledgement;
}

export function resetVoiceConversationForegroundSessionForTest(): void {
  foregroundSessionClaim?.supersede();
  foregroundSessionGeneration = 0;
  foregroundSessionId = null;
  foregroundSessionClaim = null;
}

function renewForegroundSessionClaim(
  failedClaim: NonNullable<typeof foregroundSessionClaim>,
  targetSessionId: string,
): void {
  if (
    foregroundSessionClaim !== failedClaim ||
    foregroundSessionId !== targetSessionId
  ) {
    return;
  }
  void setVoiceConversationForegroundSession(targetSessionId).catch(
    () => undefined,
  );
}

async function awaitForegroundSessionClaim(
  targetSessionId: string,
): Promise<number> {
  let targetClaim = foregroundSessionClaim;
  if (
    foregroundSessionId !== targetSessionId ||
    targetClaim?.sessionId !== targetSessionId
  ) {
    throw new Error("The target session is no longer in the foreground.");
  }
  const acknowledgementDeadline =
    Date.now() + FOREGROUND_SESSION_CLAIM_TIMEOUT_MS;

  while (targetClaim) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      targetClaim.acknowledgement.then(
        () => ({ type: "acknowledged" as const }),
        (error: unknown) => ({ type: "failed" as const, error }),
      ),
      targetClaim.superseded.then(() => ({ type: "superseded" as const })),
      new Promise<{ type: "timed-out" }>((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ type: "timed-out" }),
          Math.max(0, acknowledgementDeadline - Date.now()),
        );
      }),
    ]).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    });
    if (outcome.type === "timed-out") {
      renewForegroundSessionClaim(targetClaim, targetSessionId);
      throw new Error("Foreground voice session confirmation timed out.");
    }
    if (outcome.type === "failed") {
      const latestClaim = foregroundSessionClaim;
      if (
        latestClaim !== targetClaim &&
        latestClaim?.sessionId === targetSessionId
      ) {
        targetClaim = latestClaim;
        continue;
      }
      renewForegroundSessionClaim(targetClaim, targetSessionId);
      throw outcome.error;
    }
    const latestClaim = foregroundSessionClaim;
    if (
      foregroundSessionId !== targetSessionId ||
      latestClaim?.sessionId !== targetSessionId
    ) {
      throw new Error("The target session is no longer in the foreground.");
    }
    if (outcome.type === "acknowledged" && latestClaim === targetClaim) {
      return targetClaim.generation;
    }
    targetClaim = latestClaim;
  }
  throw new Error("The target session is no longer in the foreground.");
}

export function confirmVoiceConversationForegroundSession(
  sessionId: string,
): Promise<number> {
  return awaitForegroundSessionClaim(sessionId);
}

export async function blockNativeVoiceConversationStarts(
  sessionId: string,
): Promise<string> {
  const { rendererId, rendererEpoch } = await getRendererInstance();
  return invoke<string>("block_native_voice_conversation_starts", {
    sessionId,
    rendererId,
    rendererEpoch,
  });
}

export function releaseNativeVoiceConversationStartBlock(
  sessionId: string,
  token: string,
): Promise<void> {
  return invoke("release_native_voice_conversation_start_block", {
    sessionId,
    token,
  });
}

export function openVoiceConversationSession(): Promise<void> {
  return invoke("open_voice_conversation_session");
}

export function showVoiceConversationControls(
  sessionId: string,
  expectedRevision: number,
): Promise<void> {
  return invoke("show_voice_conversation_controls", {
    sessionId,
    expectedRevision,
  });
}

let controlsVisibilityQueue = Promise.resolve();
export function setVoiceConversationControlsSuppressed(
  sessionId: string,
  expectedRevision: number,
  suppressed: boolean,
): Promise<void> {
  const operation = controlsVisibilityQueue
    .catch(() => undefined)
    .then(async () => {
      const { rendererId, rendererEpoch } = await getRendererInstance();
      return invoke<void>("set_voice_conversation_controls_suppressed", {
        request: {
          sessionId,
          expectedRevision,
          suppressed,
          rendererId,
          rendererEpoch,
        },
      });
    });
  controlsVisibilityQueue = operation.catch(() => undefined);
  return operation;
}

export async function setVoiceConversationAssistantSpeaking(
  sessionId: string,
  expectedRevision: number,
  speaking: boolean,
): Promise<void> {
  const { rendererId, rendererEpoch } = await getRendererInstance();
  return invoke("set_native_voice_assistant_speaking", {
    request: {
      sessionId,
      expectedRevision,
      speaking,
      rendererId,
      rendererEpoch,
    },
  });
}

export function stopVoiceConversationFromBuddy(
  status: VoiceConversationStatus,
): Promise<void> {
  microphoneMuted = false;
  stopActiveMicrophone();
  return invoke("stop_voice_conversation_from_buddy", {
    sessionId: status.sessionId,
    expectedRevision: status.revision,
  });
}

export interface PendingVoiceTranscript {
  sessionId: string;
  lifecycleId: string;
  id: string;
  text: string;
  revision: number;
  deliveryAttempts: number;
}

export interface VoiceTranscriptReference {
  lifecycleId: string;
  id: string;
  revision: number;
}

export const prepareAssistantSpeechOutcomeSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("pending") }).strict(),
    z.object({ outcome: z.literal("notAdmitted") }).strict(),
    z
      .object({
        outcome: z.literal("admitted"),
        speechId: z.number().int().nonnegative(),
      })
      .strict(),
  ],
);

export type PrepareAssistantSpeechOutcome = z.infer<
  typeof prepareAssistantSpeechOutcomeSchema
>;

export async function prepareVoiceConversationAssistantSpeech(
  sessionId: string,
  expectedRevision: number,
  text: string,
  acknowledgement: VoiceTranscriptReference | null,
): Promise<PrepareAssistantSpeechOutcome> {
  const { rendererId, rendererEpoch } = await getRendererInstance();
  const outcome = await invoke<unknown>(
    "prepare_native_voice_assistant_speech",
    {
      request: {
        sessionId,
        expectedRevision,
        text,
        acknowledgement,
        rendererId,
        rendererEpoch,
      },
    },
  );
  return prepareAssistantSpeechOutcomeSchema.parse(outcome);
}

export async function cancelVoiceConversationAssistantSpeech(
  sessionId: string,
  expectedRevision: number,
  speechId: number,
): Promise<boolean> {
  const { rendererId, rendererEpoch } = await getRendererInstance();
  return invoke<boolean>("cancel_native_voice_assistant_speech", {
    request: {
      sessionId,
      expectedRevision,
      speechId,
      rendererId,
      rendererEpoch,
    },
  });
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
  inputBackend: "parakeet" | "macos" | "openai" = "parakeet",
  foregroundGeneration = 0,
): Promise<VoiceConversationStatus> {
  resetMicrophoneMuteState();
  const { rendererId, rendererEpoch } = await getRendererInstance();
  const status = await invoke<VoiceConversationStatus>(
    "start_native_voice_conversation",
    {
      sessionId,
      inputBackend,
      rendererId,
      rendererEpoch,
      foregroundGeneration,
    },
  );
  try {
    await reconcileVoiceConversationMicrophone(status);
    return status;
  } catch (error) {
    await invoke("stop_native_voice_conversation", {
      rendererId,
      rendererEpoch,
      sessionId: status.sessionId,
      expectedRevision: status.revision,
    }).catch(() => undefined);
    throw error;
  }
}

export async function stopVoiceConversation(
  status: VoiceConversationStatus,
): Promise<VoiceConversationStatus> {
  resetMicrophoneMuteState();
  const { rendererId, rendererEpoch } = await getRendererInstance();
  const nextStatus = await invoke<VoiceConversationStatus>(
    "stop_native_voice_conversation",
    {
      rendererId,
      rendererEpoch,
      sessionId: status.sessionId,
      expectedRevision: status.revision,
    },
  );
  await reconcileVoiceConversationMicrophone(nextStatus);
  return nextStatus;
}

export async function stopVoiceConversationForReplacement(
  status: VoiceConversationStatus,
  targetSessionId: string,
): Promise<VoiceConversationStatus> {
  await awaitForegroundSessionClaim(targetSessionId);
  resetMicrophoneMuteState();
  const { rendererId, rendererEpoch } = await getRendererInstance();
  const nextStatus = await invoke<VoiceConversationStatus>(
    "stop_native_voice_conversation_for_replacement",
    {
      rendererId,
      rendererEpoch,
      sessionId: status.sessionId,
      expectedRevision: status.revision,
      targetSessionId,
    },
  );
  await reconcileVoiceConversationMicrophone(nextStatus);
  return nextStatus;
}

export function listenToVoiceConversation(
  onEvent: (event: VoiceConversationEvent) => void,
): Promise<UnlistenFn> {
  return listen<VoiceConversationEvent>(VOICE_CONVERSATION_EVENT, (event) =>
    onEvent(event.payload),
  );
}

export function listenToVoiceConversationOpenSession(
  onOpen: (sessionId: string) => void,
): Promise<UnlistenFn> {
  const internals = window.__TAURI_INTERNALS__ as
    | { transformCallback?: unknown }
    | undefined;
  if (typeof internals?.transformCallback !== "function") {
    return Promise.resolve(() => undefined);
  }
  return listen<{ sessionId: string }>(
    VOICE_CONVERSATION_OPEN_SESSION_EVENT,
    (event) => onOpen(event.payload.sessionId),
  );
}
