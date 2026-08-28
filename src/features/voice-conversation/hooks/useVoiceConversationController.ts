import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type {
  ChatInputSendHandler,
  ChatInputVoiceConversation,
} from "@/features/chat/types";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { createSystemNotificationMessage } from "@/shared/types/messages";
import { steerPromptInSession } from "@/features/chat/lib/steerCore";
import {
  subscribeToVoiceConversationEvents,
  useVoiceConversationStore,
  VoiceTranscriptDeferredError,
} from "../stores/voiceConversationStore";
import {
  captureNativeAssistantSpeechHistory,
  startNativeAssistantSpeech,
  takeVoicePlaybackNotices,
} from "../lib/nativeAssistantSpeech";
import {
  confirmVoiceConversationForegroundSession,
  isVoiceMicrophoneCaptureError,
  setVoiceConversationControlsSuppressed,
  type PendingVoiceTranscript,
} from "../api/voiceConversation";
import { getMicrophonePermissionStatus } from "../api/microphonePermission";
import type { VoiceInputBackend } from "../lib/voiceInputPreference";
import type { SiriVoiceSelection } from "../api/siriVoice";

interface VoiceSendRoute {
  owner: symbol;
  sessionId: string;
  send: ChatInputSendHandler;
  blocked: boolean;
  canClaim: boolean;
}

// The backend conversation is process-wide, but voice input remains bound to
// the chat that started the active lifecycle until that lifecycle terminates.
let activeSendRoute: VoiceSendRoute | null = null;
const mountedSendRoutes = new Map<symbol, VoiceSendRoute>();
let deliveryInitialized = false;
const operationInFlightBySession = new Set<string>();
let replacementOperationInFlight = false;

export function createVoiceTranscriptDeliveryQueue() {
  const queues = new Map<string, Promise<void>>();
  return (sessionId: string, task: () => Promise<void>): Promise<void> => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    let queued!: Promise<void>;
    queued = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (queues.get(sessionId) === queued) queues.delete(sessionId);
      });
    queues.set(sessionId, queued);
    return queued;
  };
}

const enqueueVoiceTranscriptDelivery = createVoiceTranscriptDeliveryQueue();

function activeRouteIsBlocked(sessionId: string): boolean {
  return activeSendRoute?.sessionId === sessionId && activeSendRoute.blocked;
}

function releaseVoiceSendRoute(
  owner: symbol,
  preserveActiveRoute = false,
): VoiceSendRoute | null {
  const released = mountedSendRoutes.get(owner);
  mountedSendRoutes.delete(owner);
  if (activeSendRoute?.owner !== owner) return activeSendRoute;

  const replacement =
    [...mountedSendRoutes.values()].find(
      (route) => route.sessionId === released?.sessionId && route.canClaim,
    ) ?? null;
  activeSendRoute =
    replacement ?? (preserveActiveRoute ? (released ?? null) : null);
  return activeSendRoute;
}

export function canBindVoiceSendRoute(options: {
  enabled: boolean;
  isGooseSession: boolean;
  readOnly: boolean;
  disabled: boolean;
}): boolean {
  return (
    options.enabled &&
    options.isGooseSession &&
    !options.readOnly &&
    !options.disabled
  );
}

export function resolveActiveVoiceButtonAction(
  activeSessionId: string | null,
  candidateSessionId: string,
): "stop" | "replace" {
  return activeSessionId === candidateSessionId ? "stop" : "replace";
}

export function canReplaceActiveVoiceConversation(options: {
  canToggle: boolean;
  hydrated: boolean;
  pocketReady: boolean;
}): boolean {
  return options.canToggle && options.hydrated && options.pocketReady;
}

export function shouldShowVoiceConversationControl(options: {
  activeConversation: boolean;
  controlEnabled: boolean;
  voiceEnabled: boolean;
  isGooseSession: boolean;
}): boolean {
  return options.activeConversation
    ? options.controlEnabled
    : options.voiceEnabled && options.isGooseSession;
}

export type VoiceConversationTransitionOutcome =
  | "completed"
  | "not-completed"
  | "failure-reported";

export async function replaceActiveVoiceConversation(options: {
  stop: () => Promise<{ lifecycle: string; sessionId: string | null }>;
  confirmTarget?: () => Promise<unknown>;
  start: () => Promise<VoiceConversationTransitionOutcome>;
}): Promise<VoiceConversationTransitionOutcome> {
  const stopped = await options.stop();
  if (
    stopped.sessionId !== null ||
    (stopped.lifecycle !== "stopped" && stopped.lifecycle !== "unavailable")
  ) {
    return "not-completed";
  }
  await options.confirmTarget?.();
  return options.start();
}

export function shouldSuppressVoiceConversationControls(options: {
  activeSessionId: string | null;
  currentSessionId: string;
  ownerWindowLabel: string | null;
  currentWindowLabel: string;
  focused: boolean;
}): boolean {
  return (
    options.focused &&
    options.activeSessionId === options.currentSessionId &&
    options.ownerWindowLabel === options.currentWindowLabel
  );
}

interface VoiceControlsOwnerWindow {
  label: string;
  isFocused: () => Promise<boolean>;
  onFocusChanged: (
    listener: (event: { payload: boolean }) => void,
  ) => Promise<() => void>;
}

export async function observeVoiceConversationControlVisibility(options: {
  activeSessionId: string;
  currentSessionId: string;
  ownerWindowLabel: string;
  currentWindow: VoiceControlsOwnerWindow;
  report: (suppressed: boolean) => Promise<void>;
  onError: (error: unknown) => void;
}): Promise<() => void> {
  if (options.currentWindow.label !== options.ownerWindowLabel) {
    return () => undefined;
  }
  let stopped = false;
  let focusGeneration = 0;
  let unlisten: (() => void) | undefined;
  const publish = (focused: boolean) => {
    if (stopped) return;
    const suppressed = shouldSuppressVoiceConversationControls({
      activeSessionId: options.activeSessionId,
      currentSessionId: options.currentSessionId,
      ownerWindowLabel: options.ownerWindowLabel,
      currentWindowLabel: options.currentWindow.label,
      focused,
    });
    void options.report(suppressed).catch(options.onError);
  };
  const failOpen = () => {
    void options.report(false).catch(options.onError);
  };

  try {
    unlisten = await options.currentWindow.onFocusChanged((event) => {
      focusGeneration += 1;
      publish(event.payload);
    });
    const sampledGeneration = focusGeneration;
    const focused = await options.currentWindow.isFocused();
    if (focusGeneration === sampledGeneration) publish(focused);
  } catch (error) {
    unlisten?.();
    failOpen();
    throw error;
  }

  return () => {
    if (stopped) return;
    stopped = true;
    unlisten?.();
    failOpen();
  };
}

let controlsVisibilityLeaseGeneration = 0;

export function beginVoiceControlsVisibilityLease() {
  const generation = ++controlsVisibilityLeaseGeneration;
  const isCurrent = () => generation === controlsVisibilityLeaseGeneration;
  return {
    run(operation: () => Promise<void>): Promise<void> {
      return isCurrent() ? operation() : Promise.resolve();
    },
    release(failOpen: () => Promise<void>): Promise<void> {
      if (!isCurrent()) return Promise.resolve();
      controlsVisibilityLeaseGeneration += 1;
      return failOpen();
    },
    invalidate(): void {
      if (isCurrent()) controlsVisibilityLeaseGeneration += 1;
    },
  };
}

export function shouldStartRequestedVoiceConversation({
  requestedStartSessionId,
  sessionId,
  hydrated,
  enabled,
  isGooseSession,
  pocketReady,
  routeReady,
}: {
  requestedStartSessionId: string | null;
  sessionId: string;
  hydrated: boolean;
  enabled: boolean;
  isGooseSession: boolean;
  pocketReady: boolean;
  routeReady: boolean;
}): boolean {
  return (
    requestedStartSessionId === sessionId &&
    hydrated &&
    enabled &&
    isGooseSession &&
    pocketReady &&
    routeReady
  );
}

export function canClaimVoiceSendRoute(
  activeVoiceSessionId: string | null,
  boundRouteSessionId: string | null,
  candidateSessionId: string,
): boolean {
  if (activeVoiceSessionId !== null) {
    return activeVoiceSessionId === candidateSessionId;
  }
  return (
    boundRouteSessionId === null || boundRouteSessionId === candidateSessionId
  );
}

export function resolveVoiceRouteMount(options: {
  routeIsValid: boolean;
  activeVoiceSessionId: string | null;
  boundRouteSessionId: string | null;
  candidateSessionId: string;
}): { claimRoute: boolean; drainPending: boolean } {
  return {
    claimRoute:
      options.routeIsValid &&
      canClaimVoiceSendRoute(
        options.activeVoiceSessionId,
        options.boundRouteSessionId,
        options.candidateSessionId,
      ),
    drainPending:
      options.routeIsValid &&
      (options.boundRouteSessionId !== null ||
        canClaimVoiceSendRoute(
          options.activeVoiceSessionId,
          options.boundRouteSessionId,
          options.candidateSessionId,
        )),
  };
}

export function resolveVoiceToggleAction(options: {
  active: boolean;
  canToggle: boolean;
  pocketReady: boolean;
}): "stop" | "setup" | "start" | "none" {
  if (options.active) return "stop";
  if (!options.canToggle) return "none";
  return options.pocketReady ? "start" : "setup";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addErrorNotification(sessionId: string | null, message: string) {
  if (!sessionId) return;
  useChatStore
    .getState()
    .addMessage(sessionId, createSystemNotificationMessage(message, "error"));
}

export function hasDeliveredVoiceTranscript(
  sessionId: string,
  lifecycleId: string,
  utteranceId: string,
  revision: number,
): boolean {
  return (useChatStore.getState().messagesBySession[sessionId] ?? []).some(
    (message) =>
      message.role === "user" &&
      message.metadata?.origin === "voice_conversation" &&
      message.metadata.voiceConversationLifecycleId === lifecycleId &&
      message.metadata.voiceUtteranceId === utteranceId &&
      message.metadata.voiceConversationRevision === revision,
  );
}

function transcriptAlreadyInChat(transcript: PendingVoiceTranscript): boolean {
  return hasDeliveredVoiceTranscript(
    transcript.sessionId,
    transcript.lifecycleId,
    transcript.id,
    transcript.revision,
  );
}

type VoiceDeliveryOpportunity = "send" | "steer";

function voiceDeliveryOpportunity(
  sessionId: string,
): VoiceDeliveryOpportunity | null {
  const runtime = useChatStore.getState().getSessionRuntime(sessionId);
  if (runtime.isRunCancellationPending) return null;
  if (runtime.activeRunId !== null) return "steer";
  if (runtime.chatState === "idle") {
    return "send";
  }
  return null;
}

export function waitForVoiceDeliveryOpportunity(
  sessionId: string,
): Promise<VoiceDeliveryOpportunity> {
  const available = voiceDeliveryOpportunity(sessionId);
  if (available) return Promise.resolve(available);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      unsubscribeChat();
      unsubscribeVoice();
    };
    const finish = (opportunity: VoiceDeliveryOpportunity) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(opportunity);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const checkChat = () => {
      const opportunity = voiceDeliveryOpportunity(sessionId);
      if (opportunity) finish(opportunity);
    };
    const checkVoice = () => {
      const status = useVoiceConversationStore.getState().status;
      if (
        status.lifecycle === "unavailable" ||
        (status.sessionId !== null && status.sessionId !== sessionId)
      ) {
        fail(
          "Voice transcript delivery was cancelled because its voice session is unavailable.",
        );
      }
    };
    const unsubscribeChat = useChatStore.subscribe(checkChat);
    const unsubscribeVoice = useVoiceConversationStore.subscribe(checkVoice);
    checkChat();
    checkVoice();
  });
}

export function resetVoiceUiWhenRunSettles(
  sessionId: string,
  deliveryRevision: number,
): void {
  let sawRun = false;
  const check = () => {
    const voice = useVoiceConversationStore.getState();
    if (
      voice.status.lifecycle !== "running" ||
      voice.status.sessionId !== sessionId
    ) {
      unsubscribeChat();
      unsubscribeVoice();
      return;
    }

    const runtime = useChatStore.getState().getSessionRuntime(sessionId);
    if (runtime.activeRunId !== null || runtime.chatState !== "idle") {
      sawRun = true;
      return;
    }
    if (!sawRun) return;

    unsubscribeChat();
    unsubscribeVoice();
    if (voice.status.revision >= deliveryRevision) {
      voice.setUiState("listening");
    }
  };
  const unsubscribeChat = useChatStore.subscribe(check);
  const unsubscribeVoice = useVoiceConversationStore.subscribe(check);
  queueMicrotask(check);
}

function ensureVoiceEventDeliveryInitialized() {
  if (deliveryInitialized) return;
  deliveryInitialized = true;
  subscribeToVoiceConversationEvents(async (event) => {
    if (event.type === "cleanShutdown" || event.type === "controlsDismissed") {
      return;
    }
    if (event.type === "error") {
      const sessionId =
        event.sessionId ??
        useVoiceConversationStore.getState().status.sessionId;
      if (event.terminal && activeSendRoute?.sessionId === sessionId) {
        activeSendRoute = null;
      }
      addErrorNotification(sessionId ?? null, event.message);
      return;
    }
    if (event.type === "activity") return;
    if (event.type !== "user" || !event.text.trim()) return;
    if (
      hasDeliveredVoiceTranscript(
        event.sessionId,
        event.lifecycleId,
        event.id,
        event.revision,
      )
    ) {
      return;
    }

    const deliveryRevision = event.revision;
    const shouldNotifyFailure = event.deliveryAttempts === 0;
    return enqueueVoiceTranscriptDelivery(event.sessionId, async () => {
      if (activeRouteIsBlocked(event.sessionId)) {
        throw new VoiceTranscriptDeferredError(
          "Voice transcript is waiting for its bound chat to become available.",
        );
      }

      const route = activeSendRoute;
      if (!route || route.sessionId !== event.sessionId) {
        const message =
          "Voice transcript could not be sent because its bound chat is unavailable.";
        if (shouldNotifyFailure) addErrorNotification(event.sessionId, message);
        throw new Error(message);
      }

      const store = useVoiceConversationStore.getState();
      store.setUiState("user-speaking");

      const sendOptions = {
        userMessageMetadata: {
          origin: "voice_conversation" as const,
          voiceUtteranceId: event.id,
          voiceConversationLifecycleId: event.lifecycleId,
          voiceConversationRevision: event.revision,
        },
        acpGooseMetadata: {
          origin: "voice_conversation",
          voiceUtteranceId: event.id,
          voiceConversationLifecycleId: event.lifecycleId,
          voiceConversationRevision: event.revision,
        },
      };
      try {
        // This runs inside the per-session queue, so a prior send can change
        // the opportunity to steer before the next transcript is evaluated.
        const opportunity = await waitForVoiceDeliveryOpportunity(
          event.sessionId,
        );
        if (activeRouteIsBlocked(event.sessionId)) {
          throw new VoiceTranscriptDeferredError(
            "Voice transcript is waiting for its bound chat to become available.",
          );
        }
        const currentRoute = activeSendRoute;
        if (!currentRoute || currentRoute.sessionId !== event.sessionId) {
          throw new Error(
            "Voice transcript could not be sent because its bound chat is unavailable.",
          );
        }
        const playbackNotice = takeVoicePlaybackNotices(event.sessionId);
        const displayOptions = {
          ...sendOptions,
          ...(playbackNotice ? { assistantPrompt: playbackNotice } : {}),
          displayText: event.text,
        };
        store.setUiState("agent-working");
        const delivered =
          opportunity === "steer"
            ? await steerPromptInSession(
                event.sessionId,
                event.text,
                undefined,
                displayOptions,
                { throwOnError: true },
              )
            : await currentRoute.send(
                event.text,
                undefined,
                undefined,
                displayOptions,
              );
        if (delivered === false) {
          // Runtime state may have changed between the opportunity read and
          // send admission. Re-evaluate once, then steer if a run now exists.
          const retryOpportunity = await waitForVoiceDeliveryOpportunity(
            event.sessionId,
          );
          if (retryOpportunity !== "steer") {
            throw new Error(
              "Voice transcript was not accepted by the chat session.",
            );
          }
          await steerPromptInSession(
            event.sessionId,
            event.text,
            undefined,
            displayOptions,
            { throwOnError: true },
          );
        }
        // Admission releases the transcript queue so later speech can steer.
        // UI working state follows the actual chat runtime independently.
        resetVoiceUiWhenRunSettles(event.sessionId, deliveryRevision);
      } catch (deliveryError) {
        const current = useVoiceConversationStore.getState();
        if (deliveryError instanceof VoiceTranscriptDeferredError) {
          if (
            current.status.lifecycle === "running" &&
            current.status.sessionId === event.sessionId &&
            current.status.revision >= deliveryRevision
          ) {
            current.setUiState("listening");
          }
          throw deliveryError;
        }
        if (
          current.status.lifecycle === "running" &&
          current.status.sessionId === event.sessionId &&
          current.status.revision >= deliveryRevision
        ) {
          current.setUiState("error", errorText(deliveryError));
        }
        if (shouldNotifyFailure) {
          addErrorNotification(event.sessionId, errorText(deliveryError));
        }
        throw deliveryError;
      }
    });
  });
}

export function startPendingTranscriptRecovery(
  drain: () => Promise<void>,
  onError: (error: unknown) => void,
  intervalMs = 500,
): () => void {
  let stopped = false;
  let inFlight = false;
  let consecutiveFailures = 0;
  let timer: number | null = null;
  const schedule = () => {
    if (stopped) return;
    const delay =
      intervalMs * 2 ** Math.min(Math.max(consecutiveFailures - 1, 0), 4);
    timer = window.setTimeout(() => void recover(), delay);
  };
  const recover = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await drain();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures === 1) onError(error);
    } finally {
      inFlight = false;
      schedule();
    }
  };

  void recover();
  return () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
  };
}

export interface UseVoiceConversationControllerOptions {
  sessionId: string;
  onSend: ChatInputSendHandler;
  enabled: boolean;
  isGooseSession: boolean;
  pocketReady: boolean;
  inputBackend?: VoiceInputBackend | null;
  siriVoice?: SiriVoiceSelection | null;
  onPocketSetupRequired: () => void;
  readOnly?: boolean;
  disabled?: boolean;
  routeBlocked?: boolean;
  routeUnavailable?: boolean;
}

export function useVoiceConversationController({
  sessionId,
  onSend,
  enabled,
  isGooseSession,
  pocketReady,
  inputBackend = "parakeet",
  siriVoice = null,
  onPocketSetupRequired,
  readOnly = false,
  disabled = false,
  routeBlocked = false,
  routeUnavailable = false,
}: UseVoiceConversationControllerOptions): ChatInputVoiceConversation {
  const { t } = useTranslation("chat");
  const siriVoiceRef = useRef(siriVoice);
  siriVoiceRef.current = siriVoice;
  const status = useVoiceConversationStore((state) => state.status);
  const uiState = useVoiceConversationStore((state) => state.uiState);
  const error = useVoiceConversationStore((state) => state.error);
  const hydrated = useVoiceConversationStore((state) => state.hydrated);
  const init = useVoiceConversationStore((state) => state.init);
  const refreshStatus = useVoiceConversationStore(
    (state) => state.refreshStatus,
  );
  const start = useVoiceConversationStore((state) => state.start);
  const stop = useVoiceConversationStore((state) => state.stop);
  const stopForReplacement = useVoiceConversationStore(
    (state) => state.stopForReplacement,
  );
  const microphoneMuted = useVoiceConversationStore(
    (state) => state.microphoneMuted,
  );
  const setMicrophoneMuted = useVoiceConversationStore(
    (state) => state.setMicrophoneMuted,
  );
  const drainPendingTranscripts = useVoiceConversationStore(
    (state) => state.drainPendingTranscripts,
  );
  const requestedStartSessionId = useVoiceConversationStore(
    (state) => state.requestedStartSessionId,
  );
  const clearRequestedStart = useVoiceConversationStore(
    (state) => state.clearRequestedStart,
  );
  const previousPocketReady = useRef(pocketReady);
  const routeOwnerRef = useRef<{
    sessionId: string;
    owner: symbol;
  } | null>(null);
  if (routeOwnerRef.current?.sessionId !== sessionId) {
    routeOwnerRef.current = {
      sessionId,
      owner: Symbol("voice-send-route"),
    };
  }
  const routeOwner = routeOwnerRef.current.owner;
  const deliveryBlocked =
    routeBlocked && enabled && isGooseSession && !readOnly && !routeUnavailable;
  const startEligibilityRef = useRef<{
    routeOwner: symbol;
    sessionId: string;
    inputBackend: VoiceInputBackend | null;
    eligible: boolean;
    deliveryBlocked: boolean;
  }>({
    routeOwner,
    sessionId,
    inputBackend,
    eligible: false,
    deliveryBlocked: false,
  });
  startEligibilityRef.current = {
    routeOwner,
    sessionId,
    inputBackend,
    eligible:
      inputBackend !== null &&
      enabled &&
      isGooseSession &&
      !readOnly &&
      !routeUnavailable,
    deliveryBlocked,
  };
  const drainPendingTranscriptsRef = useRef(drainPendingTranscripts);
  drainPendingTranscriptsRef.current = drainPendingTranscripts;

  useEffect(() => {
    if (!enabled || !isGooseSession) return;
    void init().catch((initError) => {
      addErrorNotification(sessionId, errorText(initError));
    });
  }, [enabled, init, isGooseSession, sessionId]);

  useEffect(() => {
    const becameReady = pocketReady && !previousPocketReady.current;
    previousPocketReady.current = pocketReady;
    if (!becameReady || !enabled || !isGooseSession) return;

    // Installing the models changes native availability without a voice
    // lifecycle event. Refresh it before consuming a pending start request.
    void init().catch((initError) => {
      addErrorNotification(sessionId, errorText(initError));
    });
  }, [enabled, init, isGooseSession, pocketReady, sessionId]);

  useEffect(() => {
    if (enabled && isGooseSession) ensureVoiceEventDeliveryInitialized();
    const routeCanPersist =
      enabled && isGooseSession && !readOnly && !routeUnavailable;
    const routeCanClaim =
      routeCanPersist &&
      canBindVoiceSendRoute({ enabled, isGooseSession, readOnly, disabled });
    const registeredRoute: VoiceSendRoute = {
      owner: routeOwner,
      sessionId,
      send: onSend,
      blocked: deliveryBlocked,
      canClaim: routeCanClaim,
    };
    mountedSendRoutes.set(routeOwner, registeredRoute);
    const activeVoiceSessionId = status.sessionId;
    const routeMount = resolveVoiceRouteMount({
      routeIsValid: routeCanClaim,
      activeVoiceSessionId,
      boundRouteSessionId: activeSendRoute?.sessionId ?? null,
      candidateSessionId: sessionId,
    });
    if (activeSendRoute?.owner === routeOwner) {
      if (routeCanPersist) {
        activeSendRoute = registeredRoute;
      } else {
        releaseVoiceSendRoute(routeOwner);
        mountedSendRoutes.set(routeOwner, registeredRoute);
      }
    } else if (
      routeMount.claimRoute &&
      (activeSendRoute === null ||
        activeSendRoute.sessionId !== activeVoiceSessionId ||
        !mountedSendRoutes.has(activeSendRoute.owner))
    ) {
      activeSendRoute = registeredRoute;
    }
    if (
      routeMount.drainPending &&
      activeSendRoute?.owner === routeOwner &&
      !activeSendRoute.blocked
    ) {
      const routeSessionId = activeSendRoute?.sessionId;
      if (!routeSessionId) return;
      void drainPendingTranscripts(
        routeSessionId,
        transcriptAlreadyInChat,
      ).catch((drainError) => {
        addErrorNotification(sessionId, errorText(drainError));
      });
    }
  }, [
    disabled,
    drainPendingTranscripts,
    enabled,
    isGooseSession,
    onSend,
    readOnly,
    deliveryBlocked,
    routeOwner,
    routeUnavailable,
    sessionId,
    status.sessionId,
  ]);

  useEffect(
    () => () => {
      const replacement = releaseVoiceSendRoute(routeOwner, true);
      if (!replacement || replacement.blocked) return;
      void drainPendingTranscriptsRef
        .current(replacement.sessionId, transcriptAlreadyInChat)
        .catch((drainError) => {
          addErrorNotification(replacement.sessionId, errorText(drainError));
        });
    },
    [routeOwner],
  );

  useEffect(() => {
    if (
      status.lifecycle !== "running" ||
      status.sessionId !== sessionId ||
      deliveryBlocked ||
      routeUnavailable ||
      !canBindVoiceSendRoute({
        enabled,
        isGooseSession,
        readOnly,
        disabled,
      })
    ) {
      return;
    }

    // Native transcripts are retained until acknowledged. Periodically drain
    // that durable queue so a missed webview event is retried instead of
    // silently dropping a pause-bounded utterance.
    return startPendingTranscriptRecovery(
      () => drainPendingTranscripts(sessionId, transcriptAlreadyInChat),
      (drainError) =>
        console.warn("[native-voice] Retained transcript delivery failed", {
          sessionId,
          error: errorText(drainError),
        }),
    );
  }, [
    disabled,
    drainPendingTranscripts,
    enabled,
    isGooseSession,
    readOnly,
    deliveryBlocked,
    routeUnavailable,
    sessionId,
    status.lifecycle,
    status.sessionId,
  ]);

  const startAssistantSpeech = useCallback(
    (
      initialMessages?: ReturnType<typeof captureNativeAssistantSpeechHistory>,
      resolvedSiriVoice = siriVoiceRef.current,
    ) => {
      const onFailure = (text: string, playbackError: unknown) => {
        addErrorNotification(
          sessionId,
          `Voice playback could not speak the assistant response: ${errorText(
            playbackError,
          )}`,
        );
        console.error("Native voice playback failed", {
          sessionId,
          textLength: text.length,
          error: playbackError,
        });
      };
      if (resolvedSiriVoice) {
        startNativeAssistantSpeech(
          sessionId,
          onFailure,
          initialMessages,
          resolvedSiriVoice,
        );
      } else {
        startNativeAssistantSpeech(sessionId, onFailure, initialMessages);
      }
    },
    [sessionId],
  );

  const startCurrentConversation = useCallback(async () => {
    if (inputBackend === null) return "not-completed";
    const readCurrentStartEligibility = () => {
      const current = startEligibilityRef.current;
      const stillEligible =
        current.eligible &&
        current.routeOwner === routeOwner &&
        current.sessionId === sessionId &&
        current.inputBackend === inputBackend;
      return { current, stillEligible };
    };
    const startCanStillBegin = () => {
      const { current, stillEligible } = readCurrentStartEligibility();
      return stillEligible && !current.deliveryBlocked;
    };
    const startedCaptureMayContinue = () =>
      readCurrentStartEligibility().stillEligible;
    if (!startCanStillBegin()) return "not-completed";
    try {
      if ((await getMicrophonePermissionStatus()) === "denied") {
        onPocketSetupRequired();
        return "failure-reported";
      }
    } catch {
      // Permission inspection is an optimization. Capture remains the source
      // of truth and provides the recovery path for unsupported platforms,
      // stale permission state, and other audio startup failures.
    }
    if (!startCanStillBegin()) return "not-completed";
    // Do not rely on the mount effect racing ahead of the user's first
    // click. The native recognizer can finalize quickly, so its delivery
    // subscriber must exist before the microphone lifecycle starts.
    ensureVoiceEventDeliveryInitialized();
    const assistantSpeechHistory =
      captureNativeAssistantSpeechHistory(sessionId);
    let route: VoiceSendRoute | null = null;
    try {
      const foregroundGeneration =
        await confirmVoiceConversationForegroundSession(sessionId);
      if (!startCanStillBegin()) return "not-completed";
      const { current: currentStartEligibility } =
        readCurrentStartEligibility();
      route = {
        owner: routeOwner,
        sessionId,
        send: onSend,
        blocked: currentStartEligibility.deliveryBlocked,
        canClaim: true,
      };
      mountedSendRoutes.set(routeOwner, route);
      activeSendRoute = route;
      const startedStatus = await start(
        sessionId,
        inputBackend,
        foregroundGeneration,
      );
      if (!startedCaptureMayContinue()) {
        if (activeSendRoute?.owner === route.owner) {
          releaseVoiceSendRoute(route.owner);
        }
        if (
          startedStatus.sessionId === sessionId &&
          startedStatus.lifecycle !== "stopped" &&
          startedStatus.lifecycle !== "unavailable"
        ) {
          const currentStatus = useVoiceConversationStore.getState().status;
          const staleLifecycleIsStillCurrent =
            currentStatus.sessionId === startedStatus.sessionId &&
            currentStatus.ownerWindowLabel === startedStatus.ownerWindowLabel &&
            currentStatus.revision === startedStatus.revision &&
            currentStatus.lifecycle !== "stopped" &&
            currentStatus.lifecycle !== "unavailable";
          if (staleLifecycleIsStillCurrent) {
            try {
              await stop();
            } catch (stopError) {
              addErrorNotification(sessionId, errorText(stopError));
            }
          }
        }
        return "not-completed";
      }
      startAssistantSpeech(assistantSpeechHistory);
      return "completed";
    } catch (startError) {
      const backendStatus = useVoiceConversationStore.getState().status;
      const currentWindowLabel = getCurrentWindow().label;
      const exactOwnerLifecycleSurvived =
        backendStatus.lifecycle === "running" &&
        backendStatus.sessionId === sessionId &&
        backendStatus.ownerWindowLabel === currentWindowLabel;
      if (isVoiceMicrophoneCaptureError(startError)) {
        if (route && activeSendRoute?.owner === route.owner) {
          releaseVoiceSendRoute(route.owner);
        }
        addErrorNotification(sessionId, errorText(startError));
        let cleanupError: unknown = null;
        if (exactOwnerLifecycleSurvived) {
          try {
            await stop();
          } catch (stopError) {
            cleanupError = stopError;
          }
        }
        const settledStatus = useVoiceConversationStore.getState().status;
        const captureLifecycleStopped =
          settledStatus.sessionId === null &&
          (settledStatus.lifecycle === "stopped" ||
            settledStatus.lifecycle === "unavailable");
        if (captureLifecycleStopped) {
          useVoiceConversationStore.setState((state) =>
            state.status.revision === settledStatus.revision &&
            state.status.sessionId === null
              ? { uiState: "off", error: null }
              : state,
          );
        } else if (cleanupError) {
          addErrorNotification(sessionId, errorText(cleanupError));
        }
        onPocketSetupRequired();
        return "failure-reported";
      }
      let conversationStarted = false;
      if (exactOwnerLifecycleSurvived) {
        try {
          const reconciledStatus = await useVoiceConversationStore
            .getState()
            .refreshStatus();
          conversationStarted =
            reconciledStatus.lifecycle === "running" &&
            reconciledStatus.sessionId === sessionId &&
            reconciledStatus.ownerWindowLabel === currentWindowLabel &&
            reconciledStatus.revision === backendStatus.revision;
        } catch {
          // Preserve the original startup failure below. A surviving native
          // lifecycle is usable only after microphone reconciliation succeeds.
        }
      }
      if (conversationStarted) {
        useVoiceConversationStore.setState((state) =>
          state.status.sessionId === sessionId &&
          state.status.ownerWindowLabel === backendStatus.ownerWindowLabel &&
          state.status.revision === backendStatus.revision
            ? {
                uiState:
                  state.uiState === "error" ? "listening" : state.uiState,
                error: null,
              }
            : state,
        );
        const currentStatus = useVoiceConversationStore.getState().status;
        conversationStarted =
          currentStatus.lifecycle === "running" &&
          currentStatus.sessionId === sessionId &&
          currentStatus.ownerWindowLabel === currentWindowLabel &&
          currentStatus.revision === backendStatus.revision;
        if (conversationStarted) {
          startAssistantSpeech(assistantSpeechHistory);
        }
      }
      if (!conversationStarted) {
        if (route && activeSendRoute?.owner === route.owner) {
          releaseVoiceSendRoute(route.owner);
        }
        addErrorNotification(sessionId, errorText(startError));
      }
      return conversationStarted ? "completed" : "failure-reported";
    }
  }, [
    inputBackend,
    onPocketSetupRequired,
    onSend,
    routeOwner,
    sessionId,
    start,
    startAssistantSpeech,
    stop,
  ]);

  useEffect(() => {
    if (
      status.lifecycle !== "running" ||
      status.sessionId !== sessionId ||
      status.ownerWindowLabel !== getCurrentWindow().label
    )
      return;
    // The initiating operation captured the pre-start history boundary and
    // activates speech after native startup succeeds.
    if (operationInFlightBySession.has(sessionId)) return;
    startAssistantSpeech(undefined, siriVoice);
  }, [
    sessionId,
    siriVoice,
    startAssistantSpeech,
    status.lifecycle,
    status.ownerWindowLabel,
    status.sessionId,
  ]);

  useEffect(() => {
    if (
      !window.__TAURI_INTERNALS__ ||
      status.lifecycle !== "running" ||
      !status.sessionId ||
      !status.ownerWindowLabel
    ) {
      return;
    }
    let disposed = false;
    let stopVisibilityObserver: (() => void) | undefined;
    const visibilityLease = beginVoiceControlsVisibilityLease();
    const activeSessionId = status.sessionId;
    const ownerWindowLabel = status.ownerWindowLabel;
    const revision = status.revision;

    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const currentWindow = getCurrentWindow();
        const report = (suppressed: boolean) =>
          visibilityLease.run(() =>
            setVoiceConversationControlsSuppressed(
              activeSessionId,
              revision,
              suppressed,
            ),
          );
        const onError = (visibilityError: unknown) => {
          console.warn(
            "Could not synchronize floating voice control visibility",
            visibilityError,
          );
        };
        const stop = await observeVoiceConversationControlVisibility({
          activeSessionId,
          currentSessionId: sessionId,
          ownerWindowLabel,
          currentWindow,
          report,
          onError,
        });
        if (disposed) stop();
        else stopVisibilityObserver = stop;
      })
      .catch((visibilityError) => {
        void visibilityLease
          .run(() =>
            setVoiceConversationControlsSuppressed(
              activeSessionId,
              revision,
              false,
            ),
          )
          .catch(() => undefined);
        console.warn(
          "Could not observe the voice owner window focus",
          visibilityError,
        );
      });

    return () => {
      disposed = true;
      if (stopVisibilityObserver) {
        stopVisibilityObserver();
        visibilityLease.invalidate();
      } else {
        void visibilityLease
          .release(() =>
            setVoiceConversationControlsSuppressed(
              activeSessionId,
              revision,
              false,
            ),
          )
          .catch(() => undefined);
      }
    };
  }, [
    sessionId,
    status.lifecycle,
    status.ownerWindowLabel,
    status.revision,
    status.sessionId,
  ]);

  const isActive = status.sessionId !== null && status.lifecycle !== "stopped";
  const sessionEligible =
    enabled && isGooseSession && !readOnly && !disabled && !routeUnavailable;
  const canToggle = sessionEligible && (!pocketReady || status.available);

  const toggle = useCallback(async () => {
    if (operationInFlightBySession.has(sessionId)) return;
    operationInFlightBySession.add(sessionId);
    try {
      if (replacementOperationInFlight) return;
      const currentStatus = await refreshStatus().catch(() => {
        addErrorNotification(
          sessionId,
          t("toolbar.voiceConversation.buddy.errors.initialize"),
        );
        return null;
      });
      if (!currentStatus) return;
      if (replacementOperationInFlight) return;
      const currentlyActive =
        currentStatus.sessionId !== null &&
        currentStatus.lifecycle !== "stopped" &&
        currentStatus.lifecycle !== "unavailable";
      const action = resolveVoiceToggleAction({
        active: currentlyActive,
        canToggle,
        pocketReady,
      });
      if (action === "stop") {
        const boundSessionId = currentStatus.sessionId;
        const activeButtonAction = resolveActiveVoiceButtonAction(
          boundSessionId,
          sessionId,
        );
        if (activeButtonAction === "replace") {
          if (
            !canReplaceActiveVoiceConversation({
              canToggle,
              hydrated,
              pocketReady,
            })
          ) {
            return;
          }
          if (replacementOperationInFlight) return;
          replacementOperationInFlight = true;
          try {
            const replaced = await replaceActiveVoiceConversation({
              stop: () => stopForReplacement(currentStatus, sessionId),
              confirmTarget: () =>
                confirmVoiceConversationForegroundSession(sessionId),
              start: startCurrentConversation,
            });
            if (replaced === "not-completed") {
              addErrorNotification(
                sessionId,
                t("toolbar.voiceConversation.buddy.errors.stop"),
              );
            }
          } catch {
            addErrorNotification(
              sessionId,
              t("toolbar.voiceConversation.buddy.errors.stop"),
            );
          } finally {
            replacementOperationInFlight = false;
          }
          return;
        }
        try {
          await stop();
        } catch (stopError) {
          addErrorNotification(boundSessionId, errorText(stopError));
        }
        return;
      }
      if (action === "setup") {
        onPocketSetupRequired();
        return;
      }
      if (action !== "start") {
        return;
      }

      await startCurrentConversation();
    } finally {
      operationInFlightBySession.delete(sessionId);
    }
  }, [
    canToggle,
    hydrated,
    onPocketSetupRequired,
    pocketReady,
    refreshStatus,
    sessionId,
    startCurrentConversation,
    stop,
    stopForReplacement,
    t,
  ]);

  useEffect(() => {
    if (
      !shouldStartRequestedVoiceConversation({
        requestedStartSessionId,
        sessionId,
        hydrated,
        enabled,
        isGooseSession,
        pocketReady,
        routeReady: canToggle,
      })
    ) {
      return;
    }
    clearRequestedStart(sessionId);
    void toggle();
  }, [
    clearRequestedStart,
    canToggle,
    enabled,
    hydrated,
    isGooseSession,
    pocketReady,
    requestedStartSessionId,
    sessionId,
    toggle,
  ]);

  const toggleMicrophoneMute = useCallback(async () => {
    if (status.lifecycle !== "running") return;
    try {
      await setMicrophoneMuted(
        !useVoiceConversationStore.getState().microphoneMuted,
      );
    } catch (muteError) {
      addErrorNotification(status.sessionId, errorText(muteError));
    }
  }, [setMicrophoneMuted, status.lifecycle, status.sessionId]);

  const ownsActiveConversation = isActive && status.sessionId === sessionId;
  const controlEnabled =
    ownsActiveConversation ||
    (isActive
      ? canReplaceActiveVoiceConversation({
          canToggle,
          hydrated,
          pocketReady,
        })
      : canToggle && hydrated);

  return useMemo(
    () => ({
      visible: shouldShowVoiceConversationControl({
        activeConversation: isActive,
        controlEnabled,
        voiceEnabled: enabled,
        isGooseSession,
      }),
      state: uiState,
      boundSessionId: status.sessionId,
      active: isActive,
      ownsActiveConversation,
      microphoneMuted,
      error:
        error ??
        (pocketReady && !status.available ? status.unavailableReason : null),
      disabled: !controlEnabled,
      onToggle: toggle,
      onMicrophoneMuteToggle: toggleMicrophoneMute,
    }),
    [
      controlEnabled,
      enabled,
      error,
      isActive,
      isGooseSession,
      microphoneMuted,
      pocketReady,
      ownsActiveConversation,
      status,
      toggle,
      toggleMicrophoneMute,
      uiState,
    ],
  );
}
