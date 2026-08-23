import { useChatStore } from "@/features/chat/stores/chatStore";
import type { VoiceSpeechState } from "@/shared/types/messages";
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
type ActiveUtterance = {
  id: string;
  sessionId: string;
  voiceRevision: number;
  targets: SpeechTarget[];
  targetSpans: SpeechTargetSpan[];
  text: string;
  finishing: boolean;
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
const pendingNotices = new Map<string, string[]>();
const recordedNoticeKeys = new Set<string>();

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
) {
  const noticeKey = `${sessionId}\0${key}\0${status}`;
  if (recordedNoticeKeys.has(noticeKey)) return;
  recordedNoticeKeys.add(noticeKey);
  const excerpt = text.length > 500 ? `${text.slice(0, 497).trimEnd()}…` : text;
  const outcome =
    status === "interrupted"
      ? "TTS delivery was interrupted because the user started speaking; the assistant reply was not fully spoken."
      : status === "notSpoken"
        ? "TTS delivery was blocked because the user was speaking; the assistant reply was not spoken."
        : "Native TTS could not deliver the assistant reply.";
  const estimateLine = estimate
    ? `\nDelivery estimate: ${JSON.stringify({
        spokenText: estimate.spokenText,
        unspokenText: estimate.unspokenText,
        cutoff: estimate.cutoff,
        confidence: estimate.confidence,
        estimated: true,
      })}`
    : "";
  const notice =
    `[voice: tts-delivery-failed]\n${outcome}\nOriginal text: ${excerpt}${estimateLine}\n` +
    "This is TTS delivery state, not live user voice input. Do not respond to this control message or repeat the reply unless re-delivery is still appropriate.";
  pendingNotices.set(sessionId, [
    ...(pendingNotices.get(sessionId) ?? []),
    notice,
  ]);
}

export function takeVoicePlaybackNotices(sessionId: string): string | null {
  const notices = pendingNotices.get(sessionId);
  pendingNotices.delete(sessionId);
  return notices?.join("\n") ?? null;
}

function targetKey(target: SpeechTarget): string {
  return `${target.messageId}\0text:${target.textOrdinal}`;
}

function completedWordCutoff(text: string, playedRatio: number): number {
  const approximateCutoff = Math.floor(
    text.length * Math.max(0, Math.min(1, playedRatio)),
  );
  if (approximateCutoff >= text.length) return text.length;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let cutoff = 0;
  for (const part of segmenter.segment(text)) {
    const end = part.index + part.segment.length;
    if (end > approximateCutoff) break;
    if (part.isWordLike) cutoff = end;
  }
  return cutoff;
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
    confidence: matchedSegment ? "medium" : "low",
  };
}

function targetText(sessionId: string, target: SpeechTarget): string {
  const message =
    useChatStore
      .getState()
      .messagesBySession[sessionId]?.find(
        (candidate) => candidate.id === target.messageId,
      ) ?? null;
  if (!message) return "";
  let textOrdinal = 0;
  for (const content of message.content) {
    if (content.type !== "text") continue;
    if (textOrdinal === target.textOrdinal) return content.text;
    textOrdinal += 1;
  }
  return "";
}

function applyInterruptionEstimate(
  utterance: ActiveUtterance,
  estimate: SpeechDeliveryEstimate,
) {
  const firstTargetKey = utterance.targets[0]
    ? targetKey(utterance.targets[0])
    : null;
  for (const target of utterance.targets) {
    const spans = utterance.targetSpans.filter(
      (span) => targetKey(span) === targetKey(target),
    );
    const start = spans.at(0)?.start ?? 0;
    const end = spans.at(-1)?.end ?? start;
    const text = targetText(utterance.sessionId, target);
    if (estimate.cutoff >= end && end > start) {
      setTargetSpeech(utterance.sessionId, target, { status: "spoken" });
      continue;
    }
    if (estimate.cutoff <= start) {
      if (targetKey(target) === firstTargetKey) {
        setTargetSpeech(utterance.sessionId, target, {
          status: "interrupted",
          spokenText: "",
          unspokenText: text,
          confidence: estimate.confidence,
        });
        continue;
      }
      setTargetSpeech(utterance.sessionId, target, { status: "notSpoken" });
      continue;
    }
    const localCutoff = Math.max(
      0,
      Math.min(text.length, estimate.cutoff - start),
    );
    setTargetSpeech(utterance.sessionId, target, {
      status: "interrupted",
      spokenText: text.slice(0, localCutoff),
      unspokenText: text.slice(localCutoff),
      confidence: estimate.confidence,
    });
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
  setUtteranceStatus(utterance, "failed");
  recordPlaybackNotice(
    utterance.sessionId,
    utterance.id,
    utterance.text,
    "failed",
  );
  useVoiceConversationStore.getState().setUiState("listening");
  activeUtterance = null;
  reportAssistantActivity(utterance.sessionId, utterance.voiceRevision, false);
  onFailure(utterance.text, error);
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
      setUtteranceStatus(utterance, "speaking");
      voice.setUiState("agent-speaking");
      reportAssistantActivity(
        utterance.sessionId,
        utterance.voiceRevision,
        true,
      );
      break;
    case "completed":
      setUtteranceStatus(utterance, "spoken");
      voice.setUiState("listening");
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
      const estimate = estimateSpeechDelivery(
        utterance.text,
        utterance.latestDelivery,
      );
      applyInterruptionEstimate(utterance, estimate);
      utterance.onInterrupted();
      recordPlaybackNotice(
        utterance.sessionId,
        utterance.id,
        utterance.text,
        "interrupted",
        estimate,
      );
      voice.setUiState("listening");
      activeUtterance = null;
      reportAssistantActivity(
        utterance.sessionId,
        utterance.voiceRevision,
        false,
      );
      utterance.onTerminal();
      break;
    }
    case "failed":
      setUtteranceStatus(utterance, "failed");
      recordPlaybackNotice(
        utterance.sessionId,
        utterance.id,
        utterance.text,
        "failed",
      );
      voice.setUiState("listening");
      activeUtterance = null;
      reportAssistantActivity(
        utterance.sessionId,
        utterance.voiceRevision,
        false,
      );
      utterance.onFailure(
        utterance.text,
        event.error ?? new Error("Pocket voice stream failed"),
      );
      utterance.onTerminal();
      break;
  }
}

function interruptActiveUtterance(): boolean {
  const utterance = activeUtterance;
  commandEpoch += 1;
  activeUtterance = null;
  if (utterance) {
    const estimate = estimateSpeechDelivery(
      utterance.text,
      utterance.latestDelivery,
    );
    applyInterruptionEstimate(utterance, estimate);
    utterance.onInterrupted();
    recordPlaybackNotice(
      utterance.sessionId,
      utterance.id,
      utterance.text,
      "interrupted",
      estimate,
    );
    reportAssistantActivity(
      utterance.sessionId,
      utterance.voiceRevision,
      false,
    );
    utterance.onTerminal();
  }
  void stopActiveVoice().catch(() => undefined);
  commandQueue = commandQueue.then(async () => {
    await stopActiveVoice().catch(() => undefined);
  });
  return utterance !== null;
}

export function stopNativeAssistantSpeech(): void {
  generation += 1;
  const interruptedUtterance = interruptActiveUtterance();
  if (
    !interruptedUtterance &&
    activeSpeechSessionId &&
    activeSpeechRevision !== null
  ) {
    reportAssistantActivity(activeSpeechSessionId, activeSpeechRevision, false);
  }
  stopSubscription?.();
  stopSubscription = null;
  stopVoiceSubscription?.();
  stopVoiceSubscription = null;
  stopStreamSubscription?.();
  stopStreamSubscription = null;
  activeSpeechSessionId = null;
  activeSpeechRevision = null;
}

export function startNativeAssistantSpeech(
  sessionId: string,
  onFailure: SpeechFailureHandler,
): void {
  if (activeSpeechSessionId === sessionId) return;
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

  const initialMessages =
    useChatStore.getState().messagesBySession[sessionId] ?? [];
  const toolCountByMessage = new Map<string, number>();
  const consumedTextBySlot = new Map<string, string>();
  const completedMessages = new Set<string>();
  const interruptedMessages = new Set<string>();
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
    const utterance: ActiveUtterance = {
      id: crypto.randomUUID(),
      sessionId,
      voiceRevision:
        activeSpeechRevision ??
        useVoiceConversationStore.getState().status.revision,
      targets: [target],
      targetSpans: [],
      text: "",
      finishing: false,
      latestDelivery: null,
      status: null,
      onFailure,
      onInterrupted: () => {
        for (const utteranceTarget of utterance.targets) {
          interruptedMessages.add(utteranceTarget.messageId);
        }
      },
      onTerminal: () => queueMicrotask(inspect),
    };
    activeUtterance = utterance;
    queueStreamCommand(
      utterance,
      async () => {
        await streamListenerReady;
        await streamBackend.start(utterance.id);
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
        const delta = content.text.startsWith(previous)
          ? content.text.slice(previous.length)
          : content.text;
        consumedTextBySlot.set(slot, content.text);
        if (!delta) continue;

        if (interruptedMessages.has(message.id)) {
          const currentSpeech = content.speech;
          if (
            currentSpeech?.status === "interrupted" &&
            currentSpeech.spokenText !== undefined
          ) {
            setTargetSpeech(sessionId, target, {
              ...currentSpeech,
              unspokenText: content.text.slice(currentSpeech.spokenText.length),
            });
          } else {
            setTargetSpeech(sessionId, target, { status: "notSpoken" });
          }
          recordPlaybackNotice(sessionId, slot, content.text, "notSpoken");
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
        stopNativeAssistantSpeech();
      }
      return;
    }
    reachedRunning = true;
    activeSpeechRevision = voice.status.revision;
    inspect();
    const becameUserSpeaking = voice.userSpeaking && !wasUserSpeaking;
    wasUserSpeaking = voice.userSpeaking;
    if (!becameUserSpeaking || activeGeneration !== generation) return;
    interruptActiveUtterance();
  });
  queueMicrotask(inspect);
}
