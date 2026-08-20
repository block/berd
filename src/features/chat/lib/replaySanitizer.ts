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
    return sanitized && !isManualCompactReplayArtifact(sanitized)
      ? [sanitized]
      : [];
  });
}
