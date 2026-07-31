import { useChatStore } from "@/features/chat/stores/chatStore";
import { speakPocketVoice, stopPocketVoice } from "../api/pocketVoice";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";

type SpeechFailureHandler = (text: string, error: unknown) => void;
type SpeakableSegment = {
  key: string;
  messageId: string;
  contentIndex: number;
  text: string;
  sourceText: string;
};

let stopSubscription: (() => void) | null = null;
let stopVoiceSubscription: (() => void) | null = null;
let playbackQueue = Promise.resolve();
let generation = 0;
let speechEpoch = 0;
let activeSpeechSessionId: string | null = null;
const scheduledSegments = new Map<string, SpeakableSegment>();
const pendingNotices = new Map<string, string[]>();
const recordedNoticeKeys = new Set<string>();

function recordPlaybackNotice(
  sessionId: string,
  segment: SpeakableSegment,
  status: "interrupted" | "notSpoken" | "failed",
) {
  const key = `${sessionId}\0${segment.key}\0${status}`;
  if (recordedNoticeKeys.has(key)) return;
  recordedNoticeKeys.add(key);
  const text =
    segment.text.length > 500
      ? `${segment.text.slice(0, 497).trimEnd()}…`
      : segment.text;
  const outcome =
    status === "interrupted"
      ? "TTS delivery was interrupted because the user started speaking; the assistant reply was not fully spoken."
      : status === "notSpoken"
        ? "TTS delivery was blocked because the user was speaking; the assistant reply was not spoken."
        : "Native TTS could not deliver the assistant reply.";
  const notice =
    `[voice: tts-delivery-failed]\n${outcome}\nOriginal text: ${text}\n` +
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

function setSegmentStatus(
  sessionId: string,
  segment: SpeakableSegment,
  status: "speaking" | "spoken" | "interrupted" | "notSpoken" | "failed",
) {
  useChatStore
    .getState()
    .updateMessage(sessionId, segment.messageId, (message) => ({
      ...message,
      content: message.content.map((content, index) =>
        index === segment.contentIndex &&
        content.type === "text" &&
        content.text.trim() === segment.sourceText
          ? { ...content, speech: { status } }
          : content,
      ),
    }));
}

export function stopNativeAssistantSpeech(): void {
  if (activeSpeechSessionId) {
    for (const segment of scheduledSegments.values()) {
      setSegmentStatus(activeSpeechSessionId, segment, "interrupted");
      recordPlaybackNotice(activeSpeechSessionId, segment, "interrupted");
    }
  }
  generation += 1;
  speechEpoch += 1;
  stopSubscription?.();
  stopSubscription = null;
  stopVoiceSubscription?.();
  stopVoiceSubscription = null;
  scheduledSegments.clear();
  activeSpeechSessionId = null;
  void stopPocketVoice().catch(() => {
    // Stopping an inactive or unavailable native player is best-effort during
    // lifecycle teardown.
  });
}

export function startNativeAssistantSpeech(
  sessionId: string,
  onFailure: SpeechFailureHandler,
): void {
  if (activeSpeechSessionId === sessionId) return;
  stopNativeAssistantSpeech();
  activeSpeechSessionId = sessionId;
  const activeGeneration = generation;
  const initialMessages =
    useChatStore.getState().messagesBySession[sessionId] ?? [];
  const toolCountByMessage = new Map<string, number>();
  const spokenTextBySlot = new Map<string, string>();
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
    message.content.forEach((content) => {
      if (content.type === "text") {
        spokenTextBySlot.set(
          `${message.id}\0text:${textOrdinal}`,
          content.text.trim(),
        );
        textOrdinal += 1;
      }
    });
  }

  const inspectNow = () => {
    if (activeGeneration !== generation) return;
    const voice = useVoiceConversationStore.getState();
    if (
      voice.status.lifecycle !== "running" ||
      voice.status.sessionId !== sessionId
    ) {
      return;
    }
    const segments: SpeakableSegment[] = [];
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
      const completed =
        message.metadata?.completionStatus === "completed" &&
        !completedMessages.has(message.id);
      const crossedToolBoundary = toolCount > priorToolCount;
      toolCountByMessage.set(message.id, toolCount);
      if (completed) completedMessages.add(message.id);
      if (!crossedToolBoundary && !completed) continue;

      let textOrdinal = 0;
      message.content.forEach((content, contentIndex) => {
        if (content.type !== "text") return;
        const sourceText = content.text.trim();
        const slot = `${message.id}\0text:${textOrdinal}`;
        textOrdinal += 1;
        if (!sourceText) return;
        const spokenText = spokenTextBySlot.get(slot) ?? "";
        if (sourceText === spokenText) return;
        const text = sourceText.startsWith(spokenText)
          ? sourceText.slice(spokenText.length).trim()
          : sourceText;
        spokenTextBySlot.set(slot, sourceText);
        if (!text) return;
        segments.push({
          key: `${slot}\0${spokenText.length}\0${sourceText.length}`,
          messageId: message.id,
          contentIndex,
          text,
          sourceText,
        });
      });
    }
    for (const segment of segments) {
      if (voice.userSpeaking) {
        setSegmentStatus(sessionId, segment, "notSpoken");
        recordPlaybackNotice(sessionId, segment, "notSpoken");
        continue;
      }
      const segmentEpoch = speechEpoch;
      scheduledSegments.set(segment.key, segment);
      playbackQueue = playbackQueue.then(async () => {
        if (
          activeGeneration !== generation ||
          segmentEpoch !== speechEpoch ||
          !scheduledSegments.has(segment.key)
        ) {
          return;
        }
        const current = useVoiceConversationStore.getState();
        if (current.userSpeaking) {
          setSegmentStatus(sessionId, segment, "notSpoken");
          recordPlaybackNotice(sessionId, segment, "notSpoken");
          scheduledSegments.delete(segment.key);
          return;
        }
        setSegmentStatus(sessionId, segment, "speaking");
        current.setUiState("agent-speaking");
        try {
          await speakPocketVoice(segment.text);
          if (activeGeneration === generation && segmentEpoch === speechEpoch) {
            setSegmentStatus(sessionId, segment, "spoken");
          }
        } catch (error) {
          if (activeGeneration === generation && segmentEpoch === speechEpoch) {
            setSegmentStatus(sessionId, segment, "failed");
            recordPlaybackNotice(sessionId, segment, "failed");
            onFailure(segment.text, error);
          }
        } finally {
          scheduledSegments.delete(segment.key);
          if (activeGeneration === generation) {
            useVoiceConversationStore.getState().setUiState("listening");
          }
        }
      });
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
  let wasUserSpeaking = useVoiceConversationStore.getState().userSpeaking;
  stopVoiceSubscription = useVoiceConversationStore.subscribe((voice) => {
    if (
      voice.status.lifecycle !== "running" ||
      voice.status.sessionId !== sessionId
    ) {
      stopNativeAssistantSpeech();
      return;
    }
    const becameUserSpeaking = voice.userSpeaking && !wasUserSpeaking;
    wasUserSpeaking = voice.userSpeaking;
    if (!becameUserSpeaking || activeGeneration !== generation) return;

    speechEpoch += 1;
    for (const segment of scheduledSegments.values()) {
      setSegmentStatus(sessionId, segment, "interrupted");
      recordPlaybackNotice(sessionId, segment, "interrupted");
    }
    scheduledSegments.clear();
    void stopPocketVoice().catch((error) => {
      console.error("Native Pocket barge-in stop failed", {
        sessionId,
        error,
      });
    });
  });
  queueMicrotask(inspect);
}
