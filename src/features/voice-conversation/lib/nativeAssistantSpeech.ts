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
  appendOpenAiVoiceStream,
  finishOpenAiVoiceStream,
  flushOpenAiVoiceStream,
  listenToOpenAiVoiceStream,
  startOpenAiVoiceStream,
  stopOpenAiVoice,
  type OpenAiVoiceStreamEvent,
} from "../api/openAiVoice";
import {
  appendSiriVoiceStream,
  finishSiriVoiceStream,
  flushSiriVoiceStream,
  listenToSiriVoiceStream,
  startSiriVoiceStream,
  stopSiriVoice,
  type SiriVoiceStreamEvent,
  type SiriVoiceSelection,
} from "../api/siriVoice";
import {
  cancelVoiceConversationAssistantSpeech,
  prepareVoiceConversationAssistantSpeech,
  setVoiceConversationAssistantSpeaking,
  type VoiceTranscriptReference,
} from "../api/voiceConversation";
import {
  FIXED_INTERRUPTION_SENSITIVITY,
  getVoiceInterruptionPreference,
  type VoiceInterruptionMode,
  type VoiceInterruptionSensitivity,
} from "./voiceInterruptionPreference";
import { getVoiceOutputBackend } from "./voiceOutputPreference";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";

type SpeechFailureHandler = (text: string, error: unknown) => void;
type SpeechTarget = { messageId: string; textOrdinal: number };
type SpeechTargetSpan = SpeechTarget & {
  start: number;
  end: number;
  targetStart: number;
  targetEnd: number;
};
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
  nativeStartQueued: boolean;
  nativeStartInvoked: boolean;
  speechId: number | null;
  interruptionRequested: boolean;
  resumptionDiscarded: boolean;
  interruptionFallback: ReturnType<typeof setTimeout> | null;
  interruptionCause: InterruptionCause | null;
  latestDelivery: VoiceDeliveryProgress | null;
  causalTranscriptKey: string | null;
  causalTranscriptReference: VoiceTranscriptReference | null;
  status: SpeechStatus | null;
  onFailure: SpeechFailureHandler;
  onInterrupted: (
    estimate: SpeechDeliveryEstimate,
    cause: InterruptionCause,
    allowResume: boolean,
  ) => boolean;
  onTerminal: () => void;
};
type HeldSpeech = {
  targets: Map<
    string,
    { target: SpeechTarget; text: string; causalTranscriptKey: string | null }
  >;
};
type ResumableInterruption = {
  utterance: ActiveUtterance;
  estimate: SpeechDeliveryEstimate;
  resumeCutoff: number;
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
let activeSiriVoice: SiriVoiceSelection | null = null;
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
const MALFORMED_VOICE_TRANSCRIPT_KEY = "\0malformed-voice-transcript";
const USER_IDLE_TRANSCRIPT_SETTLE_MS = 250;
const USER_RECOGNITION_SEGMENT_TIMEOUT_MS = 500;

function voiceTranscriptKeyForMessage(
  sessionId: string,
  message: ReturnType<
    typeof useChatStore.getState
  >["messagesBySession"][string][number],
): string | null {
  const metadata = message.metadata;
  if (metadata?.origin !== "voice_conversation") return null;
  if (
    typeof metadata.voiceConversationLifecycleId !== "string" ||
    metadata.voiceConversationLifecycleId.length === 0 ||
    typeof metadata.voiceConversationRevision !== "number" ||
    !Number.isInteger(metadata.voiceConversationRevision) ||
    typeof metadata.voiceUtteranceId !== "string" ||
    metadata.voiceUtteranceId.length === 0
  ) {
    return MALFORMED_VOICE_TRANSCRIPT_KEY;
  }
  return [
    sessionId,
    metadata.voiceConversationLifecycleId,
    metadata.voiceConversationRevision,
    metadata.voiceUtteranceId,
  ].join("\0");
}

function voiceTranscriptReferenceForMessage(
  message: ReturnType<
    typeof useChatStore.getState
  >["messagesBySession"][string][number],
): VoiceTranscriptReference | null {
  const metadata = message.metadata;
  if (
    metadata?.origin !== "voice_conversation" ||
    typeof metadata.voiceConversationLifecycleId !== "string" ||
    metadata.voiceConversationLifecycleId.length === 0 ||
    typeof metadata.voiceConversationRevision !== "number" ||
    !Number.isInteger(metadata.voiceConversationRevision) ||
    typeof metadata.voiceUtteranceId !== "string" ||
    metadata.voiceUtteranceId.length === 0
  ) {
    return null;
  }
  return {
    lifecycleId: metadata.voiceConversationLifecycleId,
    id: metadata.voiceUtteranceId,
    revision: metadata.voiceConversationRevision,
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
  const noticeKey = `${sessionId}\0${key}`;
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

function safeResumeCutoff(
  text: string,
  delivery: VoiceDeliveryProgress | null,
): number {
  if (!delivery?.segments.length) return 0;

  let searchFrom = 0;
  let cutoff = 0;
  for (const segment of delivery.segments) {
    const segmentStart = text.indexOf(segment.text, searchFrom);
    if (segmentStart === -1) return cutoff;
    const segmentEnd = segmentStart + segment.text.length;
    const fullyPlayed =
      segment.synthesisComplete &&
      segment.totalFrames > 0 &&
      segment.playedFrames >= segment.totalFrames;
    if (!fullyPlayed) return segmentStart;
    cutoff = segmentEnd;
    searchFrom = segmentEnd;
  }
  return cutoff;
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
    const content = targetContent(utterance.sessionId, target);
    if (!content || !targetRetainsUtteranceText(utterance, target, content)) {
      setTargetSpeech(utterance.sessionId, target, { status: "notSpoken" });
      continue;
    }
    if (localCutoff >= targetLength && targetLength > 0) {
      if (utterance.resumptionDiscarded && content.text.length > targetLength) {
        setTargetSpeech(utterance.sessionId, target, {
          status: "interrupted",
          spokenThrough: targetLength,
          confidence: estimate.confidence,
          interruptionCause: utterance.interruptionCause ?? "voiceStopped",
        });
        continue;
      }
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
    let localCutoff = 0;
    for (const span of spans) {
      if (cutoff < span.start) break;
      localCutoff =
        span.targetStart + Math.max(0, Math.min(span.end, cutoff) - span.start);
      if (cutoff < span.end) break;
    }
    return {
      target,
      targetLength: spans.at(-1)?.targetEnd ?? 0,
      localCutoff,
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

function targetRetainsUtteranceText(
  utterance: ActiveUtterance,
  target: SpeechTarget,
  content: TextContent,
): boolean {
  return utterance.targetSpans
    .filter((span) => targetKey(span) === targetKey(target))
    .every(
      (span) =>
        content.text.slice(span.targetStart, span.targetEnd) ===
        utterance.text.slice(span.start, span.end),
    );
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

function applyCompletedUtteranceStatus(utterance: ActiveUtterance): boolean {
  let hasDiscardedSuffix = false;
  for (const target of utterance.targets) {
    const content = targetContent(utterance.sessionId, target);
    const targetEnd = utterance.targetSpans
      .filter((span) => targetKey(span) === targetKey(target))
      .at(-1)?.targetEnd;
    if (!content || !targetRetainsUtteranceText(utterance, target, content)) {
      setTargetSpeech(utterance.sessionId, target, { status: "notSpoken" });
      hasDiscardedSuffix = true;
      continue;
    }
    if (
      utterance.resumptionDiscarded &&
      targetEnd !== undefined &&
      content.text.length > targetEnd
    ) {
      hasDiscardedSuffix = true;
      setTargetSpeech(utterance.sessionId, target, {
        status: "interrupted",
        spokenThrough: targetEnd,
        confidence: "medium",
        interruptionCause: utterance.interruptionCause ?? "voiceStopped",
      });
      continue;
    }
    setTargetSpeech(utterance.sessionId, target, { status: "spoken" });
  }
  utterance.status = hasDiscardedSuffix ? "interrupted" : "spoken";
  return hasDiscardedSuffix;
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
  allowResume = false,
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
  const noticeDeferred = utterance.onInterrupted(estimate, cause, allowResume);
  if (!noticeDeferred) {
    recordDeliveryNotices(utterance, estimate, "interrupted", cause);
  }
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
  event: PocketVoiceStreamEvent | SiriVoiceStreamEvent | OpenAiVoiceStreamEvent,
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
      if (applyCompletedUtteranceStatus(utterance)) {
        recordDeliveryNotices(
          utterance,
          estimateSpeechDelivery(utterance.text, utterance.latestDelivery),
          "interrupted",
          utterance.interruptionCause ?? "voiceStopped",
        );
      }
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
        true,
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
    awaitTerminalDelivery && utterance?.nativeStartInvoked === true;
  commandEpoch += 1;
  if (utterance && !utterance.interruptionRequested) {
    utterance.interruptionRequested = true;
    utterance.interruptionCause = cause;
    if (utterance.speechId !== null) {
      void cancelVoiceConversationAssistantSpeech(
        utterance.sessionId,
        utterance.voiceRevision,
        utterance.speechId,
      ).catch(() => false);
    }
  }
  if (utterance && !terminalEventExpected) {
    finalizeInterruptedUtterance(
      utterance,
      utterance.interruptionCause ?? cause,
      awaitTerminalDelivery && cause === "userSpeaking",
    );
  }
  if (utterance && terminalEventExpected) {
    const stopVoice = stopActiveVoice;
    utterance.interruptionFallback = setTimeout(() => {
      if (activeUtterance?.id !== utterance.id) return;
      utterance.interruptionFallback = null;
      void stopVoice()
        .then((playbackStillActive) => {
          finalizeInterruptedUtterance(
            utterance,
            utterance.interruptionCause ?? cause,
            cause === "userSpeaking" && !playbackStillActive,
          );
        })
        .catch(() => {
          finalizeInterruptedUtterance(
            utterance,
            utterance.interruptionCause ?? cause,
          );
        });
    }, INTERRUPTION_TERMINAL_TIMEOUT_MS);
    void stopVoice().catch(() => undefined);
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
    awaitTerminalDelivery && utterance?.nativeStartInvoked === true;
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
  activeSiriVoice = null;
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
  siriVoice?: SiriVoiceSelection,
): void {
  if (activeSpeechSessionId === sessionId) {
    if (siriVoice) activeSiriVoice = siriVoice;
    return;
  }
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
        startNativeAssistantSpeech(
          sessionId,
          onFailure,
          initialMessages,
          siriVoice,
        );
      });
    };
    return;
  }
  stopNativeAssistantSpeech();
  activeSiriVoice = siriVoice ?? null;
  activeSpeechSessionId = sessionId;
  activeSpeechRevision = useVoiceConversationStore.getState().status.revision;
  const activeGeneration = generation;
  const outputBackend = getVoiceOutputBackend();
  const streamBackend =
    outputBackend === "siri"
      ? {
          start: (
            speechId: number,
            streamId: string,
            voiceRevision: number,
            interruptionMode: VoiceInterruptionMode,
            interruptionSensitivity: VoiceInterruptionSensitivity,
          ) => {
            if (!activeSiriVoice) {
              return Promise.reject(
                new Error("No installed Siri voice is available for playback"),
              );
            }
            return startSiriVoiceStream(
              sessionId,
              voiceRevision,
              speechId,
              streamId,
              activeSiriVoice,
              interruptionMode,
              interruptionSensitivity,
            );
          },
          append: appendSiriVoiceStream,
          flush: flushSiriVoiceStream,
          finish: finishSiriVoiceStream,
          stop: stopSiriVoice,
          listen: listenToSiriVoiceStream,
        }
      : outputBackend === "openai"
        ? {
            start: (
              speechId: number,
              streamId: string,
              voiceRevision: number,
              interruptionMode: VoiceInterruptionMode,
              interruptionSensitivity: VoiceInterruptionSensitivity,
            ) =>
              startOpenAiVoiceStream(
                sessionId,
                voiceRevision,
                speechId,
                streamId,
                interruptionMode,
                interruptionSensitivity,
              ),
            append: appendOpenAiVoiceStream,
            flush: flushOpenAiVoiceStream,
            finish: finishOpenAiVoiceStream,
            stop: stopOpenAiVoice,
            listen: listenToOpenAiVoiceStream,
          }
        : {
            start: (
              speechId: number,
              streamId: string,
              voiceRevision: number,
              interruptionMode: VoiceInterruptionMode,
              interruptionSensitivity: VoiceInterruptionSensitivity,
            ) =>
              startPocketVoiceStream(
                sessionId,
                voiceRevision,
                speechId,
                streamId,
                interruptionMode,
                interruptionSensitivity,
              ),
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

  const initialVoice = useVoiceConversationStore.getState();
  const toolCountByMessage = new Map<string, number>();
  const consumedTextBySlot = new Map<string, string>();
  const causalTranscriptKeyByMessage = new Map<string, string | null>();
  const transcriptReferenceByKey = new Map<string, VoiceTranscriptReference>();
  const invalidatedMessages = new Set<string>();
  const completedMessages = new Set<string>();
  const interruptedMessages = new Set<string>();
  const failedMessages = new Set<string>();
  const interruptionCauseByMessage = new Map<string, InterruptionCause>();
  let precedingTranscriptKey: string | null = null;
  for (const message of initialMessages) {
    if (message.role === "user") {
      const voiceTranscriptKey = voiceTranscriptKeyForMessage(
        sessionId,
        message,
      );
      if (voiceTranscriptKey !== null) {
        precedingTranscriptKey = voiceTranscriptKey;
        const reference = voiceTranscriptReferenceForMessage(message);
        if (reference)
          transcriptReferenceByKey.set(voiceTranscriptKey, reference);
      }
    } else if (message.role === "assistant") {
      causalTranscriptKeyByMessage.set(message.id, precedingTranscriptKey);
    }
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
  let heldSpeech: HeldSpeech | null = null;
  let resumableInterruption: ResumableInterruption | null = null;
  let heldReleaseReady = false;
  let interruptionReleaseReady = false;
  let pendingUserRecognitionSegment = false;
  let recognitionSegmentTimer: number | null = null;
  let heldReleaseTimer: number | null = null;

  const cacheCausalTranscriptKeys = (
    messages: ReturnType<
      typeof useChatStore.getState
    >["messagesBySession"][string],
  ) => {
    let causalTranscriptKey: string | null = null;
    for (const message of messages ?? []) {
      if (message.role === "user") {
        const voiceTranscriptKey = voiceTranscriptKeyForMessage(
          sessionId,
          message,
        );
        if (voiceTranscriptKey !== null) {
          causalTranscriptKey = voiceTranscriptKey;
          const reference = voiceTranscriptReferenceForMessage(message);
          if (reference)
            transcriptReferenceByKey.set(voiceTranscriptKey, reference);
        }
      } else if (
        message.role === "assistant" &&
        !causalTranscriptKeyByMessage.has(message.id)
      ) {
        causalTranscriptKeyByMessage.set(message.id, causalTranscriptKey);
      }
    }
  };

  const suppressTarget = (slot: string, target: SpeechTarget, text: string) => {
    invalidatedMessages.add(target.messageId);
    consumedTextBySlot.set(slot, text);
    setTargetSpeech(sessionId, target, { status: "notSpoken" });
    recordPlaybackNotice(sessionId, slot, text, "notSpoken");
  };

  const discardHeldTarget = (
    slot: string,
    target: SpeechTarget,
    text: string,
  ) => {
    const consumedPrefix = consumedTextBySlot.get(slot) ?? "";
    const content = targetContent(sessionId, target);
    if (
      consumedPrefix.length > 0 &&
      text.startsWith(consumedPrefix) &&
      content?.speech?.status === "spoken"
    ) {
      invalidatedMessages.add(target.messageId);
      interruptedMessages.add(target.messageId);
      interruptionCauseByMessage.set(target.messageId, "voiceStopped");
      consumedTextBySlot.set(slot, text);
      const estimate: SpeechDeliveryEstimate = {
        cutoff: consumedPrefix.length,
        spokenText: consumedPrefix,
        unspokenText: text.slice(consumedPrefix.length),
        confidence: "medium",
      };
      setTargetSpeech(sessionId, target, {
        status: "interrupted",
        spokenThrough: estimate.cutoff,
        confidence: estimate.confidence,
        interruptionCause: "voiceStopped",
      });
      recordPlaybackNotice(sessionId, slot, text, "interrupted", estimate);
      return;
    }
    suppressTarget(slot, target, text);
  };

  const holdAssistantChanges = (
    messages: ReturnType<
      typeof useChatStore.getState
    >["messagesBySession"][string],
  ) => {
    cacheCausalTranscriptKeys(messages);
    for (const message of messages ?? []) {
      if (
        message.role !== "assistant" ||
        message.metadata?.userVisible === false ||
        interruptedMessages.has(message.id) ||
        failedMessages.has(message.id)
      ) {
        continue;
      }
      let textOrdinal = 0;
      for (const content of message.content) {
        if (content.type !== "text") continue;
        const target = { messageId: message.id, textOrdinal };
        const slot = targetKey(target);
        textOrdinal += 1;
        if (content.text === (consumedTextBySlot.get(slot) ?? "")) continue;
        if (invalidatedMessages.has(message.id)) {
          suppressTarget(slot, target, content.text);
          continue;
        }
        heldSpeech ??= { targets: new Map() };
        heldSpeech.targets.set(slot, {
          target,
          text: content.text,
          causalTranscriptKey:
            causalTranscriptKeyByMessage.get(message.id) ?? null,
        });
      }
    }
  };

  const discardInvalidHeldSpeech = (finalizedTranscriptKey: string | null) => {
    const held = heldSpeech;
    if (!held) return;
    for (const [slot, heldTarget] of held.targets) {
      if (heldTarget.causalTranscriptKey === finalizedTranscriptKey) continue;
      if (interruptedMessages.has(heldTarget.target.messageId)) {
        held.targets.delete(slot);
        continue;
      }
      discardHeldTarget(slot, heldTarget.target, heldTarget.text);
      held.targets.delete(slot);
    }
    if (held.targets.size === 0) {
      heldSpeech = null;
      heldReleaseReady = false;
    }
  };

  const discardResumableInterruption = () => {
    const pending = resumableInterruption;
    if (!pending) return;
    for (const target of pending.utterance.targets) {
      interruptedMessages.add(target.messageId);
      interruptionCauseByMessage.set(target.messageId, "userSpeaking");
    }
    recordDeliveryNotices(
      pending.utterance,
      pending.estimate,
      "interrupted",
      "userSpeaking",
    );
    resumableInterruption = null;
    interruptionReleaseReady = false;
  };

  const releaseResumableInterruption = () => {
    const pending = resumableInterruption;
    if (!pending || !interruptionReleaseReady) return;
    const finalizedTranscriptKey =
      useVoiceConversationStore.getState().latestFinalizedTranscriptKey;
    if (
      pending.utterance.resumptionDiscarded ||
      pending.utterance.causalTranscriptKey !== finalizedTranscriptKey
    ) {
      discardResumableInterruption();
      return;
    }
    for (const { target, localCutoff } of targetDeliveryCutoffs(
      pending.utterance,
      pending.resumeCutoff,
    )) {
      const content = targetContent(sessionId, target);
      if (!content) continue;
      const priorText = consumedTextBySlot.get(targetKey(target)) ?? "";
      const safeLocalCutoff = content.text.startsWith(priorText)
        ? localCutoff
        : 0;
      consumedTextBySlot.set(
        targetKey(target),
        content.text.slice(0, safeLocalCutoff),
      );
      completedMessages.delete(target.messageId);
    }
    resumableInterruption = null;
    interruptionReleaseReady = false;
  };

  const discardHeldAndResumableSpeech = () => {
    if (activeUtterance) activeUtterance.resumptionDiscarded = true;
    const held = heldSpeech;
    if (held) {
      for (const [slot, heldTarget] of held.targets) {
        discardHeldTarget(slot, heldTarget.target, heldTarget.text);
      }
      heldSpeech = null;
      heldReleaseReady = false;
    }
    discardResumableInterruption();
  };

  const ensureUtterance = (
    target: SpeechTarget,
    causalTranscriptKey: string | null,
  ): ActiveUtterance | null => {
    if (activeUtterance) {
      if (activeUtterance.causalTranscriptKey !== causalTranscriptKey) {
        return null;
      }
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
      interruptionSensitivity: FIXED_INTERRUPTION_SENSITIVITY,
      targets: [target],
      targetSpans: [],
      text: "",
      finishing: false,
      nativeStartQueued: false,
      nativeStartInvoked: false,
      speechId: null,
      interruptionRequested: false,
      resumptionDiscarded: false,
      interruptionFallback: null,
      interruptionCause: null,
      latestDelivery: null,
      causalTranscriptKey,
      causalTranscriptReference:
        causalTranscriptKey === null
          ? null
          : (transcriptReferenceByKey.get(causalTranscriptKey) ?? null),
      status: null,
      onFailure: (text, error) => {
        for (const utteranceTarget of utterance.targets) {
          failedMessages.add(utteranceTarget.messageId);
        }
        onFailure(text, error);
      },
      onInterrupted: (estimate, cause, allowResume) => {
        const finalizedTranscriptKey =
          useVoiceConversationStore.getState().latestFinalizedTranscriptKey;
        if (
          cause === "userSpeaking" &&
          allowResume &&
          !utterance.resumptionDiscarded &&
          utterance.causalTranscriptKey === finalizedTranscriptKey
        ) {
          resumableInterruption = {
            utterance,
            estimate,
            resumeCutoff: safeResumeCutoff(
              utterance.text,
              utterance.latestDelivery,
            ),
          };
          releaseResumableInterruption();
          return true;
        }
        for (const utteranceTarget of utterance.targets) {
          interruptedMessages.add(utteranceTarget.messageId);
          interruptionCauseByMessage.set(
            utteranceTarget.messageId,
            utterance.interruptionCause ?? "voiceStopped",
          );
        }
        return false;
      },
      onTerminal: () => queueMicrotask(inspect),
    };
    activeUtterance = utterance;
    return utterance;
  };

  const queueNativeStart = (utterance: ActiveUtterance) => {
    if (utterance.nativeStartQueued) return;
    utterance.nativeStartQueued = true;
    queueStreamCommand(
      utterance,
      async () => {
        await streamListenerReady;
        if (
          utterance.interruptionRequested ||
          activeUtterance?.id !== utterance.id
        ) {
          return;
        }
        const prepared = await prepareVoiceConversationAssistantSpeech(
          utterance.sessionId,
          utterance.voiceRevision,
          utterance.text,
          utterance.causalTranscriptReference,
        );
        if (
          utterance.interruptionRequested ||
          activeUtterance?.id !== utterance.id
        ) {
          if (prepared.outcome === "admitted") {
            await cancelVoiceConversationAssistantSpeech(
              utterance.sessionId,
              utterance.voiceRevision,
              prepared.speechId,
            );
          }
          return;
        }
        if (prepared.outcome === "pending") {
          commandEpoch += 1;
          for (const target of utterance.targets) {
            const content = targetContent(utterance.sessionId, target);
            suppressTarget(
              targetKey(target),
              target,
              content?.text ?? utterance.text,
            );
          }
          if (activeUtterance?.id === utterance.id) {
            activeUtterance = null;
          }
          restoreListeningIfConversationIsRunning(utterance);
          utterance.onTerminal();
          return;
        }
        if (prepared.outcome === "notAdmitted") {
          interruptActiveUtterance(false, "voiceStopped");
          return;
        }
        utterance.speechId = prepared.speechId;
        let started: boolean;
        try {
          // Once the native start command has been invoked, interruption must
          // preserve terminal ownership until that command resolves or emits
          // its stream terminal event.
          utterance.nativeStartInvoked = true;
          started = await streamBackend.start(
            prepared.speechId,
            utterance.id,
            utterance.voiceRevision,
            utterance.interruptionMode,
            utterance.interruptionSensitivity,
          );
        } catch (error) {
          await cancelVoiceConversationAssistantSpeech(
            utterance.sessionId,
            utterance.voiceRevision,
            prepared.speechId,
          ).catch(() => false);
          throw error;
        }
        if (!started) {
          utterance.nativeStartInvoked = false;
          interruptActiveUtterance(false, "userSpeaking");
          return;
        }
        if (
          utterance.interruptionRequested ||
          activeUtterance?.id !== utterance.id
        ) {
          await streamBackend.stop();
        }
      },
      onFailure,
    );
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
    const messages = useChatStore.getState().messagesBySession[sessionId] ?? [];
    if (
      heldSpeech ||
      voice.userSpeaking ||
      pendingUserRecognitionSegment ||
      heldReleaseTimer !== null
    ) {
      // Text can keep streaming while recognition resolves the user's
      // interruption segment. Refresh the held snapshot before a finalized
      // voice message can invalidate it.
      holdAssistantChanges(messages);
    }
    const finalizedTranscriptKey = voice.latestFinalizedTranscriptKey;
    if (
      resumableInterruption &&
      (resumableInterruption.utterance.resumptionDiscarded ||
        resumableInterruption.utterance.causalTranscriptKey !==
          finalizedTranscriptKey)
    ) {
      discardResumableInterruption();
    }
    discardInvalidHeldSpeech(finalizedTranscriptKey);
    if (
      activeUtterance &&
      activeUtterance.causalTranscriptKey !== finalizedTranscriptKey
    ) {
      activeUtterance.resumptionDiscarded = true;
      interruptActiveUtterance(true, "userSpeaking");
    }

    if (voice.userSpeaking || pendingUserRecognitionSegment) return;
    if (heldSpeech && !heldReleaseReady) return;
    if (resumableInterruption) return;
    if (activeUtterance?.interruptionRequested) return;

    // The backend owns the current stream until its terminal playback event.
    // Leave later transcript changes entirely unconsumed so that terminal
    // handling can inspect them into a distinct utterance.
    if (activeUtterance?.finishing) return;

    cacheCausalTranscriptKeys(messages);

    for (const message of messages) {
      // Completing one message hands its stream to the backend. Do not
      // advance any later message's cursors until that terminal event lets a
      // fresh utterance inspect it.
      if (activeUtterance?.finishing) break;
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
      let textOrdinal = 0;
      for (const content of message.content) {
        if (content.type !== "text") continue;
        const target = { messageId: message.id, textOrdinal };
        const slot = targetKey(target);
        textOrdinal += 1;
        const previous = consumedTextBySlot.get(slot) ?? "";
        if (content.text === previous) continue;
        const appendOnly = content.text.startsWith(previous);
        const causalTranscriptKey =
          causalTranscriptKeyByMessage.get(message.id) ?? null;
        const delta = appendOnly
          ? content.text.slice(previous.length)
          : content.text;
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

        if (
          invalidatedMessages.has(message.id) ||
          (causalTranscriptKey !== null &&
            causalTranscriptKey !== finalizedTranscriptKey)
        ) {
          suppressTarget(slot, target, content.text);
          continue;
        }

        const targetWasHeld =
          heldReleaseReady && (heldSpeech?.targets.has(slot) ?? false);
        const utterance = ensureUtterance(target, causalTranscriptKey);
        if (!utterance) break;
        consumedTextBySlot.set(slot, content.text);
        if (utterance.finishing) continue;
        const spanStart = utterance.text.length;
        const targetStart = appendOnly ? previous.length : 0;
        utterance.text += delta;
        const previousSpan = utterance.targetSpans.at(-1);
        if (
          previousSpan &&
          targetKey(previousSpan) === targetKey(target) &&
          previousSpan.end === spanStart &&
          previousSpan.targetEnd === targetStart
        ) {
          previousSpan.end = utterance.text.length;
          previousSpan.targetEnd = targetStart + delta.length;
        } else {
          utterance.targetSpans.push({
            ...target,
            start: spanStart,
            end: utterance.text.length,
            targetStart,
            targetEnd: targetStart + delta.length,
          });
        }
        if (utterance.text.trim().length === 0) continue;
        queueNativeStart(utterance);
        queueStreamCommand(
          utterance,
          () => streamBackend.append(utterance.id, delta),
          onFailure,
        );
        if (targetWasHeld) {
          heldSpeech?.targets.delete(slot);
          if (heldSpeech?.targets.size === 0) {
            heldSpeech = null;
            heldReleaseReady = false;
          }
        }
      }

      const utterance = activeUtterance;
      const utteranceOwnsMessage = utterance?.targets.some(
        (target) => target.messageId === message.id,
      );
      const messageCannotSpeak =
        failedMessages.has(message.id) ||
        interruptedMessages.has(message.id) ||
        invalidatedMessages.has(message.id);
      if (utteranceOwnsMessage || messageCannotSpeak) {
        toolCountByMessage.set(message.id, toolCount);
        if (completed) completedMessages.add(message.id);
      }
      if (
        crossedToolBoundary &&
        utterance &&
        utteranceOwnsMessage &&
        utterance.nativeStartQueued &&
        !utterance.finishing
      ) {
        queueStreamCommand(
          utterance,
          () => streamBackend.flush(utterance.id),
          onFailure,
        );
      }
      if (
        completed &&
        utterance &&
        utteranceOwnsMessage &&
        !utterance.nativeStartQueued
      ) {
        for (const target of utterance.targets) {
          heldSpeech?.targets.delete(targetKey(target));
        }
        if (heldSpeech?.targets.size === 0) {
          heldSpeech = null;
          heldReleaseReady = false;
        }
        activeUtterance = null;
        continue;
      }
      if (
        completed &&
        utterance &&
        utteranceOwnsMessage &&
        !utterance.finishing
      ) {
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
  let reachedRunning =
    initialVoice.status.lifecycle === "running" &&
    initialVoice.status.sessionId === sessionId;
  if (reachedRunning) {
    activeSpeechRevision = initialVoice.status.revision;
  }
  let wasUserSpeaking = initialVoice.userSpeaking;
  let wasMicrophoneMuted = initialVoice.microphoneMuted;
  let latestObservedFinalizedTranscriptKey =
    useVoiceConversationStore.getState().latestFinalizedTranscriptKey;
  const resolvePendingRecognitionSegment = (releaseSpeech = true) => {
    if (recognitionSegmentTimer !== null) {
      window.clearTimeout(recognitionSegmentTimer);
      recognitionSegmentTimer = null;
    }
    pendingUserRecognitionSegment = false;
    if (!releaseSpeech) return;
    heldReleaseReady = heldSpeech !== null;
    interruptionReleaseReady = true;
    releaseResumableInterruption();
  };
  const unsubscribeVoice = useVoiceConversationStore.subscribe((voice) => {
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
    const becameUserSpeaking = voice.userSpeaking && !wasUserSpeaking;
    const becameUserIdle = !voice.userSpeaking && wasUserSpeaking;
    const becameMicrophoneMuted = voice.microphoneMuted && !wasMicrophoneMuted;
    const finalizedTranscriptChanged =
      voice.latestFinalizedTranscriptKey !==
      latestObservedFinalizedTranscriptKey;
    const hasInterruptedPlaybackHold =
      activeUtterance?.interruptionRequested || resumableInterruption !== null;
    wasUserSpeaking = voice.userSpeaking;
    wasMicrophoneMuted = voice.microphoneMuted;
    latestObservedFinalizedTranscriptKey = voice.latestFinalizedTranscriptKey;
    if (activeGeneration !== generation) return;
    if (becameMicrophoneMuted) {
      resolvePendingRecognitionSegment(false);
      interruptionReleaseReady = false;
      discardHeldAndResumableSpeech();
      inspect();
      return;
    }
    if (finalizedTranscriptChanged && !pendingUserRecognitionSegment) {
      if (heldReleaseTimer !== null) {
        window.clearTimeout(heldReleaseTimer);
        heldReleaseTimer = null;
      }
      holdAssistantChanges(
        useChatStore.getState().messagesBySession[sessionId] ?? [],
      );
      discardInvalidHeldSpeech(voice.latestFinalizedTranscriptKey);
      inspect();
      return;
    }
    if (becameUserSpeaking) {
      if (heldReleaseTimer !== null) {
        window.clearTimeout(heldReleaseTimer);
        heldReleaseTimer = null;
      }
      const interrupted = interruptActiveUtterance(true, "userSpeaking");
      if (interrupted && recognitionSegmentTimer !== null) {
        window.clearTimeout(recognitionSegmentTimer);
        recognitionSegmentTimer = null;
      }
      pendingUserRecognitionSegment ||= interrupted;
      heldReleaseReady = false;
      interruptionReleaseReady = false;
      inspect();
      return;
    }
    if (finalizedTranscriptChanged && pendingUserRecognitionSegment) {
      holdAssistantChanges(
        useChatStore.getState().messagesBySession[sessionId] ?? [],
      );
      const hadResumableInterruption = resumableInterruption !== null;
      resolvePendingRecognitionSegment(false);
      if (hadResumableInterruption) {
        discardResumableInterruption();
        discardInvalidHeldSpeech(voice.latestFinalizedTranscriptKey);
      } else {
        discardHeldAndResumableSpeech();
      }
      inspect();
      return;
    }
    if (becameUserIdle) {
      if (heldReleaseTimer !== null) window.clearTimeout(heldReleaseTimer);
      if (pendingUserRecognitionSegment || hasInterruptedPlaybackHold) {
        pendingUserRecognitionSegment = true;
        // VAD silence does not imply recognition is idle. Keep interrupted
        // playback held until a final transcript arrives or the unresolved
        // user-recognition segment hits a conservative bound.
        recognitionSegmentTimer ??= window.setTimeout(() => {
          recognitionSegmentTimer = null;
          const current = useVoiceConversationStore.getState();
          if (
            activeGeneration !== generation ||
            current.userSpeaking ||
            current.status.lifecycle !== "running" ||
            current.status.sessionId !== sessionId ||
            !pendingUserRecognitionSegment
          ) {
            return;
          }
          resolvePendingRecognitionSegment(true);
          inspect();
        }, USER_RECOGNITION_SEGMENT_TIMEOUT_MS);
        inspect();
        return;
      }
      heldReleaseTimer = window.setTimeout(() => {
        heldReleaseTimer = null;
        const current = useVoiceConversationStore.getState();
        if (
          activeGeneration !== generation ||
          current.userSpeaking ||
          current.status.lifecycle !== "running" ||
          current.status.sessionId !== sessionId
        ) {
          return;
        }
        heldReleaseReady = heldSpeech !== null;
        interruptionReleaseReady = true;
        releaseResumableInterruption();
        inspect();
      }, USER_IDLE_TRANSCRIPT_SETTLE_MS);
      return;
    }
    inspect();
  });
  stopVoiceSubscription = () => {
    if (heldReleaseTimer !== null) {
      window.clearTimeout(heldReleaseTimer);
    }
    if (recognitionSegmentTimer !== null) {
      window.clearTimeout(recognitionSegmentTimer);
    }
    heldReleaseTimer = null;
    recognitionSegmentTimer = null;
    pendingUserRecognitionSegment = false;
    discardHeldAndResumableSpeech();
    unsubscribeVoice();
  };
  queueMicrotask(inspect);
}
