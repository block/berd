import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  readImportAgentFile,
  type PersonaImportPreview,
} from "@/shared/api/agents";
import type { SnapshotV1 } from "@/features/agents/agent-snapshot";
import { AgentShareCardPreview } from "@/features/agents/ui/share-card/AgentShareCardPreview";
import { HolographicAgentCard } from "@/features/agents/ui/share-card/HolographicAgentCard";
import { AgentCardReveal } from "@/features/agents/ui/share-card/AgentCardReveal";
import {
  fallbackAgentCardColor,
  sampleAgentAvatarColor,
} from "@/features/agents/ui/share-card/agentCardColor";

import { cn } from "@/shared/lib/cn";
import { useFileImportZone } from "@/shared/hooks/useFileImportZone";
import { useAttachmentDropTarget } from "@/features/chat/hooks/useAttachmentDropTarget";
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
  /**
   * A file already validated and read by another import surface (the gallery
   * drop zone). The dialog prepares it through the same flow as picker files
   * so every entry point shares one preview/confirmation owner.
   */
  initialFile?: { bytes: Uint8Array; name: string } | null;
  onImportFile: (
    fileBytes: Uint8Array,
    fileName: string,
    preview?: AgentImportPreview,
  ) => void;
  prepareImport: (
    fileBytes: Uint8Array,
    fileName: string,
    signal: AbortSignal,
  ) =>
    | AgentImportPreview
    | Promise<{
        bytes: Uint8Array;
        name: string;
        preview: AgentImportPreview;
      }>;
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
  initialFile,
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
  const preparationRef = useRef<AbortController | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<{
    bytes: Uint8Array;
    name: string;
    preview: AgentImportPreview;
  } | null>(null);

  useEffect(() => {
    if (!open) {
      preparationRef.current?.abort();
      setPrepared(null);
    }
  }, [open]);

  useEffect(
    () => () => {
      preparationRef.current?.abort();
    },
    [],
  );

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

  const startPreparation = useCallback(
    (bytes: Uint8Array, name: string): AbortController => {
      preparationRef.current?.abort();
      const controller = new AbortController();
      preparationRef.current = controller;
      setPreparing(true);
      void (async () => {
        try {
          const result = await prepareImport(bytes, name, controller.signal);
          if (controller.signal.aborted) {
            // A discarded result never reaches prepared state, so the cleanup
            // effect will not revoke its preview URL; dispose of it here.
            const staleUrl = ("preview" in result ? result.preview : result)
              .cardImageUrl;
            if (staleUrl) URL.revokeObjectURL(staleUrl);
            return;
          }
          // The cleanup effect keyed by cardImageUrl revokes the previous URL
          // exactly once when this prepared preview replaces it.
          setPrepared(
            "preview" in result ? result : { bytes, name, preview: result },
          );
        } catch (error) {
          if (!controller.signal.aborted) {
            onImportError(
              error instanceof Error ? error.message : String(error),
            );
          }
        } finally {
          if (preparationRef.current === controller) {
            preparationRef.current = null;
            setPreparing(false);
          }
        }
      })();
      return controller;
    },
    [onImportError, prepareImport],
  );

  const consumedInitialFileRef = useRef<typeof initialFile>(null);
  useEffect(() => {
    if (!open) {
      consumedInitialFileRef.current = null;
      return;
    }
    if (!initialFile || consumedInitialFileRef.current === initialFile) {
      return;
    }
    consumedInitialFileRef.current = initialFile;
    const controller = startPreparation(initialFile.bytes, initialFile.name);
    return () => {
      // Lifecycle cleanup (StrictMode replay, unmount) aborts this attempt.
      // If it is still the active preparation, un-consume the file so a
      // replayed effect can restart it; a picker selection that replaced
      // this attempt keeps ownership and the marker stays consumed.
      if (preparationRef.current === controller) {
        controller.abort();
        preparationRef.current = null;
        setPreparing(false);
        consumedInitialFileRef.current = null;
      }
    };
  }, [open, initialFile, startPreparation]);

  const dropZoneRef = useRef<HTMLDivElement>(null);
  const nativeDropGenerationRef = useRef(0);
  const nativeDropActiveRef = useRef(false);
  useEffect(() => {
    nativeDropActiveRef.current = open;
    if (!open) nativeDropGenerationRef.current += 1;
    return () => {
      nativeDropActiveRef.current = false;
      nativeDropGenerationRef.current += 1;
    };
  }, [open]);
  const validateReplacementFile = useCallback(
    (file: Pick<File, "name" | "type" | "size">) => {
      nativeDropGenerationRef.current += 1;
      preparationRef.current?.abort();
      setPrepared(null);
      return validateImportFile(file);
    },
    [validateImportFile],
  );
  const {
    fileInputRef,
    isDragOver,
    importFile,
    invalidateImport,
    handleFileChange,
    openFilePicker,
  } = useFileImportZone({
    onImportFile: startPreparation,
    validateFile: validateReplacementFile,
    onImportError,
    maxBytes: maxImportBytes,
    fileTooLargeMessage: importTooLargeMessage,
  });

  const handleDroppedPaths = useCallback(
    (paths: string[]) => {
      const path = paths[0];
      if (!path) return;
      invalidateImport();
      const generation = ++nativeDropGenerationRef.current;
      void readImportAgentFile(path)
        .then(({ fileBytes, fileName }) => {
          if (
            !nativeDropActiveRef.current ||
            generation !== nativeDropGenerationRef.current
          )
            return;
          const bytes = Uint8Array.from(fileBytes);
          const file = new File([bytes], fileName);
          const error = validateReplacementFile(file);
          if (error) {
            onImportError(error);
            return;
          }
          startPreparation(bytes, fileName);
        })
        .catch((error) => {
          if (
            nativeDropActiveRef.current &&
            generation === nativeDropGenerationRef.current
          )
            onImportError(
              error instanceof Error ? error.message : String(error),
            );
        });
    },
    [
      invalidateImport,
      onImportError,
      startPreparation,
      validateReplacementFile,
    ],
  );
  const {
    isAttachmentDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useAttachmentDropTarget({
    disabled: !open,
    targetRef: dropZoneRef,
    onDropFiles: (files) => {
      const file = files[0];
      if (file) void importFile(file);
    },
    onDropPaths: handleDroppedPaths,
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
                    description={
                      prepared.preview.description ??
                      t("importDialog.descriptionFallback", {
                        name: prepared.preview.displayName,
                      })
                    }
                    avatarSrc={prepared.preview.avatar}
                    alt={t("importDialog.previewAlt", {
                      name: prepared.preview.displayName,
                    })}
                    locale={locale}
                  />
                )}
              </AgentCardReveal>
            </div>
          ) : (
            <div
              ref={dropZoneRef}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              role="status"
              aria-busy={preparing}
              className={cn(
                "flex min-h-56 flex-col items-center justify-center gap-4 rounded-md border border-dashed border-border bg-muted/40 px-6 text-center",
                (isDragOver || isAttachmentDragOver) &&
                  "border-ring bg-muted/70",
              )}
            >
              <p className="text-sm">
                {preparing
                  ? t("importDialog.preparing")
                  : t("importDialog.dropTitle")}
              </p>
              <Button
                type="button"
                variant="outline"
                feedbackState={preparing ? "loading" : "idle"}
                loadingLabel={t("importDialog.preparing")}
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
