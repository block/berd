import { i18n } from "@/shared/i18n";
import type { ChatAttachmentDraft } from "@/shared/types/messages";

/**
 * Budget for inline attachment payload (base64 image data) in a single
 * prompt. The ACP WebSocket transport drops the whole connection — killing
 * every open chat — when a message overflows its frame limit (16MiB
 * tungstenite default, BOT-1463). The budget stays comfortably under that
 * so prompt text and JSON envelope overhead can never push a send over the
 * edge. Normalized images (2048px cap) are a few hundred KB each, so normal
 * use never approaches this.
 */
export const MAX_PROMPT_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/**
 * Thrown by the send cores when a prompt's inline attachments exceed the
 * budget, before any message is committed. The named class exists so logs
 * and future callers can distinguish a budget rejection from transport
 * errors; today's callers rely on the send core having already recorded
 * the failure (session error state) before it throws.
 */
export class PromptPayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptPayloadTooLargeError";
  }
}

/**
 * Single source of the user-facing budget-rejection copy. Both the composer
 * toast and the session error state must describe the same failure the same
 * way, so they both format through here.
 */
export function formatAttachmentsTooLargeMessage(
  attachmentBytes: number,
): string {
  return i18n.t("chat:errors.attachmentsTooLarge", {
    totalMb: bytesToMb(attachmentBytes),
    limitMb: bytesToMb(MAX_PROMPT_ATTACHMENT_BYTES),
  });
}

/**
 * Bytes this draft's attachments contribute to the outgoing JSON-RPC
 * message. Base64 strings are embedded verbatim, so string length is the
 * wire size.
 */
export function promptAttachmentBytes(
  attachments: ChatAttachmentDraft[] | undefined,
): number {
  let total = 0;
  for (const attachment of attachments ?? []) {
    if (attachment.kind === "image") {
      total += attachment.base64.length;
    }
  }
  return total;
}

export function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
