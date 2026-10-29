import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type {
  ChatInputSendHandler,
  ChatInputVoiceConversation,
} from "@/features/chat/types";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
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
  updateVoiceConversationStatusSounds,
  type PendingVoiceTranscript,
} from "../api/voiceConversation";
import { getMicrophonePermissionStatus } from "../api/microphonePermission";
import {
  getStatusSoundPreference,
  subscribeToStatusSoundPreference,
  type StatusSoundPreference,
} from "../lib/statusSoundPreference";
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

export function waitForVoiceRunSettlement(sessionId: string): Promise<void> {
  const settled = () => {
    const runtime = useChatStore.getState().getSessionRuntime(sessionId);
    return (
      runtime.activeRunId === null &&
      runtime.chatState === "idle" &&
      !runtime.isRunCancellationPending
    );
  };
  if (settled()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      unsubscribeChat();
      unsubscribeVoice();
    };
    const unsubscribeChat = useChatStore.subscribe(() => {
      if (!settled()) return;
      cleanup();
      resolve();
    });
    const unsubscribeVoice = useVoiceConversationStore.subscribe((voice) => {
      if (
        voice.status.lifecycle === "running" &&
        voice.status.sessionId === sessionId
      )
        return;
      cleanup();
      reject(
        new VoiceTranscriptDeferredError(
          "Voice transcript is waiting for its speculative run to settle.",
        ),
      );
    });
  });
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

export function publishChainedVoiceStatus(
  sessionId: string,
  conversationStatus: "working" | "waiting",
  settings: StatusSoundPreference = getStatusSoundPreference(),
): void {
  const status = useVoiceConversationStore.getState().status;
  if (status.lifecycle !== "running" || status.sessionId !== sessionId) return;
  void updateVoiceConversationStatusSounds(
    status,
    conversationStatus,
    settings,
  ).catch((error) =>
    console.warn(
      `Could not publish chained voice ${conversationStatus} status`,
      error,
    ),
  );
}

const chainedRunStatusObservers = new Map<string, () => void>();

export function observeChainedVoiceStatus(): () => void {
  let published: string | null = null;
  const check = () => {
    const { status } = useVoiceConversationStore.getState();
    if (
      status.lifecycle !== "running" ||
      !status.sessionId ||
      status.ownerWindowLabel !== getCurrentWindow().label
    ) {
      published = null;
      return;
    }
    const runtime = useChatStore.getState().getSessionRuntime(status.sessionId);
    const running =
      runtime.activeRunId !== null || isSessionRunning(runtime.chatState);
    const conversationStatus =
      runtime.hasToolCallInRun && running ? "working" : "waiting";
    const settings =
      running && !runtime.hasToolCallInRun
        ? { mode: "off" as const }
        : getStatusSoundPreference();
    const next = JSON.stringify([
      status.sessionId,
      status.revision,
      conversationStatus,
      settings,
    ]);
    if (next === published) return;
    published = next;
    publishChainedVoiceStatus(status.sessionId, conversationStatus, settings);
  };
  const unsubscribeChat = useChatStore.subscribe(check);
  const unsubscribeVoice = useVoiceConversationStore.subscribe(check);
  const unsubscribePreference = subscribeToStatusSoundPreference(check);
  check();
  return () => {
    unsubscribeChat();
    unsubscribeVoice();
    unsubscribePreference();
  };
}

export function resetVoiceUiWhenRunSettles(
  sessionId: string,
  deliveryRevision: number,
): void {
  chainedRunStatusObservers.get(sessionId)?.();
  let sawRun = false;
  let publishedStatus: "working" | "waiting" = "working";
  const cleanup = () => {
    unsubscribeChat();
    unsubscribeVoice();
    if (chainedRunStatusObservers.get(sessionId) === cleanup) {
      chainedRunStatusObservers.delete(sessionId);
    }
  };
  const check = () => {
    const voice = useVoiceConversationStore.getState();
    if (
      voice.status.lifecycle !== "running" ||
      voice.status.sessionId !== sessionId
    ) {
      cleanup();
      return;
    }

    const runtime = useChatStore.getState().getSessionRuntime(sessionId);
    const working =
      runtime.activeRunId !== null || isSessionRunning(runtime.chatState);
    if (working) sawRun = true;
    if (!sawRun) return;

    const nextStatus = working ? "working" : "waiting";
    if (nextStatus === publishedStatus) return;
    if (voice.status.revision >= deliveryRevision) {
      publishedStatus = nextStatus;
      voice.setUiState(
        nextStatus === "working" ? "agent-working" : "listening",
      );
    }
  };
  const unsubscribeChat = useChatStore.subscribe(check);
  const unsubscribeVoice = useVoiceConversationStore.subscribe(check);
  chainedRunStatusObservers.set(sessionId, cleanup);
  queueMicrotask(check);
}

interface EarlyDelivery {
  text: string;
  key: string;
  admitted: boolean;
}
const earlyDeliveries = new Map<string, EarlyDelivery>();
const finalTranscriptsSeen = new Set<string>();

function sameVoiceWords(first: string, second: string): boolean {
  const words = (text: string) =>
    text
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(" ") ?? "";
  return words(first) === words(second);
}

function voiceEventKey(event: {
  sessionId: string;
  lifecycleId: string;
  revision: number;
  id: string;
}): string {
  return `${event.sessionId}\0${event.lifecycleId}\0${event.revision}\0${event.id}`;
}

function earlyEventIsCurrent(
  event: { sessionId: string; revision: number },
  requireMicrophone = true,
) {
  const { status, microphoneMuted } = useVoiceConversationStore.getState();
  return (
    status.lifecycle === "running" &&
    status.sessionId === event.sessionId &&
    status.revision === event.revision &&
    status.ownerWindowLabel === getCurrentWindow().label &&
    (!requireMicrophone || !microphoneMuted)
  );
}

function ensureVoiceEventDeliveryInitialized() {
  if (deliveryInitialized) return;
  deliveryInitialized = true;
  observeChainedVoiceStatus();
  useVoiceConversationStore.subscribe((state, previous) => {
    if (
      state.microphoneMuted &&
      !previous.microphoneMuted &&
      state.earlyTranscriptPending
    ) {
      const early = earlyDeliveries.get(state.earlyTranscriptPending);
      useVoiceConversationStore.setState({
        earlyTranscriptPending: null,
        earlyTranscriptResolution: early
          ? {
              key: early.key,
              finalKey: state.earlyTranscriptPending,
              accepted: false,
            }
          : null,
      });
    }
    if (
      state.status.revision === previous.status.revision &&
      state.status.sessionId === previous.status.sessionId &&
      state.status.lifecycle === previous.status.lifecycle
    )
      return;
    earlyDeliveries.clear();
    finalTranscriptsSeen.clear();
    if (state.earlyTranscriptPending !== null)
      useVoiceConversationStore.setState({ earlyTranscriptPending: null });
  });
  subscribeToVoiceConversationEvents(async (incoming) => {
    const isEarly = incoming.type === "interimUser";
    const event =
      incoming.type === "interimUser"
        ? { ...incoming, type: "user" as const, deliveryAttempts: 0 }
        : incoming;
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
    if (event.type === "recognitionPending") {
      if (event.pending) return;
      if (!earlyEventIsCurrent(event, false)) return;
      const pending =
        useVoiceConversationStore.getState().earlyTranscriptPending;
      // A final already queued owns reconciliation. Otherwise recognition has
      // ended without a final. Release the gate even if admission is waiting.
      if (!pending || finalTranscriptsSeen.has(pending)) return;
      const early = earlyDeliveries.get(pending);
      useVoiceConversationStore.setState({
        earlyTranscriptPending: null,
        earlyTranscriptResolution: early
          ? { key: early.key, finalKey: pending, accepted: false }
          : null,
      });
      earlyDeliveries.delete(pending);
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

    const eventKey = voiceEventKey(event);
    if (!isEarly) {
      // Bounded by lifecycle, and retained only while an early delivery exists.
      if (earlyDeliveries.has(eventKey)) finalTranscriptsSeen.add(eventKey);
    }
    const deliveryRevision = event.revision;
    const shouldNotifyFailure = event.deliveryAttempts === 0;
    if (isEarly) {
      if (
        !earlyEventIsCurrent(event) ||
        earlyDeliveries.has(eventKey) ||
        useVoiceConversationStore.getState().earlyTranscriptPending !== null
      )
        return;
      earlyDeliveries.set(eventKey, {
        text: event.text,
        key: voiceEventKey({ ...event, id: `${event.id}:early` }),
        admitted: false,
      });
      useVoiceConversationStore.setState({ earlyTranscriptPending: eventKey });
    }
    return enqueueVoiceTranscriptDelivery(event.sessionId, async () => {
      const early = earlyDeliveries.get(eventKey);
      if (
        isEarly &&
        (!early ||
          !earlyEventIsCurrent(event) ||
          finalTranscriptsSeen.has(eventKey))
      ) {
        return;
      }
      if (isEarly && activeRouteIsBlocked(event.sessionId)) return;
      if (activeRouteIsBlocked(event.sessionId)) {
        throw new VoiceTranscriptDeferredError(
          "Voice transcript is waiting for its bound chat to become available.",
        );
      }

      const route = activeSendRoute;
      if (!route || route.sessionId !== event.sessionId) {
        if (isEarly) return;
        const message =
          "Voice transcript could not be sent because its bound chat is unavailable.";
        if (shouldNotifyFailure) addErrorNotification(event.sessionId, message);
        throw new Error(message);
      }

      const store = useVoiceConversationStore.getState();
      if (!isEarly) store.setUiState("user-speaking");
      const releaseEarly = (accepted: boolean) => {
        if (!early) return;
        useVoiceConversationStore.setState({
          earlyTranscriptPending: null,
          earlyTranscriptResolution: {
            key: early.key,
            finalKey: eventKey,
            accepted,
          },
        });
        earlyDeliveries.delete(eventKey);
        finalTranscriptsSeen.delete(eventKey);
      };
      const sendOptions = {
        assistantOnlyInput: isEarly,
        userMessageMetadata: {
          ...(isEarly ? { userVisible: false } : { userVisible: true }),
          origin: "voice_conversation" as const,
          voiceUtteranceId: isEarly ? `${event.id}:early` : event.id,
          voiceConversationLifecycleId: event.lifecycleId,
          voiceConversationRevision: event.revision,
        },
        acpGooseMetadata: {
          origin: "voice_conversation",
          voiceUtteranceId: isEarly ? `${event.id}:early` : event.id,
          voiceConversationLifecycleId: event.lifecycleId,
          voiceConversationRevision: event.revision,
        },
      };
      try {
        // Keep the provisional row and its causal identity immutable. A changed
        // final must not become the cause of late messages from the old run.
        if (
          !isEarly &&
          early?.admitted &&
          !sameVoiceWords(early.text, event.text)
        )
          await waitForVoiceRunSettlement(event.sessionId);
        // This runs inside the per-session queue, so a prior send can change
        // the opportunity to steer before the next transcript is evaluated.
        const opportunity = isEarly
          ? voiceDeliveryOpportunity(event.sessionId)
          : await waitForVoiceDeliveryOpportunity(event.sessionId);
        // Provisional delivery is best effort. Never block retained finals or
        // the next utterance waiting for a run that has not started yet.
        if (!opportunity) return;
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
        if (
          isEarly &&
          (!early ||
            !earlyEventIsCurrent(event) ||
            finalTranscriptsSeen.has(eventKey))
        )
          return;
        const playbackNotice = takeVoicePlaybackNotices(event.sessionId);
        const displayOptions = {
          ...sendOptions,
          assistantPrompt: [
            playbackNotice,
            isEarly
              ? "The user paused. This is provisional speech recognition and may be corrected. Do not treat it as confirmation for irreversible actions."
              : early?.admitted
                ? sameVoiceWords(early.text, event.text)
                  ? "This is the final transcript of the provisional speech already sent. It is unchanged. Persist this user turn, but do not repeat an answer already given or in progress unless the request changed."
                  : "Speech recognition correction: the final user transcript replaces the provisional words in the prior voice turn. Discard any answer based on the provisional wording and answer the corrected request."
                : null,
          ]
            .filter(Boolean)
            .join("\n\n"),
          displayText: event.text,
        };
        if (!isEarly) store.setUiState("agent-working");
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
          const retryOpportunity = isEarly
            ? voiceDeliveryOpportunity(event.sessionId)
            : await waitForVoiceDeliveryOpportunity(event.sessionId);
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
        if (isEarly && early) early.admitted = true;
        if (!isEarly)
          releaseEarly(
            Boolean(early?.admitted && sameVoiceWords(early.text, event.text)),
          );
        // Admission releases the transcript queue so later speech can steer.
        // UI working state follows the actual chat runtime independently.
        resetVoiceUiWhenRunSettles(event.sessionId, deliveryRevision);
      } catch (deliveryError) {
        if (isEarly) {
          // Early delivery is best effort. Retained final delivery remains the
          // authoritative recovery path. Keep the speech gate until then.
          console.warn(
            "Provisional voice delivery was not admitted",
            deliveryError,
          );
          return;
        }
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
