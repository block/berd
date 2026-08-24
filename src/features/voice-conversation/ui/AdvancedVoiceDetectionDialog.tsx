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
import type {
  EndOfSpeechPause,
  VoiceDetectionSensitivity,
} from "../lib/voiceDetectionPreference";
import { useVoiceDetectionPreference } from "../lib/voiceDetectionPreference";
import type { VoiceInterruptionSensitivity } from "../lib/voiceInterruptionPreference";

const SENSITIVITIES: VoiceDetectionSensitivity[] = ["less", "balanced", "more"];
const PAUSES: EndOfSpeechPause[] = ["short", "standard", "long"];

interface AdvancedVoiceDetectionDialogProps {
  interruptionSensitivity: VoiceInterruptionSensitivity;
  setInterruptionSensitivity: (
    sensitivity: VoiceInterruptionSensitivity,
  ) => void;
}

export function AdvancedVoiceDetectionDialog({
  interruptionSensitivity,
  setInterruptionSensitivity,
}: AdvancedVoiceDetectionDialogProps) {
  const { t } = useTranslation("settings");
  const detection = useVoiceDetectionPreference();
  const speechHeadingId = useId();
  const speechDescriptionId = useId();
  const interruptionHeadingId = useId();
  const interruptionDescriptionId = useId();
  const pauseHeadingId = useId();
  const pauseDescriptionId = useId();

  const reset = () => {
    detection.reset();
    setInterruptionSensitivity("balanced");
  };

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
              value={detection.speechSensitivity}
              onValueChange={(value) =>
                detection.setSpeechSensitivity(
                  value as VoiceDetectionSensitivity,
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
              value={interruptionSensitivity}
              onValueChange={(value) =>
                setInterruptionSensitivity(
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

          <div className="space-y-2">
            <div>
              <h3 id={pauseHeadingId} className="text-sm font-medium">
                {t("voice.advancedDetection.endOfSpeechPause")}
              </h3>
              <p
                id={pauseDescriptionId}
                className="mt-0.5 text-xs text-muted-foreground"
              >
                {t("voice.advancedDetection.endOfSpeechPauseDescription")}
              </p>
            </div>
            <Select
              value={detection.endOfSpeechPause}
              onValueChange={(value) =>
                detection.setEndOfSpeechPause(value as EndOfSpeechPause)
              }
            >
              <SelectTrigger
                className="w-full"
                aria-labelledby={pauseHeadingId}
                aria-describedby={pauseDescriptionId}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAUSES.map((pause) => (
                  <SelectItem key={pause} value={pause}>
                    {t(`voice.advancedDetection.pauseOptions.${pause}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
