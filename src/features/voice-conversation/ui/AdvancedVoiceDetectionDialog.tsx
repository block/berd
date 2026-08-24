import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import type { VoiceInputBackend } from "../lib/voiceInputPreference";
import type { VoiceInterruptionSensitivity } from "../lib/voiceInterruptionPreference";
import { useVoiceInterruptionPreference } from "../lib/voiceInterruptionPreference";

const SENSITIVITIES: VoiceInterruptionSensitivity[] = [
  "less",
  "balanced",
  "more",
];

interface AdvancedVoiceDetectionDialogProps {
  inputBackend: VoiceInputBackend;
}

export function AdvancedVoiceDetectionDialog({
  inputBackend,
}: AdvancedVoiceDetectionDialogProps) {
  const { t } = useTranslation("settings");
  const interruption = useVoiceInterruptionPreference();
  const speechHeadingId = useId();
  const speechDescriptionId = useId();
  const interruptionHeadingId = useId();
  const interruptionDescriptionId = useId();

  const reset = () => interruption.resetSensitivities();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          {t("voice.advancedDetection.open")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("voice.advancedDetection.title")}</DialogTitle>
          <DialogDescription>
            {t("voice.advancedDetection.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {inputBackend === "parakeet" ? (
            <div className="space-y-2">
              <div>
                <h3 id={speechHeadingId} className="text-sm font-medium">
                  {t("voice.advancedDetection.speechSensitivity")}
                </h3>
                <p
                  id={speechDescriptionId}
                  className="mt-0.5 text-xs text-muted-foreground"
                >
                  {t("voice.advancedDetection.speechSensitivityDescription")}
                </p>
              </div>
              <Select
                value={interruption.speechSensitivity}
                onValueChange={(value) =>
                  interruption.setSpeechSensitivity(
                    value as VoiceInterruptionSensitivity,
                  )
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-labelledby={speechHeadingId}
                  aria-describedby={speechDescriptionId}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SENSITIVITIES.map((sensitivity) => (
                    <SelectItem key={sensitivity} value={sensitivity}>
                      {t(
                        `voice.advancedDetection.sensitivityOptions.${sensitivity}`,
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {interruption.mode !== "preventFeedback" ? (
            <div className="space-y-2">
              <div>
                <h3 id={interruptionHeadingId} className="text-sm font-medium">
                  {t("voice.advancedDetection.interruptionSensitivity")}
                </h3>
                <p
                  id={interruptionDescriptionId}
                  className="mt-0.5 text-xs text-muted-foreground"
                >
                  {t(
                    "voice.advancedDetection.interruptionSensitivityDescription",
                  )}
                </p>
              </div>
              <Select
                value={interruption.sensitivity}
                onValueChange={(value) =>
                  interruption.setSensitivity(
                    value as VoiceInterruptionSensitivity,
                  )
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-labelledby={interruptionHeadingId}
                  aria-describedby={interruptionDescriptionId}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SENSITIVITIES.map((sensitivity) => (
                    <SelectItem key={sensitivity} value={sensitivity}>
                      {t(
                        `voice.advancedDetection.sensitivityOptions.${sensitivity}`,
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={reset}>
            {t("voice.advancedDetection.reset")}
          </Button>
          <DialogClose asChild>
            <Button type="button">{t("voice.advancedDetection.done")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
