import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  appendPocketVoiceStream,
  finishPocketVoiceStream,
  flushPocketVoiceStream,
  listenToPocketVoiceStream,
  startPocketVoiceStream,
  stopPocketVoice,
  type PocketVoiceStreamEvent,
} from "../api/pocketVoice";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";

type SpeechFailureHandler = (text: string, error: unknown) => void;
type SpeechTarget = { messageId: string; textOrdinal: number };
type ActiveUtterance = {
  id: string;
  sessionId: string;
  targets: SpeechTarget[];
  text: string;
  finishing: boolean;
  status: SpeechStatus | null;
  onFailure: SpeechFailureHandler;
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
let activeUtterance: ActiveUtterance | null = null;
const pendingNotices = new Map<string, string[]>();
const recordedNoticeKeys = new Set<string>();

function recordPlaybackNotice(
  sessionId: string,
  key: string,
  text: string,
  status: "interrupted" | "notSpoken" | "failed",
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
  const notice =
    `[voice: tts-delivery-failed]\n${outcome}\nOriginal text: ${excerpt}\n` +
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

function setTargetStatus(
  sessionId: string,
  target: SpeechTarget,
  status: SpeechStatus,
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
          return matches ? { ...content, speech: { status } } : content;
        }),
      };
    });
}

function setUtteranceStatus(utterance: ActiveUtterance, status: SpeechStatus) {
  utterance.status = status;
  for (const target of utterance.targets) {
    setTargetStatus(utterance.sessionId, target, status);
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
  onFailure(utterance.text, error);
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

function handleStreamEvent(event: PocketVoiceStreamEvent) {
  const utterance = activeUtterance;
  if (!utterance || utterance.id !== event.streamId) return;
  const voice = useVoiceConversationStore.getState();

  switch (event.state) {
    case "started":
      setUtteranceStatus(utterance, "speaking");
      voice.setUiState("agent-speaking");
      break;
    case "completed":
      setUtteranceStatus(utterance, "spoken");
      voice.setUiState("listening");
      activeUtterance = null;
      break;
    case "interrupted":
      setUtteranceStatus(utterance, "interrupted");
      recordPlaybackNotice(
        utterance.sessionId,
        utterance.id,
        utterance.text,
        "interrupted",
      );
      voice.setUiState("listening");
      activeUtterance = null;
      break;
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
      utterance.onFailure(
        utterance.text,
        event.error ?? new Error("Pocket voice stream failed"),
      );
      break;
  }
}

function interruptActiveUtterance() {
  const utterance = activeUtterance;
  commandEpoch += 1;
  activeUtterance = null;
  if (utterance) {
    setUtteranceStatus(utterance, "interrupted");
    recordPlaybackNotice(
      utterance.sessionId,
      utterance.id,
      utterance.text,
      "interrupted",
    );
  }
  void stopPocketVoice().catch(() => undefined);
  commandQueue = commandQueue.then(async () => {
    await stopPocketVoice().catch(() => undefined);
  });
}

export function stopNativeAssistantSpeech(): void {
  generation += 1;
  interruptActiveUtterance();
  stopSubscription?.();
  stopSubscription = null;
  stopVoiceSubscription?.();
  stopVoiceSubscription = null;
  stopStreamSubscription?.();
  stopStreamSubscription = null;
  activeSpeechSessionId = null;
}

export function startNativeAssistantSpeech(
  sessionId: string,
  onFailure: SpeechFailureHandler,
): void {
  if (activeSpeechSessionId === sessionId) return;
  stopNativeAssistantSpeech();
  activeSpeechSessionId = sessionId;
  const activeGeneration = generation;
  streamListenerReady = listenToPocketVoiceStream(handleStreamEvent).then(
    (unlisten) => {
      if (activeGeneration !== generation) {
        unlisten();
        return;
      }
      stopStreamSubscription = unlisten;
    },
  );

  const initialMessages =
    useChatStore.getState().messagesBySession[sessionId] ?? [];
  const toolCountByMessage = new Map<string, number>();
  const consumedTextBySlot = new Map<string, string>();
  const completedMessages = new Set<string>();
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
          setTargetStatus(sessionId, target, activeUtterance.status);
        }
      }
      return activeUtterance;
    }
    const utterance: ActiveUtterance = {
      id: crypto.randomUUID(),
      sessionId,
      targets: [target],
      text: "",
      finishing: false,
      status: null,
      onFailure,
    };
    activeUtterance = utterance;
    queueStreamCommand(
      utterance,
      async () => {
        await streamListenerReady;
        await startPocketVoiceStream(utterance.id);
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

        if (voice.userSpeaking) {
          setTargetStatus(sessionId, target, "notSpoken");
          recordPlaybackNotice(sessionId, slot, content.text, "notSpoken");
          continue;
        }

        const utterance = ensureUtterance(target);
        if (utterance.finishing) continue;
        utterance.text += delta;
        queueStreamCommand(
          utterance,
          () => appendPocketVoiceStream(utterance.id, delta),
          onFailure,
        );
      }

      const utterance = activeUtterance;
      if (crossedToolBoundary && utterance && !utterance.finishing) {
        queueStreamCommand(
          utterance,
          () => flushPocketVoiceStream(utterance.id),
          onFailure,
        );
      }
      if (completed && utterance && !utterance.finishing) {
        utterance.finishing = true;
        queueStreamCommand(
          utterance,
          () => finishPocketVoiceStream(utterance.id),
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
    inspect();
    const becameUserSpeaking = voice.userSpeaking && !wasUserSpeaking;
    wasUserSpeaking = voice.userSpeaking;
    if (!becameUserSpeaking || activeGeneration !== generation) return;
    interruptActiveUtterance();
  });
  queueMicrotask(inspect);
}
