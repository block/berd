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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <SettingsRow
        label={t("voice.voice")}
        description={selectedVoice ?? t("voice.noVoiceSelected")}
        density="compact"
        action={({ descriptionId }) => (
          <DialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t("voice.chooseVoiceTitle")}
              aria-describedby={descriptionId}
            >
              {t("voice.chooseVoice")}
            </Button>
          </DialogTrigger>
        )}
      />
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
