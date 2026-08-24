import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { SettingsRow } from "@/shared/ui/settings-row";

export function VoicePickerDialog({
  selectedVoice,
  error,
  children,
}: {
  selectedVoice: string | null;
  error?: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [open, setOpen] = useState(false);

  return (
    <>
      <SettingsRow
        label={t("voice.voice")}
        description={selectedVoice ?? t("voice.noVoiceSelected")}
        density="compact"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setOpen(true)}
          >
            {t("voice.chooseVoice")}
          </Button>
        }
        details={
          error && !open ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : undefined
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          size="lg"
          closeLabel={t("actions.close", { ns: "common" })}
        >
          <DialogHeader>
            <DialogTitle>{t("voice.chooseVoiceTitle")}</DialogTitle>
            <DialogDescription>
              {t("voice.chooseVoiceDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            {children}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
