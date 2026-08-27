import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import { SettingsRow } from "@/shared/ui/settings-row";

export function VoicePickerDialog({
  selectedVoice,
  dialogError,
  children,
}: {
  selectedVoice: string | null;
  dialogError?: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [open, setOpen] = useState(false);
  const selectedVoiceId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const visibleVoice = selectedVoice ?? t("voice.chooseVoice");

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector<HTMLElement>('[data-voice-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <SettingsRow
        label={t("voice.voice")}
        density="compact"
        action={() => (
          <DialogTrigger asChild>
            <Button
              type="button"
              size="compact"
              variant="ghost"
              flush
              aria-label={t("voice.chooseVoiceLabel", {
                voice: visibleVoice,
              })}
              aria-describedby={selectedVoiceId}
            >
              <span className="max-w-48 truncate">{visibleVoice}</span>
              <span id={selectedVoiceId} className="sr-only">
                {selectedVoice ?? t("voice.noVoiceSelected")}
              </span>
              <ChevronRight aria-hidden="true" />
            </Button>
          </DialogTrigger>
        )}
      />
      <DialogContent
        ref={contentRef}
        size="lg"
        aria-describedby={undefined}
        closeLabel={t("actions.close", { ns: "common" })}
      >
        <DialogHeader>
          <DialogTitle>{t("voice.chooseVoiceTitle")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {dialogError ? (
            <p className="text-sm text-destructive" role="alert">
              {dialogError}
            </p>
          ) : null}
          {children}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
