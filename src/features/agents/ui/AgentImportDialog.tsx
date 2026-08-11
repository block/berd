import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconPhotoPlus, IconUpload } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { PersonaImportPreview } from "@/shared/api/agents";
import type { SnapshotV1 } from "@/features/agents/agent-snapshot";
import { AgentShareCardPreview } from "@/features/agents/ui/share-card/AgentShareCardPreview";
import {
  HolographicAgentCard,
  holographicCardPresets,
} from "@/features/agents/ui/share-card/HolographicAgentCard";

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
  snapshot?: SnapshotV1;
}

const REFRACTION_LOBES = [
  {
    x: -18,
    y: -10,
    rotate: -12,
    scaleX: 1.15,
    scaleY: 0.72,
    delay: 0,
    color: "rgba(100, 220, 255, 0.52)",
  },
  {
    x: 20,
    y: 4,
    rotate: 24,
    scaleX: 0.82,
    scaleY: 1.08,
    delay: 0.05,
    color: "rgba(239, 112, 255, 0.4)",
  },
  {
    x: -2,
    y: 18,
    rotate: 8,
    scaleX: 1.02,
    scaleY: 0.76,
    delay: 0.1,
    color: "rgba(255, 218, 92, 0.34)",
  },
] as const;

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
  const { t } = useTranslation("agents");
  const shouldReduceMotion = useReducedMotion();
  const cardRef = useRef<HTMLDivElement>(null);
  const [refractionOrigin, setRefractionOrigin] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [prepared, setPrepared] = useState<{
    bytes: Uint8Array;
    name: string;
    preview: AgentImportPreview;
  } | null>(null);

  useEffect(() => {
    if (!open) setPrepared(null);
  }, [open]);

  useEffect(
    () => () => {
      if (prepared?.preview.cardImageUrl) {
        URL.revokeObjectURL(prepared.preview.cardImageUrl);
      }
    },
    [prepared?.preview.cardImageUrl],
  );

  useLayoutEffect(() => {
    if (!prepared) return;
    const bounds = cardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setRefractionOrigin({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
  }, [prepared]);

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
      <DialogContent size="md" surface="solid" className="bg-card">
        <DialogHeader>
          <DialogTitle>{t("importDialog.title")}</DialogTitle>
          <DialogDescription>{t("importDialog.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {prepared ? (
            <div className="relative mx-auto w-full max-w-[18rem] py-6 [perspective:1200px]">
              <motion.div
                ref={cardRef}
                key={prepared.name}
                initial={
                  shouldReduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, rotateY: -105, scale: 0.86 }
                }
                animate={{ opacity: 1, rotateY: 0, scale: 1 }}
                transition={
                  shouldReduceMotion
                    ? { duration: 0 }
                    : { duration: 0.45, ease: [0.22, 1, 0.36, 1] }
                }
                className="relative [transform-style:preserve-3d]"
              >
                {prepared.preview.cardImageUrl ? (
                  <HolographicAgentCard
                    src={prepared.preview.cardImageUrl}
                    settings={holographicCardPresets.rainbowPrism}
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
                  />
                )}
              </motion.div>
              {!shouldReduceMotion &&
                refractionOrigin &&
                createPortal(
                  <div
                    aria-hidden="true"
                    className="pointer-events-none fixed inset-0 z-[100]"
                    style={{
                      WebkitMaskImage: `radial-gradient(ellipse 154px 211px at ${refractionOrigin.x}px ${refractionOrigin.y}px, transparent 0%, transparent 94%, black 100%)`,
                      maskImage: `radial-gradient(ellipse 154px 211px at ${refractionOrigin.x}px ${refractionOrigin.y}px, transparent 0%, transparent 94%, black 100%)`,
                    }}
                  >
                    {REFRACTION_LOBES.map((lobe, index) => {
                      const duration = 1.4;
                      const delay = 0;
                      const ease = [0.65, 0, 0.35, 1] as const;

                      return (
                        <motion.div
                          key={`${lobe.x}:${lobe.y}`}
                          onAnimationComplete={() => {
                            if (index === REFRACTION_LOBES.length - 1) {
                              setRefractionOrigin(null);
                            }
                          }}
                          initial={{
                            opacity: 0,
                            x: lobe.x * 0.3,
                            y: lobe.y * 0.3,
                            scaleX: lobe.scaleX * 0.78,
                            scaleY: lobe.scaleY * 0.78,
                            rotate: lobe.rotate - 5,
                          }}
                          animate={{
                            opacity: [0, 0.58, 0.34, 0],
                            x: [lobe.x * 0.3, lobe.x],
                            y: [lobe.y * 0.3, lobe.y],
                            scaleX: [lobe.scaleX * 0.78, lobe.scaleX],
                            scaleY: [lobe.scaleY * 0.78, lobe.scaleY],
                            rotate: [lobe.rotate - 5, lobe.rotate + 4],
                          }}
                          transition={{
                            default: { duration, delay, ease },
                            opacity: {
                              duration,
                              delay,
                              times: [0, 0.16, 0.48, 1],
                              ease: [0.45, 0, 0.55, 1],
                            },
                          }}
                          className="absolute size-[42vmax] -translate-x-1/2 -translate-y-1/2 rounded-[44%] blur-xl"
                          style={{
                            left: refractionOrigin.x,
                            top: refractionOrigin.y,
                            background: `radial-gradient(ellipse, ${lobe.color} 0%, ${lobe.color} 24%, transparent 72%)`,
                            boxShadow: `0 0 150px 85px ${lobe.color}`,
                          }}
                        />
                      );
                    })}
                  </div>,
                  document.body,
                )}
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
            accept=".agent.png,.png,.persona.md,.md,.json,image/png,text/markdown,text/plain,application/json"
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
