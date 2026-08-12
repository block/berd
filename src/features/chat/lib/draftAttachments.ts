import type {
  ChatAttachmentDraft,
  ChatImageAttachmentDraft,
} from "@/shared/types/messages";

function isBlobPreviewUrl(value: string): boolean {
  return value.startsWith("blob:");
}

function makeRemountSafeImageAttachment(
  attachment: ChatImageAttachmentDraft,
): ChatImageAttachmentDraft {
  if (!isBlobPreviewUrl(attachment.previewUrl)) {
    return attachment;
  }

  return {
    ...attachment,
    previewUrl: `data:${attachment.mimeType};base64,${attachment.base64}`,
  };
}

export function makeRemountSafeDraftAttachments(
  attachments: ChatAttachmentDraft[],
): ChatAttachmentDraft[] {
  let changed = false;
  const nextAttachments = attachments.map((attachment) => {
    if (attachment.kind !== "image") {
      return attachment;
    }

    const nextAttachment = makeRemountSafeImageAttachment(attachment);
    changed ||= nextAttachment !== attachment;
    return nextAttachment;
  });

  return changed ? nextAttachments : attachments;
}

export function draftAttachmentsEqual(
  first: ChatAttachmentDraft[] | undefined,
  second: ChatAttachmentDraft[] | undefined,
): boolean {
  if (first === second) {
    return true;
  }
  if (!first || !second || first.length !== second.length) {
    return false;
  }

  return first.every((attachment, index) => {
    const other = second[index];
    if (!other || attachment.kind !== other.kind) {
      return false;
    }

    if (
      attachment.id !== other.id ||
      attachment.name !== other.name ||
      attachment.path !== other.path
    ) {
      return false;
    }

    if (attachment.kind === "image" && other.kind === "image") {
      return (
        attachment.mimeType === other.mimeType &&
        attachment.base64 === other.base64 &&
        attachment.previewUrl === other.previewUrl
      );
    }

    if (attachment.kind === "file" && other.kind === "file") {
      return attachment.mimeType === other.mimeType;
    }

    return true;
  });
}
