import type {
  ChatAttachmentDraft,
  ChatImageAttachmentDraft,
  MessageAttachment,
} from "@/shared/types/messages";

/**
 * Remote ACP backends cannot resolve paths from the local machine. Keep only
 * images whose bytes travel in the prompt, and strip their local path so it is
 * never appended to the remote prompt or persisted as agent-readable context.
 */
export function remoteSafeAttachments(
  attachments: ChatAttachmentDraft[] | undefined,
): ChatImageAttachmentDraft[] | undefined {
  const images = (attachments ?? []).flatMap((attachment) =>
    attachment.kind === "image" ? [{ ...attachment, path: undefined }] : [],
  );
  return images.length > 0 ? images : undefined;
}

export function appendAttachmentPaths(
  text: string,
  attachments: ChatAttachmentDraft[] | undefined,
): string {
  const paths = (attachments ?? [])
    .map((attachment) => attachment.path)
    .filter((path): path is string => Boolean(path));

  if (paths.length === 0) {
    return text;
  }

  const joined = paths.join(" ");
  return text ? `${text} ${joined}` : joined;
}

export function buildMessageAttachments(
  attachments: ChatAttachmentDraft[] | undefined,
): MessageAttachment[] | undefined {
  const messageAttachments: MessageAttachment[] = [];

  for (const attachment of attachments ?? []) {
    if (attachment.kind === "directory") {
      messageAttachments.push({
        type: "directory",
        name: attachment.name,
        path: attachment.path,
      });
      continue;
    }

    messageAttachments.push({
      type: "file",
      name: attachment.name,
      ...(attachment.path ? { path: attachment.path } : {}),
      ...(attachment.kind === "image" || attachment.mimeType
        ? { mimeType: attachment.mimeType }
        : {}),
    });
  }

  return messageAttachments.length > 0 ? messageAttachments : undefined;
}

export function buildAcpImages(
  attachments: ChatAttachmentDraft[] | undefined,
): { base64: string; mimeType: string }[] | undefined {
  const images = (attachments ?? []).flatMap((attachment) =>
    attachment.kind === "image"
      ? [{ base64: attachment.base64, mimeType: attachment.mimeType }]
      : [],
  );

  return images.length > 0 ? images : undefined;
}
