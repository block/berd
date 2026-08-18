import { useEffect, useState } from "react";
import { IconPhotoPlus, IconUpload } from "@tabler/icons-react";

import { useTranslation } from "react-i18next";
import type { PersonaImportPreview } from "@/shared/api/agents";
import type { SnapshotV1 } from "@/features/agents/agent-snapshot";
import { AgentShareCardPreview } from "@/features/agents/ui/share-card/AgentShareCardPreview";
import { HolographicAgentCard } from "@/features/agents/ui/share-card/HolographicAgentCard";
import { AgentCardReveal } from "@/features/agents/ui/share-card/AgentCardReveal";
import { resolveAgentShareCardCopy } from "@/features/agents/ui/share-card/agentShareCardCopy";
import {
  fallbackAgentCardColor,
  sampleAgentAvatarColor,
} from "@/features/agents/ui/share-card/agentCardColor";

import { cn } from "@/shared/lib/cn";
import { useFileImportZone } from "@/shared/hooks/useFileImportZone";
import { Button } from "@/shared/ui/button";
import { AgentImportPrimaryButton } from "@/shared/ui/agent-import-primary-button";
import { AgentImportSecondaryButton } from "@/shared/ui/agent-import-secondary-button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

export interface AgentImportPreview extends PersonaImportPreview {
  cardImageUrl?: string;
  cardAspectRatio?: number;
  snapshot?: SnapshotV1;
}

interface AgentImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportFile: (
    fileBytes: Uint8Array,
    fileName: string,
    preview?: AgentImportPreview,
  ) => void;
  prepareImport: (
    fileBytes: Uint8Array,
    fileName: string,
  ) => AgentImportPreview;
  validateImportFile: (
    file: Pick<File, "name" | "type" | "size">,
  ) => string | null;
  onImportError: (message: string) => void;
  maxImportBytes: number;
  importTooLargeMessage: string;
}

export function AgentImportDialog({
  open,
  onOpenChange,
  onImportFile,
  prepareImport,
  validateImportFile,
  onImportError,
  maxImportBytes,
  importTooLargeMessage,
}: AgentImportDialogProps) {
  const { t, i18n } = useTranslation("agents");
  const locale = i18n?.resolvedLanguage ?? i18n?.language ?? "en";
  const [importAccentColor, setImportAccentColor] = useState<string | null>(
    null,
  );
  const [prepared, setPrepared] = useState<{
    bytes: Uint8Array;
    name: string;
    preview: AgentImportPreview;
  } | null>(null);

  useEffect(() => {
    if (!open) setPrepared(null);
  }, [open]);

  useEffect(() => {
    if (!prepared?.preview.cardImageUrl) {
      setImportAccentColor(null);
      return;
    }
    const fallbackColor = fallbackAgentCardColor(prepared.preview.identity);
    setImportAccentColor(fallbackColor);
    const avatarSrc = prepared.preview.avatar;
    if (!avatarSrc) return;

    let active = true;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const sampled = sampleAgentAvatarColor(image);
      if (active && sampled) setImportAccentColor(sampled);
    };
    image.onerror = () => {
      if (active) setImportAccentColor(fallbackColor);
    };
    image.src = avatarSrc;
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [prepared]);

  useEffect(
    () => () => {
      if (prepared?.preview.cardImageUrl) {
        URL.revokeObjectURL(prepared.preview.cardImageUrl);
      }
    },
    [prepared?.preview.cardImageUrl],
  );

  const {
    fileInputRef,
    isDragOver,
    dropHandlers,
    handleFileChange,
    openFilePicker,
  } = useFileImportZone({
    onImportFile: (bytes, name) => {
      try {
        const preview = prepareImport(bytes, name);
        // The cleanup effect keyed by cardImageUrl revokes the previous URL
        // exactly once when this prepared preview replaces it.
        setPrepared({ bytes, name, preview });
      } catch (error) {
        onImportError(error instanceof Error ? error.message : String(error));
      }
    },
    validateFile: validateImportFile,
    onImportError,
    maxBytes: maxImportBytes,
    fileTooLargeMessage: importTooLargeMessage,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        surface="solid"
        className={cn(
          "bg-card",
          prepared &&
            "overflow-visible has-data-[slot=dialog-body]:overflow-visible",
        )}
      >
        <DialogHeader>
          <DialogTitle>{t("importDialog.title")}</DialogTitle>
          <DialogDescription>{t("importDialog.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className={prepared ? "overflow-visible" : undefined}>
          {prepared ? (
            <div className="relative flex justify-center py-2 [perspective:1200px]">
              <AgentCardReveal
                identity={[
                  prepared.name,
                  prepared.preview.identity,
                  prepared.preview.displayName,
                  prepared.preview.systemPrompt,
                  prepared.preview.cardImageUrl,
                ].join("\0")}
              >
                {prepared.preview.cardImageUrl ? (
                  <HolographicAgentCard
                    src={prepared.preview.cardImageUrl}
                    aspectRatio={prepared.preview.cardAspectRatio}
                    containArtwork
                    shadowColor={importAccentColor ?? undefined}
                    tintColor={importAccentColor ?? undefined}
                    frameOnly
                    alt={t("importDialog.previewAlt", {
                      name: prepared.preview.displayName,
                    })}
                  />
                ) : (
                  <AgentShareCardPreview
                    identity={prepared.preview.identity}
                    displayName={prepared.preview.displayName}
                    description={prepared.preview.systemPrompt}
                    avatarSrc={prepared.preview.avatar}
                    alt={t("importDialog.previewAlt", {
                      name: prepared.preview.displayName,
                    })}
                    copy={resolveAgentShareCardCopy(
                      prepared.preview.systemPrompt,
                      t,
                    )}
                    locale={locale}
                  />
                )}
              </AgentCardReveal>
            </div>
          ) : (
            <div
              {...dropHandlers}
              className={cn(
                "flex min-h-56 flex-col items-center justify-center gap-4 rounded-md border border-dashed border-border bg-muted/40 px-6 text-center",
                isDragOver && "border-ring bg-muted/70",
              )}
            >
              <IconPhotoPlus
                className="size-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="text-sm">{t("importDialog.dropTitle")}</p>
              <Button
                type="button"
                variant="outline"
                leftIcon={<IconUpload />}
                onClick={openFilePicker}
              >
                {t("importDialog.openFinder")}
              </Button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".agent.zip,.zip,.agent.png,.png,.persona.md,.md,.json,application/zip,application/x-zip-compressed,image/png,text/markdown,text/plain,application/json"
            className="hidden"
            onChange={handleFileChange}
          />
        </DialogBody>
        <DialogFooter>
          <AgentImportSecondaryButton
            type="button"
            onClick={() => onOpenChange(false)}
          >
            {t("common:actions.cancel")}
          </AgentImportSecondaryButton>
          {prepared ? (
            <AgentImportPrimaryButton
              type="button"
              onClick={() => {
                // Batch the close/open state updates so configuration replaces
                // the preview without a blank interval between dialogs.
                onOpenChange(false);
                onImportFile(prepared.bytes, prepared.name, prepared.preview);
              }}
            >
              {t("importDialog.import")}
            </AgentImportPrimaryButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
