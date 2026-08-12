import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import type { FeedbackAttachmentFileInput } from "@/shared/api/feedback";
import { inspectAttachmentPaths } from "@/shared/api/system";
import { getImageFilesFromClipboardItems } from "@/shared/lib/clipboardAttachments";
import { normalizeDialogSelection } from "@/shared/lib/dialogSelection";
import { getPlatform } from "@/shared/lib/platform";

export const MAX_FEEDBACK_IMAGES = 5;

const MAX_BROWSER_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
];

export interface FeedbackImageAttachment {
  id: string;
  name: string;
  previewUrl: string;
  path?: string;
  mimeType?: string;
  base64?: string;
}

interface UseFeedbackImageAttachmentsOptions {
  disabled: boolean;
  setError: (error: string | null) => void;
}

export function useFeedbackImageAttachments({
  disabled,
  setError,
}: UseFeedbackImageAttachmentsOptions) {
  const { t } = useTranslation("feedback");
  const [attachments, setAttachments] = useState<FeedbackImageAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  useEffect(
    () => () => {
      revokeFeedbackAttachmentPreviews(attachmentsRef.current);
    },
    [],
  );

  const clearAttachments = useCallback(() => {
    setAttachments((previous) => {
      revokeFeedbackAttachmentPreviews(previous);
      attachmentsRef.current = [];
      return [];
    });
  }, []);

  const appendAttachments = useCallback(
    (incoming: FeedbackImageAttachment[]) => {
      if (incoming.length === 0) {
        return;
      }

      const previous = attachmentsRef.current;
      const seenPaths = new Set(
        previous
          .map((attachment) => attachmentPathKey(attachment.path))
          .filter((path): path is string => Boolean(path)),
      );
      const accepted: FeedbackImageAttachment[] = [];
      let hitLimit = false;

      for (const attachment of incoming) {
        const pathKey = attachmentPathKey(attachment.path);
        if (pathKey && seenPaths.has(pathKey)) {
          revokeFeedbackAttachmentPreview(attachment);
          continue;
        }
        if (previous.length + accepted.length >= MAX_FEEDBACK_IMAGES) {
          revokeFeedbackAttachmentPreview(attachment);
          hitLimit = true;
          continue;
        }
        if (pathKey) {
          seenPaths.add(pathKey);
        }
        accepted.push(attachment);
      }

      if (accepted.length > 0) {
        const nextAttachments = [...previous, ...accepted];
        attachmentsRef.current = nextAttachments;
        setAttachments(nextAttachments);
      }
      if (hitLimit) {
        setError(
          t("dialog.attachmentLimitError", { count: MAX_FEEDBACK_IMAGES }),
        );
      }
    },
    [setError, t],
  );

  const addBrowserImageAttachments = useCallback(
    async (files: File[]) => {
      const settled = await Promise.allSettled(
        files.map((file, index) =>
          createFeedbackAttachmentFromFile(file, index),
        ),
      );
      const imageAttachments = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );

      setError(
        imageAttachments.length < files.length
          ? t("dialog.imageReadError")
          : null,
      );
      appendAttachments(imageAttachments);
    },
    [appendAttachments, setError, t],
  );

  const handlePasteImages = useCallback(
    (event: React.ClipboardEvent) => {
      if (disabled) {
        return;
      }

      const files = getImageFilesFromClipboardItems(event.clipboardData.items);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      void addBrowserImageAttachments(files);
    },
    [addBrowserImageAttachments, disabled],
  );

  const handleAddImages = useCallback(async () => {
    if (disabled || attachmentsRef.current.length >= MAX_FEEDBACK_IMAGES) {
      return;
    }

    try {
      const selected = await openDialog({
        title: t("dialog.attachmentsPickerTitle"),
        multiple: true,
        filters: [
          {
            name: t("dialog.imageFilesFilter"),
            extensions: IMAGE_EXTENSIONS,
          },
        ],
      });
      const paths = normalizeDialogSelection(selected);
      if (paths.length === 0) {
        return;
      }

      const inspectedPaths = await inspectAttachmentPaths(paths);
      const imageAttachments = inspectedPaths
        .filter(
          (attachment) =>
            attachment.kind === "file" &&
            attachment.mimeType?.startsWith("image/"),
        )
        .map(
          (attachment): FeedbackImageAttachment => ({
            id: crypto.randomUUID(),
            name: attachment.name,
            path: attachment.path,
            mimeType: attachment.mimeType ?? undefined,
            previewUrl: pathToPreviewUrl(attachment.path),
          }),
        );

      setError(
        imageAttachments.length < inspectedPaths.length
          ? t("dialog.imageOnlyError")
          : null,
      );
      appendAttachments(imageAttachments);
    } catch {
      setError(t("dialog.imageReadError"));
    }
  }, [appendAttachments, disabled, setError, t]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((previous) => {
      const found = previous.find((attachment) => attachment.id === id);
      if (found) {
        revokeFeedbackAttachmentPreview(found);
      }
      const nextAttachments = previous.filter(
        (attachment) => attachment.id !== id,
      );
      attachmentsRef.current = nextAttachments;
      return nextAttachments;
    });
  }, []);

  const attachmentPaths = useMemo(
    () =>
      attachments.flatMap((attachment) =>
        attachment.path ? [attachment.path] : [],
      ),
    [attachments],
  );
  const attachmentFiles = useMemo(
    () =>
      attachments.flatMap((attachment): FeedbackAttachmentFileInput[] =>
        attachment.base64
          ? [
              {
                name: attachment.name,
                mimeType: attachment.mimeType ?? "image/png",
                base64: attachment.base64,
              },
            ]
          : [],
      ),
    [attachments],
  );

  return {
    attachments,
    attachmentFiles,
    attachmentPaths,
    canAddImages: attachments.length < MAX_FEEDBACK_IMAGES && !disabled,
    clearAttachments,
    handleAddImages,
    handlePasteImages,
    removeAttachment,
  };
}

async function createFeedbackAttachmentFromFile(
  file: File,
  index: number,
): Promise<FeedbackImageAttachment> {
  if (file.size > MAX_BROWSER_IMAGE_BYTES) {
    throw new Error("Image attachment is too large");
  }

  const previewUrl = URL.createObjectURL(file);
  try {
    return {
      id: crypto.randomUUID(),
      name: pastedImageName(file, index),
      mimeType: file.type || "image/png",
      base64: await readFileAsBase64(file),
      previewUrl,
    };
  } catch (error) {
    URL.revokeObjectURL(previewUrl);
    throw error;
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const [, base64 = ""] = dataUrl.split(",");
      if (base64.length === 0) {
        reject(new Error("Failed to read image"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function pastedImageName(file: File, index: number): string {
  if (file.name && index === 0) {
    return file.name;
  }

  if (file.name) {
    const dotIndex = file.name.lastIndexOf(".");
    if (dotIndex > 0) {
      return `${file.name.slice(0, dotIndex)}-${index + 1}${file.name.slice(dotIndex)}`;
    }
    return `${file.name}-${index + 1}`;
  }

  const extension = file.type.split("/")[1]?.split(";")[0] || "png";
  return `pasted-image-${index + 1}.${extension}`;
}

function pathToPreviewUrl(path: string): string {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__
    ? convertFileSrc(path)
    : path;
}

function attachmentPathKey(path?: string): string | null {
  if (!path) {
    return null;
  }

  return getPlatform() === "linux" ? path : path.toLowerCase();
}

function revokeFeedbackAttachmentPreviews(
  attachments: FeedbackImageAttachment[],
) {
  for (const attachment of attachments) {
    revokeFeedbackAttachmentPreview(attachment);
  }
}

function revokeFeedbackAttachmentPreview(attachment: FeedbackImageAttachment) {
  if (attachment.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}
