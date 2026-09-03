import type { Message } from "@/shared/types/messages";
import { getTextContent } from "@/shared/types/messages";

const MANUAL_COMPACT_TRIGGER = "/compact";
const ALTERNATE_COMPACT_TRIGGERS = new Set(["/summarize"]);
const TTS_DELIVERY_FAILURE_PREFIX = "[voice: tts-delivery-failed]\n";
const TTS_DELIVERY_FAILURE_SUFFIX =
  "This is TTS delivery state, not live user voice input. Do not respond to this control message or repeat the reply unless re-delivery is still appropriate.";
const TTS_DELIVERY_FAILURE_OUTCOMES = new Set([
  "TTS delivery was interrupted because the user started speaking; the assistant reply was not fully spoken.",
  "TTS delivery was blocked because the user was speaking; the assistant reply was not spoken.",
  "Native TTS could not deliver the assistant reply.",
]);
const VOICE_TRANSCRIPT_BOUNDARY =
  /\n(?=\[(?:Voice transcript(?:; cursor \d+)?|Handoff handoff-[A-Za-z0-9-]+ from spokesperson; cursor \d+)\] )/;
const USER_TRANSCRIPT =
  /^\[Voice transcript(?:; cursor \d+)?\] User said: ([\s\S]*)$/;
const SPOKESPERSON_TRANSCRIPT =
  /^\[Voice transcript(?:; cursor \d+)?\] Spokesperson said( \(interrupted; best-effort transcript\))?: ([\s\S]*)$/;
const SPOKESPERSON_DIRECT_MESSAGE =
  /^\[Handoff handoff-[A-Za-z0-9-]+ from spokesperson; cursor \d+\] ([\s\S]*)$/;

function visibleTextAfterTtsDeliveryNotices(text: string): string | null {
  if (!text.startsWith(TTS_DELIVERY_FAILURE_PREFIX)) {
    return null;
  }

  let noticeStart = 0;
  while (text.startsWith(TTS_DELIVERY_FAILURE_PREFIX, noticeStart)) {
    const outcomeStart = noticeStart + TTS_DELIVERY_FAILURE_PREFIX.length;
    const outcomeEnd = text.indexOf("\n", outcomeStart);
    if (
      outcomeEnd === -1 ||
      !TTS_DELIVERY_FAILURE_OUTCOMES.has(
        text.slice(outcomeStart, outcomeEnd),
      ) ||
      !text.startsWith("\nOriginal text: ", outcomeEnd)
    ) {
      return null;
    }

    let suffixStart = text.indexOf(
      `\n${TTS_DELIVERY_FAILURE_SUFFIX}`,
      outcomeEnd + "\nOriginal text: ".length,
    );
    while (suffixStart !== -1) {
      const suffixEnd = suffixStart + 1 + TTS_DELIVERY_FAILURE_SUFFIX.length;
      if (text.startsWith(`\n${TTS_DELIVERY_FAILURE_PREFIX}`, suffixEnd)) {
        noticeStart = suffixEnd + 1;
        break;
      }
      if (text.startsWith("\n\n", suffixEnd)) {
        return text.slice(suffixEnd + 2);
      }
      if (suffixEnd === text.length) {
        return "";
      }
      suffixStart = text.indexOf(`\n${TTS_DELIVERY_FAILURE_SUFFIX}`, suffixEnd);
    }
    if (suffixStart === -1) {
      return null;
    }
  }

  return null;
}

function sanitizeTtsDeliveryReplayArtifact(message: Message): Message | null {
  if (
    message.role !== "user" ||
    message.metadata?.origin !== "voice_conversation" ||
    message.content.some((content) => content.type !== "text")
  ) {
    return message;
  }

  const visibleText = visibleTextAfterTtsDeliveryNotices(
    getTextContent(message),
  );
  if (visibleText === null) {
    return message;
  }
  if (!visibleText.trim()) {
    return null;
  }

  return {
    ...message,
    content: [{ type: "text", text: visibleText }],
  };
}

function restoreRealtimeVoiceMessages(message: Message): Message[] | null {
  if (
    message.role !== "user" ||
    message.metadata?.origin !== "voice_conversation" ||
    message.content.some((content) => content.type !== "text")
  ) {
    return null;
  }

  const segments = getTextContent(message).split(VOICE_TRANSCRIPT_BOUNDARY);
  const restored: Message[] = [];
  for (const [index, segment] of segments.entries()) {
    const user = USER_TRANSCRIPT.exec(segment);
    const spokesperson = SPOKESPERSON_TRANSCRIPT.exec(segment);
    const direct = SPOKESPERSON_DIRECT_MESSAGE.exec(segment);
    if (!user && !spokesperson && !direct) return null;

    const id = index === 0 ? message.id : `${message.id}:voice:${index}`;
    if (user) {
      restored.push({
        ...message,
        id,
        role: "user",
        content: [{ type: "text", text: user[1] }],
        metadata: {
          ...message.metadata,
          userVisible: true,
          agentVisible: false,
          completionStatus: "completed",
        },
      });
      continue;
    }

    if (spokesperson) {
      const interrupted = Boolean(spokesperson[1]);
      restored.push({
        ...message,
        id,
        role: "assistant",
        content: [
          {
            type: "text",
            text: spokesperson[2],
            speech: interrupted
              ? { status: "interrupted", confidence: "low" }
              : { status: "spoken", spokenThrough: spokesperson[2].length },
          },
        ],
        metadata: {
          ...message.metadata,
          userVisible: true,
          agentVisible: false,
          voiceConversationDebugEvent: "emissarySpeech",
          completionStatus: "completed",
        },
      });
      continue;
    }

    restored.push({
      ...message,
      id,
      role: "assistant",
      content: [{ type: "text", text: direct?.[1] ?? "" }],
      metadata: {
        ...message.metadata,
        userVisible: true,
        agentVisible: false,
        personaName: "Spokesperson → Expert",
        voiceConversationDebugEvent: "emissaryToMaster",
        completionStatus: "completed",
      },
    });
  }
  return restored;
}

export function isManualCompactReplayArtifact(message: Message): boolean {
  if (message.role !== "user") {
    return false;
  }

  const rawText = getTextContent(message).trim();
  if (!rawText) {
    return false;
  }

  const normalizedText = rawText.replace(/\s+/g, " ").trim().toLowerCase();
  if (ALTERNATE_COMPACT_TRIGGERS.has(normalizedText)) {
    return true;
  }

  const collapsedText = normalizedText.replace(/\s+/g, "");
  return (
    collapsedText.length > 0 &&
    collapsedText.replaceAll(MANUAL_COMPACT_TRIGGER, "").length === 0
  );
}

export function sanitizeReplayMessages(messages: Message[]): Message[] {
  return messages.flatMap((message) => {
    const sanitized = sanitizeTtsDeliveryReplayArtifact(message);
    if (!sanitized || isManualCompactReplayArtifact(sanitized)) return [];
    return restoreRealtimeVoiceMessages(sanitized) ?? [sanitized];
  });
}
