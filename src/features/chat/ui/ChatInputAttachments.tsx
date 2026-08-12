import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { IconFileText } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ImageLightbox } from "@/shared/ui/ImageLightbox";
import type {
  ChatAttachmentDraft,
  ChatDirectoryAttachmentDraft,
  ChatFileAttachmentDraft,
  ChatImageAttachmentDraft,
} from "@/shared/types/messages";
import { ComposerChip } from "./ComposerChip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

function DraftImageAttachment({
  attachment,
  attachmentIndex,
  onOpen,
  onRemove,
}: {
  attachment: ChatImageAttachmentDraft;
  attachmentIndex: number;
  onOpen: () => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation("chat");

  return (
    <div className="group relative inline-block">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            className="block cursor-pointer rounded-sm"
            aria-label={t("attachments.view", { index: attachmentIndex + 1 })}
          >
            <img
              src={attachment.previewUrl}
              alt={t("attachments.alt", { index: attachmentIndex + 1 })}
              className="h-16 w-16 rounded-sm border border-border/80 object-cover"
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>{attachment.path ?? attachment.name}</TooltipContent>
      </Tooltip>
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("attachments.remove")}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

function DraftPathAttachment({
  attachment,
  onRemove,
}: {
  attachment: ChatFileAttachmentDraft | ChatDirectoryAttachmentDraft;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation("chat");

  return (
    <ComposerChip
      tone="file"
      label={attachment.name}
      leading={<IconFileText className="size-3.5" />}
      title={attachment.path ?? attachment.name}
      onRemove={() => onRemove(attachment.id)}
      removeLabel={t("attachments.remove")}
    />
  );
}

export function ChatInputAttachments({
  attachments,
  onRemove,
}: {
  attachments: ChatAttachmentDraft[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [lightboxImageIndex, setLightboxImageIndex] = useState<number | null>(
    null,
  );
  const imageAttachments = attachments.flatMap((attachment, attachmentIndex) =>
    attachment.kind === "image" ? [{ attachment, attachmentIndex }] : [],
  );
  const currentLightboxImage =
    lightboxImageIndex === null
      ? null
      : (imageAttachments[lightboxImageIndex] ?? null);

  useEffect(() => {
    if (lightboxImageIndex === null) return;
    if (imageAttachments.length === 0) {
      setLightboxImageIndex(null);
      return;
    }
    if (lightboxImageIndex >= imageAttachments.length) {
      setLightboxImageIndex(imageAttachments.length - 1);
    }
  }, [imageAttachments.length, lightboxImageIndex]);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {attachments.map((attachment, attachmentIndex) =>
          attachment.kind === "image" ? (
            <DraftImageAttachment
              key={attachment.id}
              attachment={attachment}
              attachmentIndex={attachmentIndex}
              onOpen={() => {
                const imageIndex = imageAttachments.findIndex(
                  (imageAttachment) =>
                    imageAttachment.attachment.id === attachment.id,
                );
                setLightboxImageIndex(imageIndex >= 0 ? imageIndex : null);
              }}
              onRemove={onRemove}
            />
          ) : (
            <DraftPathAttachment
              key={attachment.id}
              attachment={attachment}
              onRemove={onRemove}
            />
          ),
        )}
      </div>
      <ImageLightbox
        src={currentLightboxImage?.attachment.previewUrl ?? ""}
        downloadFilename={currentLightboxImage?.attachment.name}
        alt={
          currentLightboxImage
            ? t("attachments.alt", {
                index: currentLightboxImage.attachmentIndex + 1,
              })
            : undefined
        }
        open={currentLightboxImage !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxImageIndex(null);
        }}
        onPrevious={
          imageAttachments.length > 1
            ? () => {
                setLightboxImageIndex((current) =>
                  current === null
                    ? current
                    : (current - 1 + imageAttachments.length) %
                      imageAttachments.length,
                );
              }
            : undefined
        }
        onNext={
          imageAttachments.length > 1
            ? () => {
                setLightboxImageIndex((current) =>
                  current === null
                    ? current
                    : (current + 1) % imageAttachments.length,
                );
              }
            : undefined
        }
      />
    </>
  );
}
