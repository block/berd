import { useChatStore } from "@/features/chat/stores/chatStore";
import type {
  Message,
  TextContent,
  VoiceSpeechState,
} from "@/shared/types/messages";
import {
  appendPocketVoiceStream,
  finishPocketVoiceStream,
  flushPocketVoiceStream,
  listenToPocketVoiceStream,
  startPocketVoiceStream,
  stopPocketVoice,
  type VoiceDeliveryProgress,
  type PocketVoiceStreamEvent,
} from "../api/pocketVoice";
import {
  appendSiriVoiceStream,
  finishSiriVoiceStream,
  flushSiriVoiceStream,
  listenToSiriVoiceStream,
  startSiriVoiceStream,
  stopSiriVoice,
  type SiriVoiceStreamEvent,
} from "../api/siriVoice";
import { setVoiceConversationAssistantSpeaking } from "../api/voiceConversation";
import {
  getVoiceInterruptionPreference,
  type VoiceInterruptionMode,
  type VoiceInterruptionSensitivity,
} from "./voiceInterruptionPreference";
import { getVoiceOutputBackend } from "./voiceOutputPreference";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";

type SpeechFailureHandler = (text: string, error: unknown) => void;
type SpeechTarget = { messageId: string; textOrdinal: number };
type SpeechTargetSpan = SpeechTarget & { start: number; end: number };
type SpeechDeliveryEstimate = {
  cutoff: number;
  spokenText: string;
  unspokenText: string;
  confidence: "low" | "medium";
};
type InterruptionCause = "userSpeaking" | "voiceStopped";
type ActiveUtterance = {
  id: string;
  sessionId: string;
  voiceRevision: number;
  interruptionMode: VoiceInterruptionMode;
  interruptionSensitivity: VoiceInterruptionSensitivity;
  targets: SpeechTarget[];
  targetSpans: SpeechTargetSpan[];
  text: string;
  finishing: boolean;
  nativeStreamStarted: boolean;
  interruptionRequested: boolean;
  interruptionFallback: ReturnType<typeof setTimeout> | null;
  interruptionCause: InterruptionCause | null;
  latestDelivery: VoiceDeliveryProgress | null;
  status: SpeechStatus | null;
  onFailure: SpeechFailureHandler;
  onInterrupted: () => void;
  onTerminal: () => void;
};
type SpeechStatus =
  | "speaking"
  | "spoken"
  | "interrupted"
  | "notSpoken"
  | "failed";

let stopSubscription: (() => void) | null = null;
let stopVoiceSubscription: (() => void) | null = null;
let stopStreamSubscription: (() => void) | null = null;
let streamListenerReady: Promise<void> = Promise.resolve();
let commandQueue = Promise.resolve();
let generation = 0;
let commandEpoch = 0;
let activeSpeechSessionId: string | null = null;
let activeSpeechRevision: number | null = null;
let activeUtterance: ActiveUtterance | null = null;
let stopActiveVoice: () => Promise<boolean> = stopPocketVoice;
let activityReportQueue = Promise.resolve();
let startRequestGeneration = 0;
const pendingNotices = new Map<string, Map<string, string>>();
const DELIVERY_NOTICE_TEXT_LIMIT = 250;
const INTERRUPTION_TERMINAL_TIMEOUT_MS = 1_000;
// An incomplete segment has no trustworthy final-frame denominator. Bound its
// text estimate by deliberately slow speech so generated-so-far audio cannot
// make a long source segment look fully delivered.
const INCOMPLETE_SEGMENT_MAX_CHARS_PER_SECOND = 6;

function boundedDeliveryText(
  text: string,
  side: "start" | "end",
): { text: string; truncated: boolean } {
  if (text.length <= DELIVERY_NOTICE_TEXT_LIMIT) {
    return { text, truncated: false };
  }
  return side === "start"
    ? {
        text: `${text.slice(0, DELIVERY_NOTICE_TEXT_LIMIT - 1)}…`,
        truncated: true,
      }
    : {
        text: `…${text.slice(-(DELIVERY_NOTICE_TEXT_LIMIT - 1))}`,
        truncated: true,
      };
}

function reportAssistantActivity(
  sessionId: string,
  expectedRevision: number,
  speaking: boolean,
): void {
  activityReportQueue = activityReportQueue
    .catch(() => undefined)
    .then(() =>
      setVoiceConversationAssistantSpeaking(
        sessionId,
        expectedRevision,
        speaking,
      ),
    )
    .catch((error) => {
      console.error("Failed to synchronize assistant voice activity", {
        sessionId,
        expectedRevision,
        speaking,
        error,
      });
    });
}

function recordPlaybackNotice(
  sessionId: string,
  key: string,
  text: string,
  status: "interrupted" | "notSpoken" | "failed",
  estimate?: SpeechDeliveryEstimate,
  interruptionCause: InterruptionCause = "voiceStopped",
) {
  const noticeKey = `${sessionId}\0${key}\0${status}`;
  const excerpt = text.length > 500 ? `${text.slice(0, 497).trimEnd()}…` : text;
  const outcome =
    status === "interrupted"
      ? interruptionCause === "userSpeaking"
        ? "TTS delivery was interrupted because the user started speaking; the assistant reply was not fully spoken."
        : "TTS delivery was interrupted because the voice conversation stopped; the assistant reply was not fully spoken."
      : status === "notSpoken"
        ? "TTS delivery was blocked because the user was speaking; the assistant reply was not spoken."
        : "Native TTS could not deliver the assistant reply.";
  const estimateLine = (() => {
    if (!estimate) return "";
    const spoken = boundedDeliveryText(estimate.spokenText, "end");
    const unspoken = boundedDeliveryText(estimate.unspokenText, "start");
    return `\nDelivery estimate: ${JSON.stringify({
      spokenText: spoken.text,
      unspokenText: unspoken.text,
      spokenTextTruncated: spoken.truncated,
      unspokenTextTruncated: unspoken.truncated,
      cutoff: estimate.cutoff,
      confidence: estimate.confidence,
      estimated: true,
    })}`;
  })();
  const notice =
    `[voice: tts-delivery-failed]\n${outcome}\nOriginal text: ${excerpt}${estimateLine}\n` +
    "This is TTS delivery state, not live user voice input. Do not respond to this control message or repeat the reply unless re-delivery is still appropriate.";
  const notices = pendingNotices.get(sessionId) ?? new Map<string, string>();
  notices.set(noticeKey, notice);
  pendingNotices.set(sessionId, notices);
}

export function takeVoicePlaybackNotices(sessionId: string): string | null {
  const notices = pendingNotices.get(sessionId);
  pendingNotices.delete(sessionId);
  return notices ? [...notices.values()].join("\n") : null;
}

function targetKey(target: SpeechTarget): string {
  return `${target.messageId}\0text:${target.textOrdinal}`;
}

function completedWordCutoffAt(
  text: string,
  approximateCutoff: number,
): number {
  const boundedCutoff = Math.max(0, Math.min(text.length, approximateCutoff));
  if (boundedCutoff >= text.length) return text.length;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let cutoff = 0;
  for (const part of segmenter.segment(text)) {
    const end = part.index + part.segment.length;
    if (end > boundedCutoff) break;
    if (part.isWordLike) cutoff = end;
  }
  return cutoff;
}

function completedWordCutoff(text: string, playedRatio: number): number {
  return completedWordCutoffAt(
    text,
    Math.floor(text.length * Math.max(0, Math.min(1, playedRatio))),
  );
}

function estimateSpeechDelivery(
  text: string,
  delivery: VoiceDeliveryProgress | null,
): SpeechDeliveryEstimate {
  if (!delivery?.segments.length) {
    return {
      cutoff: 0,
      spokenText: "",
      unspokenText: text,
      confidence: "low",
    };
  }

  let searchFrom = 0;
  let cutoff = 0;
  let matchedSegment = false;
  let usedIncompleteSegment = false;
  for (const segment of delivery.segments) {
    const segmentStart = text.indexOf(segment.text, searchFrom);
    if (segmentStart === -1) continue;
    matchedSegment = true;
    const totalFrames = Math.max(0, segment.totalFrames);
    const playedFrames = Math.max(
      0,
      Math.min(totalFrames, segment.playedFrames),
    );
    if (totalFrames === 0 || playedFrames === 0) break;
    usedIncompleteSegment ||= !segment.synthesisComplete;
    if (!segment.synthesisComplete) {
      const sampleRate = Math.max(0, delivery.sampleRate ?? 0);
      const generatedRatioCutoff = Math.floor(
        segment.text.length * (playedFrames / totalFrames),
      );
      const durationBound =
        sampleRate > 0
          ? Math.floor(
              (playedFrames / sampleRate) *
                INCOMPLETE_SEGMENT_MAX_CHARS_PER_SECOND,
            )
          : 0;
      cutoff =
        segmentStart +
        completedWordCutoffAt(
          segment.text,
          Math.min(
            generatedRatioCutoff,
            durationBound,
            Math.max(0, segment.text.length - 1),
          ),
        );
      break;
    }
    if (playedFrames >= totalFrames) {
      cutoff = segmentStart + segment.text.length;
      searchFrom = cutoff;
      continue;
    }
    cutoff =
      segmentStart +
      completedWordCutoff(segment.text, playedFrames / totalFrames);
    break;
  }

  return {
    cutoff,
    spokenText: text.slice(0, cutoff),
    unspokenText: text.slice(cutoff),
    confidence: matchedSegment && !usedIncompleteSegment ? "medium" : "low",
  };
}

function applyInterruptionEstimate(
  utterance: ActiveUtterance,
  estimate: SpeechDeliveryEstimate,
) {
  const firstTargetKey = utterance.targets[0]
    ? targetKey(utterance.targets[0])
    : null;
  for (const { target, targetLength, localCutoff } of targetDeliveryCutoffs(
    utterance,
    estimate.cutoff,
  )) {
    if (localCutoff >= targetLength && targetLength > 0) {
      setTargetSpeech(utterance.sessionId, target, {
        status: "spoken",
        spokenThrough: targetLength,
      });
      continue;
    }
    if (localCutoff === 0) {
      if (targetKey(target) === firstTargetKey) {
        setTargetSpeech(utterance.sessionId, target, {
          status: "interrupted",
          spokenThrough: 0,
          confidence: estimate.confidence,
          interruptionCause: utterance.interruptionCause ?? "voiceStopped",
        });
        continue;
      }
      setTargetSpeech(utterance.sessionId, target, { status: "notSpoken" });
      continue;
    }
    setTargetSpeech(utterance.sessionId, target, {
      status: "interrupted",
      spokenThrough: localCutoff,
      confidence: estimate.confidence,
      interruptionCause: utterance.interruptionCause ?? "voiceStopped",
    });
  }
}

function targetDeliveryCutoffs(utterance: ActiveUtterance, cutoff: number) {
  return utterance.targets.map((target) => {
    const spans = utterance.targetSpans.filter(
      (span) => targetKey(span) === targetKey(target),
    );
    return {
      target,
      targetLength: spans.reduce(
        (length, span) => length + (span.end - span.start),
        0,
      ),
      localCutoff: spans.reduce(
        (length, span) =>
          length + Math.max(0, Math.min(span.end, cutoff) - span.start),
        0,
      ),
    };
  });
}

function applyFailureEstimate(
  utterance: ActiveUtterance,
  estimate: SpeechDeliveryEstimate,
) {
  for (const { target, targetLength, localCutoff } of targetDeliveryCutoffs(
    utterance,
    estimate.cutoff,
  )) {
    if (localCutoff >= targetLength && targetLength > 0) {
      setTargetSpeech(utterance.sessionId, target, {
        status: "spoken",
        spokenThrough: targetLength,
      });
      continue;
    }
    setTargetSpeech(utterance.sessionId, target, {
      status: "failed",
      spokenThrough: localCutoff,
      confidence: estimate.confidence,
    });
  }
}

function restoreListeningIfConversationIsRunning(utterance: ActiveUtterance) {
  const voice = useVoiceConversationStore.getState();
  if (
    voice.status.lifecycle === "running" &&
    voice.status.sessionId === utterance.sessionId &&
    voice.status.revision === utterance.voiceRevision
  ) {
    voice.setUiState("listening");
  }
}

function targetContent(
  sessionId: string,
  target: SpeechTarget,
): TextContent | null {
  const message = useChatStore
    .getState()
    .messagesBySession[sessionId]?.find(
      (candidate) => candidate.id === target.messageId,
    );
  if (!message) return null;
  let textOrdinal = 0;
  for (const content of message.content) {
    if (content.type !== "text") continue;
    if (textOrdinal === target.textOrdinal) return content;
    textOrdinal += 1;
  }
  return null;
}

function recordDeliveryNotices(
  utterance: ActiveUtterance,
  fallbackEstimate: SpeechDeliveryEstimate,
  status: "interrupted" | "failed",
  cause: InterruptionCause = "voiceStopped",
) {
  let recorded = false;
  for (const target of utterance.targets) {
    const content = targetContent(utterance.sessionId, target);
    if (!content || content.speech?.status === "spoken") continue;
    const spokenThrough = content.speech?.spokenThrough ?? 0;
    recordPlaybackNotice(
      utterance.sessionId,
      targetKey(target),
      content.text,
      status,
      {
        cutoff: spokenThrough,
        spokenText: content.text.slice(0, spokenThrough),
        unspokenText: content.text.slice(spokenThrough),
        confidence: content.speech?.confidence ?? fallbackEstimate.confidence,
      },
      cause,
    );
    recorded = true;
  }
  if (!recorded && utterance.targets.length === 0) {
    recordPlaybackNotice(
      utterance.sessionId,
      utterance.id,
      utterance.text,
      status,
      fallbackEstimate,
      cause,
    );
  }
}

function setTargetSpeech(
  sessionId: string,
  target: SpeechTarget,
  speech: VoiceSpeechState,
) {
  useChatStore
    .getState()
    .updateMessage(sessionId, target.messageId, (message) => {
      let textOrdinal = 0;
      return {
        ...message,
        content: message.content.map((content) => {
          if (content.type !== "text") return content;
          const matches = textOrdinal === target.textOrdinal;
          textOrdinal += 1;
          return matches ? { ...content, speech } : content;
        }),
      };
    });
}

function setUtteranceStatus(utterance: ActiveUtterance, status: SpeechStatus) {
  utterance.status = status;
  for (const target of utterance.targets) {
    setTargetSpeech(utterance.sessionId, target, { status });
  }
}

function failActiveUtterance(
  utteranceId: string,
  error: unknown,
  onFailure: SpeechFailureHandler,
) {
  const utterance = activeUtterance;
  if (!utterance || utterance.id !== utteranceId) return;
  if (utterance.interruptionFallback !== null) {
    clearTimeout(utterance.interruptionFallback);
    utterance.interruptionFallback = null;
  }
  const hasDeliveryEvidence = utterance.latestDelivery?.segments.some(
    (segment) => segment.playedFrames > 0,
  );
  if (hasDeliveryEvidence) {
    const estimate = estimateSpeechDelivery(
      utterance.text,
      utterance.latestDelivery,
    );
    applyFailureEstimate(utterance, estimate);
    recordDeliveryNotices(utterance, estimate, "failed");
  } else {
    setUtteranceStatus(utterance, "failed");
    recordPlaybackNotice(
      utterance.sessionId,
      utterance.id,
      utterance.text,
      "failed",
    );
  }
  restoreListeningIfConversationIsRunning(utterance);
  activeUtterance = null;
  reportAssistantActivity(utterance.sessionId, utterance.voiceRevision, false);
  onFailure(utterance.text, error);
  utterance.onTerminal();
}

function finalizeInterruptedUtterance(
  utterance: ActiveUtterance,
  cause: InterruptionCause,
) {
  if (activeUtterance?.id !== utterance.id) return;
  if (utterance.interruptionFallback !== null) {
    clearTimeout(utterance.interruptionFallback);
    utterance.interruptionFallback = null;
  }
  const estimate = estimateSpeechDelivery(
    utterance.text,
    utterance.latestDelivery,
  );
  applyInterruptionEstimate(utterance, estimate);
  utterance.onInterrupted();
  recordDeliveryNotices(utterance, estimate, "interrupted", cause);
  activeUtterance = null;
  restoreListeningIfConversationIsRunning(utterance);
  reportAssistantActivity(utterance.sessionId, utterance.voiceRevision, false);
  utterance.onTerminal();
}

function queueStreamCommand(
  utterance: ActiveUtterance,
  operation: () => Promise<void>,
  onFailure: SpeechFailureHandler,
) {
  const queuedEpoch = commandEpoch;
  commandQueue = commandQueue.then(async () => {
    if (queuedEpoch !== commandEpoch) return;
    try {
      await operation();
    } catch (error) {
      failActiveUtterance(utterance.id, error, onFailure);
    }
  });
}

function handleStreamEvent(
  event: PocketVoiceStreamEvent | SiriVoiceStreamEvent,
) {
  const utterance = activeUtterance;
  if (!utterance || utterance.id !== event.streamId) return;
  const voice = useVoiceConversationStore.getState();

  switch (event.state) {
    case "progress":
      utterance.latestDelivery = event.delivery ?? null;
      break;
    case "started":
      if (utterance.interruptionRequested) break;
      setUtteranceStatus(utterance, "speaking");
      voice.setUiState("agent-speaking");
      reportAssistantActivity(
        utterance.sessionId,
        utterance.voiceRevision,
        true,
      );
      break;
    case "completed":
      if (utterance.interruptionFallback !== null) {
        clearTimeout(utterance.interruptionFallback);
        utterance.interruptionFallback = null;
      }
      setUtteranceStatus(utterance, "spoken");
      restoreListeningIfConversationIsRunning(utterance);
      activeUtterance = null;
      reportAssistantActivity(
        utterance.sessionId,
        utterance.voiceRevision,
        false,
      );
      utterance.onTerminal();
      break;
    case "interrupted": {
      utterance.latestDelivery = event.delivery ?? utterance.latestDelivery;
      finalizeInterruptedUtterance(
        utterance,
        utterance.interruptionCause ?? "voiceStopped",
      );
      break;
    }
    case "failed":
      utterance.latestDelivery = event.delivery ?? utterance.latestDelivery;
      failActiveUtterance(
        utterance.id,
        event.error ?? new Error("Native voice stream failed"),
        utterance.onFailure,
      );
      break;
  }
}

function interruptActiveUtterance(
  awaitTerminalDelivery = false,
  cause: InterruptionCause = "voiceStopped",
): boolean {
  const utterance = activeUtterance;
  const terminalEventExpected =
    awaitTerminalDelivery && utterance?.nativeStreamStarted === true;
  commandEpoch += 1;
  if (utterance && !utterance.interruptionRequested) {
    utterance.interruptionRequested = true;
    utterance.interruptionCause = cause;
    if (terminalEventExpected) utterance.onInterrupted();
  }
  if (utterance && !terminalEventExpected) {
    finalizeInterruptedUtterance(
      utterance,
      utterance.interruptionCause ?? cause,
    );
  }
  if (utterance && terminalEventExpected) {
    utterance.interruptionFallback = setTimeout(() => {
      finalizeInterruptedUtterance(
        utterance,
        utterance.interruptionCause ?? cause,
      );
    }, INTERRUPTION_TERMINAL_TIMEOUT_MS);
    void stopActiveVoice().then(
      (stopped) => {
        if (!stopped) {
          finalizeInterruptedUtterance(
            utterance,
            utterance.interruptionCause ?? cause,
          );
        }
      },
      () => {
        finalizeInterruptedUtterance(
          utterance,
          utterance.interruptionCause ?? cause,
        );
      },
    );
  } else {
    void stopActiveVoice().catch(() => undefined);
  }
  return utterance !== null;
}

export function stopNativeAssistantSpeech(awaitTerminalDelivery = false): void {
  startRequestGeneration += 1;
  generation += 1;
  const utterance = activeUtterance;
  const terminalStreamSubscription = stopStreamSubscription;
  stopStreamSubscription = null;
  stopSubscription?.();
  stopSubscription = null;
  stopVoiceSubscription?.();
  stopVoiceSubscription = null;
  const shouldAwaitTerminal =
    awaitTerminalDelivery && utterance?.nativeStreamStarted === true;
  if (utterance && shouldAwaitTerminal) {
    const onTerminal = utterance.onTerminal;
    utterance.onTerminal = () => {
      terminalStreamSubscription?.();
      onTerminal();
    };
  } else {
    terminalStreamSubscription?.();
  }
  const interruptedUtterance = interruptActiveUtterance(shouldAwaitTerminal);
  if (
    !interruptedUtterance &&
    activeSpeechSessionId &&
    activeSpeechRevision !== null
  ) {
    reportAssistantActivity(activeSpeechSessionId, activeSpeechRevision, false);
  }
  activeSpeechSessionId = null;
  activeSpeechRevision = null;
}

export function captureNativeAssistantSpeechHistory(
  sessionId: string,
): Message[] {
  return [...(useChatStore.getState().messagesBySession[sessionId] ?? [])];
}

export function startNativeAssistantSpeech(
  sessionId: string,
  onFailure: SpeechFailureHandler,
  initialMessages: Message[] = captureNativeAssistantSpeechHistory(sessionId),
): void {
  if (activeSpeechSessionId === sessionId) return;
  const startRequest = ++startRequestGeneration;
  const interruptedUtterance = activeUtterance;
  if (
    interruptedUtterance?.interruptionRequested &&
    interruptedUtterance.interruptionFallback !== null
  ) {
    const requestedVoice = useVoiceConversationStore.getState().status;
    const onTerminal = interruptedUtterance.onTerminal;
    interruptedUtterance.onTerminal = () => {
      onTerminal();
      queueMicrotask(() => {
        if (startRequest !== startRequestGeneration) return;
        const currentVoice = useVoiceConversationStore.getState().status;
        if (
          currentVoice.lifecycle !== "running" ||
          currentVoice.sessionId !== sessionId ||
          currentVoice.revision !== requestedVoice.revision ||
          currentVoice.ownerWindowLabel !== requestedVoice.ownerWindowLabel
        ) {
          return;
        }
        startNativeAssistantSpeech(sessionId, onFailure, initialMessages);
      });
    };
    return;
  }
  stopNativeAssistantSpeech();
  activeSpeechSessionId = sessionId;
  activeSpeechRevision = useVoiceConversationStore.getState().status.revision;
  const activeGeneration = generation;
  const streamBackend =
    getVoiceOutputBackend() === "siri"
      ? {
          start: startSiriVoiceStream,
          append: appendSiriVoiceStream,
          flush: flushSiriVoiceStream,
          finish: finishSiriVoiceStream,
          stop: stopSiriVoice,
          listen: listenToSiriVoiceStream,
        }
      : {
          start: startPocketVoiceStream,
          append: appendPocketVoiceStream,
          flush: flushPocketVoiceStream,
          finish: finishPocketVoiceStream,
          stop: stopPocketVoice,
          listen: listenToPocketVoiceStream,
        };
  stopActiveVoice = streamBackend.stop;
  streamListenerReady = streamBackend
    .listen(handleStreamEvent)
    .then((unlisten) => {
      if (activeGeneration !== generation) {
        unlisten();
        return;
      }
      stopStreamSubscription = unlisten;
    });

  const toolCountByMessage = new Map<string, number>();
  const consumedTextBySlot = new Map<string, string>();
  const completedMessages = new Set<string>();
  const interruptedMessages = new Set<string>();
  const failedMessages = new Set<string>();
  const interruptionCauseByMessage = new Map<string, InterruptionCause>();
  for (const message of initialMessages) {
    toolCountByMessage.set(
      message.id,
      message.content.filter((content) => content.type === "toolRequest")
        .length,
    );
    if (message.metadata?.completionStatus === "completed") {
      completedMessages.add(message.id);
    }
    let textOrdinal = 0;
    for (const content of message.content) {
      if (content.type !== "text") continue;
      consumedTextBySlot.set(
        `${message.id}\0text:${textOrdinal}`,
        content.text,
      );
      textOrdinal += 1;
    }
  }

  const ensureUtterance = (target: SpeechTarget): ActiveUtterance => {
    if (activeUtterance) {
      if (
        !activeUtterance.targets.some(
          (candidate) => targetKey(candidate) === targetKey(target),
        )
      ) {
        activeUtterance.targets.push(target);
        if (activeUtterance.status) {
          setTargetSpeech(sessionId, target, {
            status: activeUtterance.status,
          });
        }
      }
      return activeUtterance;
    }
    const interruptionPreference = getVoiceInterruptionPreference();
    const utterance: ActiveUtterance = {
      id: crypto.randomUUID(),
      sessionId,
      voiceRevision:
        activeSpeechRevision ??
        useVoiceConversationStore.getState().status.revision,
      interruptionMode: interruptionPreference.mode,
      interruptionSensitivity: interruptionPreference.sensitivity,
      targets: [target],
      targetSpans: [],
      text: "",
      finishing: false,
      nativeStreamStarted: false,
      interruptionRequested: false,
      interruptionFallback: null,
      interruptionCause: null,
      latestDelivery: null,
      status: null,
      onFailure: (text, error) => {
        for (const utteranceTarget of utterance.targets) {
          failedMessages.add(utteranceTarget.messageId);
        }
        onFailure(text, error);
      },
      onInterrupted: () => {
        for (const utteranceTarget of utterance.targets) {
          interruptedMessages.add(utteranceTarget.messageId);
          interruptionCauseByMessage.set(
            utteranceTarget.messageId,
            utterance.interruptionCause ?? "voiceStopped",
          );
        }
      },
      onTerminal: () => queueMicrotask(inspect),
    };
    activeUtterance = utterance;
    queueStreamCommand(
      utterance,
      async () => {
        await streamListenerReady;
        await streamBackend.start(
          utterance.id,
          utterance.interruptionMode,
          utterance.interruptionSensitivity,
        );
        if (
          utterance.interruptionRequested ||
          activeUtterance?.id !== utterance.id
        ) {
          await streamBackend.stop();
          return;
        }
        utterance.nativeStreamStarted = true;
      },
      onFailure,
    );
    return utterance;
  };

  const inspectNow = () => {
    if (activeGeneration !== generation) return;
    const voice = useVoiceConversationStore.getState();
    if (
      voice.status.lifecycle !== "running" ||
      voice.status.sessionId !== sessionId
    ) {
      return;
    }
    // The backend owns the current stream until its terminal playback event.
    // Leave later transcript changes entirely unconsumed so that terminal
    // handling can inspect them into a distinct utterance.
    if (activeUtterance?.finishing) return;

    const messages = useChatStore.getState().messagesBySession[sessionId] ?? [];
    for (const message of messages) {
      if (
        message.role !== "assistant" ||
        message.metadata?.userVisible === false
      ) {
        continue;
      }
      const toolCount = message.content.filter(
        (content) => content.type === "toolRequest",
      ).length;
      const priorToolCount = toolCountByMessage.get(message.id) ?? 0;
      const crossedToolBoundary = toolCount > priorToolCount;
      const completed =
        message.metadata?.completionStatus === "completed" &&
        !completedMessages.has(message.id);
      toolCountByMessage.set(message.id, toolCount);
      if (completed) completedMessages.add(message.id);

      let textOrdinal = 0;
      for (const content of message.content) {
        if (content.type !== "text") continue;
        const target = { messageId: message.id, textOrdinal };
        const slot = targetKey(target);
        textOrdinal += 1;
        const previous = consumedTextBySlot.get(slot) ?? "";
        if (content.text === previous) continue;
        const appendOnly = content.text.startsWith(previous);
        const delta = appendOnly
          ? content.text.slice(previous.length)
          : content.text;
        consumedTextBySlot.set(slot, content.text);
        if (!delta) continue;

        if (failedMessages.has(message.id)) {
          const currentSpeech = content.speech;
          const spokenThrough = appendOnly
            ? (currentSpeech?.spokenThrough ?? 0)
            : 0;
          setTargetSpeech(sessionId, target, {
            status: "failed",
            spokenThrough,
            confidence: appendOnly
              ? (currentSpeech?.confidence ?? "low")
              : "low",
          });
          recordPlaybackNotice(sessionId, slot, content.text, "failed", {
            cutoff: spokenThrough,
            spokenText: content.text.slice(0, spokenThrough),
            unspokenText: content.text.slice(spokenThrough),
            confidence: appendOnly
              ? (currentSpeech?.confidence ?? "low")
              : "low",
          });
          continue;
        }

        if (interruptedMessages.has(message.id)) {
          const currentSpeech = content.speech;
          const interruptionCause =
            currentSpeech?.interruptionCause ??
            interruptionCauseByMessage.get(message.id) ??
            "voiceStopped";
          const spokenThrough = appendOnly
            ? (currentSpeech?.spokenThrough ?? 0)
            : 0;
          if (!appendOnly) {
            setTargetSpeech(sessionId, target, { status: "notSpoken" });
            recordPlaybackNotice(
              sessionId,
              slot,
              content.text,
              "interrupted",
              {
                cutoff: 0,
                spokenText: "",
                unspokenText: content.text,
                confidence: "low",
              },
              interruptionCause,
            );
            continue;
          }
          if (currentSpeech?.status !== "interrupted") {
            setTargetSpeech(
              sessionId,
              target,
              spokenThrough > 0
                ? {
                    status: "interrupted",
                    spokenThrough,
                    confidence: currentSpeech?.confidence ?? "medium",
                    interruptionCause,
                  }
                : { status: "notSpoken" },
            );
          }
          recordPlaybackNotice(
            sessionId,
            slot,
            content.text,
            "interrupted",
            {
              cutoff: spokenThrough,
              spokenText: content.text.slice(0, spokenThrough),
              unspokenText: content.text.slice(spokenThrough),
              confidence: currentSpeech?.confidence ?? "low",
            },
            interruptionCause,
          );
          continue;
        }

        if (voice.userSpeaking) {
          setTargetSpeech(sessionId, target, { status: "notSpoken" });
          recordPlaybackNotice(sessionId, slot, content.text, "notSpoken");
          continue;
        }

        const utterance = ensureUtterance(target);
        if (utterance.finishing) continue;
        const spanStart = utterance.text.length;
        utterance.text += delta;
        const previousSpan = utterance.targetSpans.at(-1);
        if (
          previousSpan &&
          targetKey(previousSpan) === targetKey(target) &&
          previousSpan.end === spanStart
        ) {
          previousSpan.end = utterance.text.length;
        } else {
          utterance.targetSpans.push({
            ...target,
            start: spanStart,
            end: utterance.text.length,
          });
        }
        queueStreamCommand(
          utterance,
          () => streamBackend.append(utterance.id, delta),
          onFailure,
        );
      }

      const utterance = activeUtterance;
      if (crossedToolBoundary && utterance && !utterance.finishing) {
        queueStreamCommand(
          utterance,
          () => streamBackend.flush(utterance.id),
          onFailure,
        );
      }
      if (completed && utterance && !utterance.finishing) {
        utterance.finishing = true;
        queueStreamCommand(
          utterance,
          () => streamBackend.finish(utterance.id),
          onFailure,
        );
      }
    }
  };

  let inspecting = false;
  const inspect = () => {
    if (inspecting) return;
    inspecting = true;
    try {
      inspectNow();
    } finally {
      inspecting = false;
    }
  };

  stopSubscription = useChatStore.subscribe(inspect);
  const initialVoice = useVoiceConversationStore.getState();
  let reachedRunning =
    initialVoice.status.lifecycle === "running" &&
    initialVoice.status.sessionId === sessionId;
  if (reachedRunning) {
    activeSpeechRevision = initialVoice.status.revision;
  }
  let wasUserSpeaking = initialVoice.userSpeaking;
  stopVoiceSubscription = useVoiceConversationStore.subscribe((voice) => {
    const runningForSession =
      voice.status.lifecycle === "running" &&
      voice.status.sessionId === sessionId;
    if (!runningForSession) {
      if (
        reachedRunning ||
        voice.status.lifecycle === "unavailable" ||
        (voice.status.sessionId !== null &&
          voice.status.sessionId !== sessionId)
      ) {
        stopNativeAssistantSpeech(true);
      }
      return;
    }
    reachedRunning = true;
    activeSpeechRevision = voice.status.revision;
    inspect();
    const becameUserSpeaking = voice.userSpeaking && !wasUserSpeaking;
    wasUserSpeaking = voice.userSpeaking;
    if (!becameUserSpeaking || activeGeneration !== generation) return;
    interruptActiveUtterance(true, "userSpeaking");
  });
  queueMicrotask(inspect);
}
