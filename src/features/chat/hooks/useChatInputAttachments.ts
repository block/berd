import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  inspectAttachmentPaths,
  readImageAttachment,
} from "@/shared/api/system";
import type {
  ChatAttachmentDraft,
  ChatDirectoryAttachmentDraft,
  ChatFileAttachmentDraft,
  ChatImageAttachmentDraft,
} from "@/shared/types/messages";
import { getPlatform } from "@/shared/lib/platform";
import { normalizeImageBase64, resizeImage } from "../lib/resizeImage";

function isBlobPreview(url: string) {
  return url.startsWith("blob:");
}

function revokeAttachmentPreview(attachment: ChatAttachmentDraft) {
  if (attachment.kind === "image" && isBlobPreview(attachment.previewUrl)) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

function pathToPreviewUrl(path: string) {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__
    ? convertFileSrc(path)
    : path;
}

function attachmentPathKey(path?: string) {
  if (!path) {
    return null;
  }

  return getPlatform() === "linux" ? path : path.toLowerCase();
}

async function createImageAttachmentFromFile(
  file: File,
): Promise<ChatImageAttachmentDraft> {
  const previewUrl = URL.createObjectURL(file);

  try {
    // Every image goes through the normalize pipeline; there is no raw
    // pass-through fallback. An image the browser cannot decode cannot be
    // resized or validated, so sending its bytes anyway would ship an
    // unsupported payload that fails the whole request at the provider
    // (BOT-1463). Rejection drops the file from the draft instead.
    const { base64, mimeType } = await resizeImage(file);

    return {
      id: crypto.randomUUID(),
      kind: "image",
      name: file.name,
      mimeType,
      base64,
      previewUrl,
    };
  } catch (error) {
    URL.revokeObjectURL(previewUrl);
    throw error;
  }
}

export function useChatInputAttachments(
  initialAttachments: ChatAttachmentDraft[] = [],
) {
  const [attachments, setAttachments] = useState<ChatAttachmentDraft[]>(() => [
    ...initialAttachments,
  ]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) {
        revokeAttachmentPreview(attachment);
      }
    },
    [],
  );

  const appendAttachments = useCallback((incoming: ChatAttachmentDraft[]) => {
    if (incoming.length === 0) {
      return;
    }

    setAttachments((previous) => {
      const seenPaths = new Set(
        previous
          .map((attachment) => attachmentPathKey(attachment.path))
          .filter((value): value is string => Boolean(value)),
      );
      const next = [...previous];

      for (const attachment of incoming) {
        const pathKey = attachmentPathKey(attachment.path);
        if (pathKey && seenPaths.has(pathKey)) {
          revokeAttachmentPreview(attachment);
          continue;
        }

        if (pathKey) {
          seenPaths.add(pathKey);
        }
        next.push(attachment);
      }

      return next;
    });
  }, []);

  const addBrowserFiles = useCallback(
    async (files: File[]) => {
      const nextAttachments = (
        await Promise.allSettled(
          files.map(async (file) => {
            if (file.type.startsWith("image/")) {
              return createImageAttachmentFromFile(file);
            }

            return {
              id: crypto.randomUUID(),
              kind: "file",
              name: file.name,
              ...(file.type ? { mimeType: file.type } : {}),
            } satisfies ChatFileAttachmentDraft;
          }),
        )
      ).flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );

      appendAttachments(nextAttachments);
    },
    [appendAttachments],
  );

  const addPathAttachments = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        return;
      }

      const inspectedPaths = await inspectAttachmentPaths(paths);
      const nextAttachments = await Promise.all(
        inspectedPaths.map(async (attachmentPath) => {
          if (attachmentPath.kind === "directory") {
            return {
              id: crypto.randomUUID(),
              kind: "directory",
              name: attachmentPath.name,
              path: attachmentPath.path,
            } satisfies ChatDirectoryAttachmentDraft;
          }

          if (attachmentPath.mimeType?.startsWith("image/")) {
            try {
              const image = await readImageAttachment(attachmentPath.path);
              // Picker and drag-drop images go through the same normalize
              // pipeline as pasted images: full-size photos are downscaled
              // (a handful of raw phone JPEGs overflows the ACP transport,
              // BOT-1463) and non-whitelisted formats (HEIC/TIFF/...) are
              // re-encoded to types the providers accept.
              const normalized = await normalizeImageBase64(
                image.base64,
                image.mimeType,
              );
              return {
                id: crypto.randomUUID(),
                kind: "image",
                name: attachmentPath.name,
                path: attachmentPath.path,
                mimeType: normalized.mimeType,
                base64: normalized.base64,
                previewUrl: pathToPreviewUrl(attachmentPath.path),
              } satisfies ChatImageAttachmentDraft;
            } catch {
              // Fall back to a generic file attachment if image loading or
              // normalization fails: the path still reaches the agent via
              // appendAttachmentPaths, so backends that can read local files
              // keep working; we just never ship undecodable image bytes.
            }
          }

          return {
            id: crypto.randomUUID(),
            kind: "file",
            name: attachmentPath.name,
            path: attachmentPath.path,
            ...(attachmentPath.mimeType
              ? { mimeType: attachmentPath.mimeType }
              : {}),
          } satisfies ChatFileAttachmentDraft;
        }),
      );

      appendAttachments(nextAttachments);
    },
    [appendAttachments],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((previous) => {
      const found = previous.find((attachment) => attachment.id === id);
      if (found) {
        revokeAttachmentPreview(found);
      }
      return previous.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const replaceAttachments = useCallback(
    (nextAttachments: ChatAttachmentDraft[]) => {
      setAttachments((previous) => {
        const retainedIds = new Set(
          nextAttachments.map((attachment) => attachment.id),
        );
        for (const attachment of previous) {
          if (!retainedIds.has(attachment.id)) {
            revokeAttachmentPreview(attachment);
          }
        }
        return [...nextAttachments];
      });
    },
    [],
  );

  const clearAttachments = useCallback(() => {
    setAttachments((previous) => {
      for (const attachment of previous) {
        revokeAttachmentPreview(attachment);
      }
      return [];
    });
  }, []);

  return {
    attachments,
    addBrowserFiles,
    addPathAttachments,
    removeAttachment,
    replaceAttachments,
    clearAttachments,
  };
}
